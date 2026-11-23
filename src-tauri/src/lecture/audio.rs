//! 听课的声音处理：麦克风 → 统一采样率 →（降噪）→ 16 kHz → 判断有没有人说话 → 按停顿切段。
//!
//! - 重采样：窗函数 sinc 插值，麦克风是 44.1 kHz 还是 48 kHz 都能准确换算，高频不会折叠回来变成杂音
//! - 降噪：nnnoiseless（RNNoise 的 Rust 版），只认 48 kHz，所以先换到 48 kHz 降噪、再换到 16 kHz
//! - 有没有人说话：earshot，每 16 毫秒打一个 0～1 的分；比只看声音大小准，风扇、关门不会当成说话
//! 声音从哪来（麦克风、电脑播放的声音）在 source.rs。
//! - 切段：攒到 4 秒以上又停顿了 0.5 秒就切；一直不停，到 15 秒在最近 3 秒里最像停顿的地方切，
//!   这种硬切的段，下一段开头带上前一段最后 1 秒，免得切在词中间（拼接时按词去掉重复）

/// 送去听写的采样率
pub const RATE: u32 = 16_000;
/// 降噪要求的采样率
pub const DENOISE_RATE: u32 = 48_000;
/// earshot 一次看 16 毫秒
const VAD_FRAME: usize = 256;
/// 音量带 0.1 秒一格
const LEVEL_FRAME: usize = (RATE / 10) as usize;

/// 每秒多少个 16 毫秒
const fn frames(ms: usize) -> usize {
    ms * RATE as usize / 1000 / VAD_FRAME
}
/// 开始说话前留多少
const PREROLL: usize = frames(300);

/// 多长切一段
#[derive(Clone, Copy)]
pub struct Limits {
    /// 短于这个的段不切
    min_len: usize,
    /// 停顿多久算一句说完
    pause: usize,
    /// 一直不停最多攒多久
    max_len: usize,
    /// 硬切时往回找停顿的范围
    search: usize,
}

/// 边听边翻：段短一点，出字快
pub const LIVE: Limits = Limits {
    min_len: frames(4_000),
    pause: frames(500),
    max_len: frames(15_000),
    search: frames(3_000),
};

/// 边听边翻、用 Groq 的 Whisper 听写时：它一次请求最少按 10 秒算，段切长一点；
/// Whisper 听长一点的段也更准。出字会晚两三秒
pub const LIVE_LONG: Limits = Limits {
    min_len: frames(8_000),
    pause: frames(500),
    max_len: frames(20_000),
    search: frames(4_000),
};

/// 课后用录音重新听写：段长一点，听写的上下文多、更准
pub const REDO: Limits = Limits {
    min_len: frames(20_000),
    pause: frames(600),
    max_len: frames(60_000),
    search: frames(10_000),
};
/// 硬切时下一段带上的重叠（采样数，约 1 秒，正好是整数个 16 毫秒）
pub const OVERLAP: usize = 63 * VAD_FRAME;
/// 说话少于这个的段不送（0.4 秒）
const MIN_SPEECH: usize = frames(400);
/// 平滑后的分数超过它算开始说话、低于 DECAY 算停
const ATTACK: f32 = 0.6;
const DECAY: f32 = 0.35;
/// 说话时的音量低于这个（约 -40 dBFS）就提示声音太小
const QUIET_RMS: f32 = 0.01;

// ---------- 重采样 ----------

const HALF: usize = 16;
const TAPS: usize = HALF * 2;
const PHASES: usize = 256;

/// 窗函数 sinc 插值重采样。系数表预先算好（256 个相位 × 32 个点），每个输出样本 32 次乘加
pub struct Resampler {
    /// 输入采样率 / 输出采样率
    step: f64,
    /// 下一个输出样本落在 buf 的哪个位置
    pos: f64,
    buf: Vec<f32>,
    table: Vec<f32>,
    same: bool,
}

impl Resampler {
    pub fn new(from: u32, to: u32) -> Self {
        let step = from as f64 / to as f64;
        // 降采样时低通到新采样率一半以下，留一点余量
        let cutoff = if step > 1.0 { 1.0 / step } else { 1.0 } * 0.92;
        let pi = std::f64::consts::PI;
        let mut table = vec![0f32; PHASES * TAPS];
        for p in 0..PHASES {
            let frac = p as f64 / PHASES as f64;
            let mut row = [0f64; TAPS];
            let mut sum = 0.0;
            for (k, v) in row.iter_mut().enumerate() {
                let x = k as f64 - (HALF as f64 - 1.0) - frac;
                let sinc = if x.abs() < 1e-9 {
                    cutoff
                } else {
                    (pi * cutoff * x).sin() / (pi * x)
                };
                let t = pi * x / HALF as f64;
                let window = 0.42 + 0.5 * t.cos() + 0.08 * (2.0 * t).cos();
                *v = sinc * window;
                sum += *v;
            }
            for (k, v) in row.iter().enumerate() {
                table[p * TAPS + k] = (v / sum) as f32;
            }
        }
        Self {
            step,
            pos: (HALF - 1) as f64,
            buf: Vec::new(),
            table,
            same: from == to,
        }
    }

    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.same {
            out.extend_from_slice(input);
            return;
        }
        self.buf.extend_from_slice(input);
        loop {
            let i = self.pos as usize;
            if i + HALF + 1 > self.buf.len() {
                break;
            }
            let p = (((self.pos - i as f64) * PHASES as f64) as usize).min(PHASES - 1);
            let coeffs = &self.table[p * TAPS..(p + 1) * TAPS];
            let window = &self.buf[i + 1 - HALF..i + 1 + HALF];
            out.push(window.iter().zip(coeffs).map(|(a, b)| a * b).sum());
            self.pos += self.step;
        }
        // 用过的扔掉，留够下一次插值要回看的
        let used = (self.pos as usize).saturating_sub(HALF - 1);
        if used > 0 {
            self.buf.drain(..used.min(self.buf.len()));
            self.pos -= used as f64;
        }
    }
}

// ---------- 降噪 ----------

/// nnnoiseless：48 kHz，一次 480 个样本（10 毫秒），数值按 16 位整数的范围
pub struct Denoiser {
    state: Box<nnnoiseless::DenoiseState<'static>>,
    pending: Vec<f32>,
    frame_in: Vec<f32>,
    frame_out: Vec<f32>,
    first: bool,
}

impl Denoiser {
    pub fn new() -> Self {
        let size = nnnoiseless::DenoiseState::FRAME_SIZE;
        Self {
            state: nnnoiseless::DenoiseState::new(),
            pending: Vec::new(),
            frame_in: vec![0.0; size],
            frame_out: vec![0.0; size],
            first: true,
        }
    }

    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        let size = nnnoiseless::DenoiseState::FRAME_SIZE;
        self.pending.extend_from_slice(input);
        let mut done = 0;
        while self.pending.len() - done >= size {
            for (dst, src) in self
                .frame_in
                .iter_mut()
                .zip(&self.pending[done..done + size])
            {
                *dst = src * 32768.0;
            }
            self.state
                .process_frame(&mut self.frame_out, &self.frame_in);
            if self.first {
                // 第一帧有淡入的杂音，换成静音，长度不变
                self.first = false;
                out.extend(std::iter::repeat_n(0.0, size));
            } else {
                out.extend(
                    self.frame_out
                        .iter()
                        .map(|v| (v / 32768.0).clamp(-1.0, 1.0)),
                );
            }
            done += size;
        }
        self.pending.drain(..done);
    }
}

// ---------- 有没有人说话 ----------

/// 给一帧 16 毫秒（256 个样本，16 kHz）打分：0 没人说话，1 肯定有人说话
pub trait Vad: Send {
    fn score(&mut self, frame: &[f32]) -> f32;
}

impl Vad for earshot::Detector {
    // 新版 earshot 把它标成了旧写法（换成 predict），但 crates.io 上的版本只有这个
    #[allow(deprecated)]
    fn score(&mut self, frame: &[f32]) -> f32 {
        self.predict_f32(frame)
    }
}

pub fn detector() -> Box<dyn Vad> {
    Box::new(earshot::Detector::default())
}

// ---------- 切段 ----------

/// 切好的一段
pub struct Chunk {
    /// 这一段（不算开头重叠的部分）开始的时刻
    pub at: u64,
    /// 16 kHz 单声道
    pub samples: Vec<f32>,
    /// 开头有多少个样本是和上一段重叠的
    pub overlap: usize,
    /// 说话的部分声音太小
    pub quiet: bool,
}

pub struct Cutter {
    vad: Box<dyn Vad>,
    limits: Limits,
    frame: Vec<f32>,
    level_sum: f32,
    level_n: usize,
    buf: Vec<f32>,
    /// buf 第一个样本的时刻
    buf_at: u64,
    /// buf 里每一帧平滑后的分数
    scores: Vec<f32>,
    /// buf 开头有多少是重叠
    overlap: usize,
    smooth: f32,
    speaking: bool,
    speech: usize,
    silence: usize,
    speech_energy: f32,
}

impl Cutter {
    #[cfg(test)]
    pub fn new(vad: Box<dyn Vad>) -> Self {
        Self::with_limits(vad, LIVE)
    }

    pub fn with_limits(vad: Box<dyn Vad>, limits: Limits) -> Self {
        Self {
            vad,
            limits,
            frame: Vec::with_capacity(VAD_FRAME),
            level_sum: 0.0,
            level_n: 0,
            buf: Vec::new(),
            buf_at: 0,
            scores: Vec::new(),
            overlap: 0,
            smooth: 0.0,
            speaking: false,
            speech: 0,
            silence: 0,
            speech_energy: 0.0,
        }
    }

    /// 喂一块 16 kHz 的声音，`now` 是这一块最后一个样本的时刻。
    /// 每 0.1 秒调一次 on_level（0～1），切出一段调一次 on_chunk
    pub fn push(
        &mut self,
        input: &[f32],
        now: u64,
        on_level: &mut impl FnMut(f32),
        on_chunk: &mut impl FnMut(Chunk),
    ) {
        for (i, &x) in input.iter().enumerate() {
            self.level_sum += x * x;
            self.level_n += 1;
            if self.level_n == LEVEL_FRAME {
                let rms = (self.level_sum / LEVEL_FRAME as f32).sqrt();
                let db = 20.0 * (rms + 1e-9).log10();
                on_level(((db + 55.0) / 45.0).clamp(0.0, 1.0));
                self.level_sum = 0.0;
                self.level_n = 0;
            }
            self.frame.push(x);
            if self.frame.len() == VAD_FRAME {
                // 这一帧最后一个样本的时刻
                let end = now.saturating_sub(((input.len() - 1 - i) as u64) * 1000 / RATE as u64);
                let frame = std::mem::replace(&mut self.frame, Vec::with_capacity(VAD_FRAME));
                self.on_frame(frame, end, on_chunk);
            }
        }
    }

    fn on_frame(&mut self, frame: Vec<f32>, end: u64, on_chunk: &mut impl FnMut(Chunk)) {
        let score = self.vad.score(&frame);
        self.smooth = self.smooth * 0.6 + score * 0.4;
        self.speaking = if self.speaking {
            self.smooth >= DECAY
        } else {
            self.smooth >= ATTACK
        };

        if self.buf.is_empty() {
            self.buf_at = end.saturating_sub(16);
        }
        let energy = frame.iter().map(|v| v * v).sum::<f32>() / VAD_FRAME as f32;
        self.buf.extend_from_slice(&frame);
        self.scores.push(self.smooth);
        if self.speaking {
            self.speech += 1;
            self.silence = 0;
            self.speech_energy += energy;
        } else {
            self.silence += 1;
        }

        // 还没人说话：只留最后 0.3 秒当开头
        if self.speech == 0 && self.overlap == 0 && self.scores.len() > PREROLL * 2 {
            let drop = self.scores.len() - PREROLL;
            self.buf.drain(..drop * VAD_FRAME);
            self.scores.drain(..drop);
            self.buf_at += (drop * VAD_FRAME) as u64 * 1000 / RATE as u64;
            return;
        }
        let len = self.scores.len();
        if self.speech > 0 && len >= self.limits.min_len && self.silence >= self.limits.pause {
            self.cut(on_chunk);
        } else if len >= self.limits.max_len {
            self.cut_hard(on_chunk);
        }
    }

    fn make_chunk(&self, samples: Vec<f32>) -> Chunk {
        let quiet = self.speech > 0 && (self.speech_energy / self.speech as f32).sqrt() < QUIET_RMS;
        Chunk {
            at: self.buf_at + (self.overlap as u64) * 1000 / RATE as u64,
            samples,
            overlap: self.overlap,
            quiet,
        }
    }

    fn reset_counts(&mut self) {
        self.speech = 0;
        self.silence = 0;
        self.speech_energy = 0.0;
        self.overlap = 0;
    }

    /// 在停顿处切：整段送走，从头再来。暂停、下课时也调
    pub fn cut(&mut self, on_chunk: &mut impl FnMut(Chunk)) {
        let samples = std::mem::take(&mut self.buf);
        if self.speech >= MIN_SPEECH {
            on_chunk(self.make_chunk(samples));
        }
        self.scores.clear();
        self.reset_counts();
    }

    /// 一直没停：在最近 3 秒里分数最低（最像停顿）的地方切，下一段带上 1 秒重叠
    fn cut_hard(&mut self, on_chunk: &mut impl FnMut(Chunk)) {
        let len = self.scores.len();
        let from = len.saturating_sub(self.limits.search).max(len / 2);
        let mut at = len;
        let mut lowest = f32::MAX;
        for i in from..len {
            if self.scores[i] < lowest {
                lowest = self.scores[i];
                at = i;
            }
        }
        // 切在这一帧后面
        let cut = (at + 1).min(len) * VAD_FRAME;
        let head: Vec<f32> = self.buf[..cut].to_vec();
        if self.speech >= MIN_SPEECH {
            on_chunk(self.make_chunk(head));
        }
        // 下一段：重叠的 1 秒 + 切点后面剩下的
        let keep_from = cut.saturating_sub(OVERLAP);
        let overlap = cut - keep_from;
        self.buf_at += (keep_from as u64) * 1000 / RATE as u64;
        self.buf.drain(..keep_from);
        self.scores.drain(..keep_from / VAD_FRAME);
        self.reset_counts();
        self.overlap = overlap;
        // 剩下的部分重新数一遍说话、停顿
        for (i, &s) in self.scores.iter().enumerate() {
            if s >= DECAY {
                self.speech += 1;
                self.silence = 0;
                let frame = &self.buf[i * VAD_FRAME..(i + 1) * VAD_FRAME];
                self.speech_energy += frame.iter().map(|v| v * v).sum::<f32>() / VAD_FRAME as f32;
            } else {
                self.silence += 1;
            }
        }
    }
}

// ---------- WAV ----------

/// 16 位、16 kHz、单声道 WAV
pub fn wav(samples: &[f32]) -> Vec<u8> {
    let data = samples.len() * 2;
    let mut out = Vec::with_capacity(44 + data);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data as u32).to_le_bytes());
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// 麦克风之后的整条处理：任意采样率 →（48 kHz 降噪）→ 16 kHz
pub struct Pipeline {
    first: Resampler,
    denoise: Option<(Denoiser, Resampler)>,
    tmp: Vec<f32>,
    tmp2: Vec<f32>,
}

impl Pipeline {
    pub fn new(input_rate: u32, denoise: bool) -> Self {
        if denoise {
            Self {
                first: Resampler::new(input_rate, DENOISE_RATE),
                denoise: Some((Denoiser::new(), Resampler::new(DENOISE_RATE, RATE))),
                tmp: Vec::new(),
                tmp2: Vec::new(),
            }
        } else {
            Self {
                first: Resampler::new(input_rate, RATE),
                denoise: None,
                tmp: Vec::new(),
                tmp2: Vec::new(),
            }
        }
    }

    /// 处理一块，结果（16 kHz）追加到 out
    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        match &mut self.denoise {
            None => self.first.push(input, out),
            Some((denoiser, down)) => {
                self.tmp.clear();
                self.first.push(input, &mut self.tmp);
                self.tmp2.clear();
                denoiser.push(&self.tmp, &mut self.tmp2);
                down.push(&self.tmp2, out);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, rate: u32, secs: f32) -> Vec<f32> {
        (0..(rate as f32 * secs) as usize)
            .map(|i| (i as f32 * freq * std::f32::consts::TAU / rate as f32).sin() * 0.5)
            .collect()
    }

    fn rms(v: &[f32]) -> f32 {
        (v.iter().map(|x| x * x).sum::<f32>() / v.len() as f32).sqrt()
    }

    #[test]
    fn resample_keeps_speech_band() {
        // 1 kHz 在 44.1 kHz → 16 kHz 后还是 1 kHz、音量不变
        let mut r = Resampler::new(44_100, 16_000);
        let mut out = Vec::new();
        for block in sine(1000.0, 44_100, 1.0).chunks(441) {
            r.push(block, &mut out);
        }
        assert!((out.len() as i64 - 16_000).abs() < 40, "{}", out.len());
        let mid = &out[2000..14000];
        assert!((rms(mid) - 0.5 / 2f32.sqrt()).abs() < 0.01, "{}", rms(mid));
        // 过零次数 ≈ 2 × 1000 × 0.75 秒
        let zero = mid.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        assert!((zero as i64 - 750).abs() <= 2, "{zero}");
    }

    #[test]
    fn resample_removes_aliasing() {
        // 48 kHz 里 12 kHz 的声音换到 16 kHz 应该几乎没了（不然会折叠成 4 kHz 的杂音）
        let mut r = Resampler::new(48_000, 16_000);
        let mut out = Vec::new();
        r.push(&sine(12_000.0, 48_000, 1.0), &mut out);
        assert!(rms(&out[1000..15000]) < 0.01, "{}", rms(&out[1000..15000]));
    }

    #[test]
    fn resample_up() {
        let mut r = Resampler::new(16_000, 48_000);
        let mut out = Vec::new();
        r.push(&sine(500.0, 16_000, 0.5), &mut out);
        // 末尾要等后面的样本才能插值，会少几十个
        assert!((out.len() as i64 - 24_000).abs() < 150, "{}", out.len());
        assert!((rms(&out[3000..20000]) - 0.5 / 2f32.sqrt()).abs() < 0.01);
    }

    #[test]
    fn wav_header() {
        let w = wav(&[0.0; 160]);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(w.len(), 44 + 320);
    }

    /// 测试用的"说话检测"：声音大于 0.05 就算说话
    struct Loud;
    impl Vad for Loud {
        fn score(&mut self, frame: &[f32]) -> f32 {
            if rms(frame) > 0.05 {
                1.0
            } else {
                0.0
            }
        }
    }

    fn run(cutter: &mut Cutter, audio: &[f32]) -> Vec<Chunk> {
        let mut chunks = Vec::new();
        let mut levels = 0;
        let mut t = 1_000_000u64;
        for block in audio.chunks(160) {
            t += 10;
            cutter.push(block, t, &mut |_| levels += 1, &mut |c| chunks.push(c));
        }
        chunks
    }

    #[test]
    fn cuts_at_pause() {
        let mut cutter = Cutter::new(Box::new(Loud));
        let mut audio = vec![0.0; 16_000];
        audio.extend(sine(300.0, 16_000, 5.0));
        audio.extend(vec![0.0; 16_000]);
        let chunks = run(&mut cutter, &audio);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].overlap, 0);
        // 前面留了 0.3 秒左右，后面到停顿 0.5 秒为止
        let secs = chunks[0].samples.len() as f32 / 16_000.0;
        assert!((5.5..6.2).contains(&secs), "{secs}");
        assert!(!chunks[0].quiet);
    }

    #[test]
    fn long_speech_is_cut_with_overlap() {
        let mut cutter = Cutter::new(Box::new(Loud));
        // 40 秒不停，中间第 12 秒有一下很短的低谷
        let mut audio = sine(300.0, 16_000, 12.0);
        audio.extend(vec![0.0; 1600]);
        audio.extend(sine(300.0, 16_000, 28.0));
        let mut chunks = run(&mut cutter, &audio);
        cutter.cut(&mut |c| chunks.push(c));
        assert!(chunks.len() >= 3, "{}", chunks.len());
        // 第一刀切在低谷附近（12 秒左右），不是正好 15 秒
        let first = chunks[0].samples.len() as f32 / 16_000.0;
        assert!((11.9..12.3).contains(&first), "{first}");
        assert_eq!(chunks[0].overlap, 0);
        assert_eq!(chunks[1].overlap, OVERLAP);
        // 重叠部分确实是上一段的结尾
        assert_eq!(
            &chunks[1].samples[..OVERLAP],
            &chunks[0].samples[chunks[0].samples.len() - OVERLAP..]
        );
        // 时刻：第二段（去掉重叠）从第一段结尾开始
        let gap = chunks[1].at as i64 - (chunks[0].at as i64 + (first * 1000.0) as i64);
        assert!(gap.abs() <= 20, "{gap}");
        // 不丢声音：去掉重叠后总长度 = 原长
        let total: usize = chunks.iter().map(|c| c.samples.len() - c.overlap).sum();
        assert!(
            (total as i64 - audio.len() as i64).abs() <= 256 * 2,
            "{total}"
        );
    }

    #[test]
    fn silence_is_never_sent() {
        let mut cutter = Cutter::new(Box::new(Loud));
        let mut chunks = run(&mut cutter, &vec![0.001; 16_000 * 20]);
        cutter.cut(&mut |c| chunks.push(c));
        assert!(chunks.is_empty());
    }

    #[test]
    fn quiet_speech_is_flagged() {
        struct Always;
        impl Vad for Always {
            fn score(&mut self, _: &[f32]) -> f32 {
                1.0
            }
        }
        let mut cutter = Cutter::new(Box::new(Always));
        let mut chunks = run(
            &mut cutter,
            &sine(300.0, 16_000, 3.0)
                .iter()
                .map(|v| v * 0.01)
                .collect::<Vec<_>>(),
        );
        cutter.cut(&mut |c| chunks.push(c));
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].quiet);
    }
}
