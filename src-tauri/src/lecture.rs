//! 听课：麦克风录下老师讲的话，交给 DeepSeek 一段一段听写成英文、翻成中文；
//! 听课中每 5 分钟左右整理一次提纲，下课后从头到尾完整整理成笔记。
//!
//! 三条线：
//! - 录音线程：开麦克风，转成 16 kHz 单声道，按停顿切成十秒左右的一段（最长 15 秒），
//!   每 0.1 秒把音量发给界面（音量带）。切好的段交给处理线程。
//! - 处理线程：按顺序一段一段送去听写（DeepSeek 的语音识别），再翻译（deepseek-chat）。
//!   送不出去（断网、DeepSeek 忙）就停在这一段上隔一会儿再试，后面的排着队，顺序不会乱。
//! - 整理：每 5 分钟另开一个线程整理一版提纲；下课时处理完最后一段，再完整整理一遍。
//!
//! 录音不存，只存文字：每节课一个文件，放在数据文件夹的 lectures/ 里，几台电脑同步。
//! 状态每变一次就把整份发给界面（lecture-state），界面只管画。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

const ASR_URL: &str = "https://api.deepseek.com/v1/tools/asr";
const CHAT_URL: &str = "https://api.deepseek.com/chat/completions";
const BALANCE_URL: &str = "https://api.deepseek.com/user/balance";
const PLATFORM_URL: &str = "https://platform.deepseek.com/";
const MODEL: &str = "deepseek-chat";

/// 送去听写的采样率
const RATE: u32 = 16_000;
/// 0.1 秒一帧：算一次音量、判断一次有没有在说话
const FRAME: usize = (RATE / 10) as usize;
/// 听课中多久整理一次提纲
const NOTES_EVERY: Duration = Duration::from_secs(5 * 60);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------- 数据 ----------

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    id: u64,
    /// 这一段开始的时刻（毫秒时间戳）
    at: u64,
    en: String,
    /// 还在翻译是 null；翻译失败是空字符串
    zh: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Part {
    title: String,
    points: Vec<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Term {
    en: String,
    zh: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Due {
    title: String,
    /// "2026-12-04"，老师没说具体哪天是 null
    date: Option<String>,
    quote: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Notes {
    summary: String,
    outline: Vec<Part>,
    terms: Vec<Term>,
    dues: Vec<Due>,
    review: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Idle,
    Listening,
    Paused,
    Finishing,
    Done,
}

/// 一节课：存成文件的就是这一份
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    id: Option<String>,
    course: String,
    course_id: Option<String>,
    started_at: Option<u64>,
    /// 真正在听的时长（暂停的不算），不含正在听的这一截
    listened_ms: u64,
    segments: Vec<Segment>,
    notes: Option<Notes>,
    notes_at: Option<u64>,
}

/// 发给界面的整份状态
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct View<'a> {
    status: Status,
    #[serde(flatten)]
    session: &'a Session,
    /// 这一截从什么时候开始在听（界面拿它算"听了多久"），没在听是 null
    listening_since: Option<u64>,
    backlog: usize,
    next_notes_at: Option<u64>,
    summarizing: bool,
    error: Option<String>,
}

/// 以前的笔记，列表里的一行
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: String,
    course: String,
    started_at: u64,
    listened_ms: u64,
    summary: String,
}

enum Job {
    /// 切好的一段：编号、开始的时刻、WAV 文件
    Chunk { id: u64, at: u64, wav: Vec<u8> },
    /// 下课了：前面的处理完就完整整理
    Finish,
}

struct Inner {
    status: Status,
    s: Session,
    key: String,
    /// 每开始一节课加一；旧的线程看到对不上就不再往里写
    generation: u64,
    listening_since: Option<u64>,
    /// 排着队还没听写的段数
    queued: usize,
    /// 正在等着重试（断网、DeepSeek 忙）
    retrying: bool,
    next_notes_at: Option<u64>,
    summarizing: bool,
    /// 上一版提纲整理到第几段
    notes_upto: usize,
    error: Option<String>,
    stop: Option<Arc<AtomicBool>>,
    paused: Arc<AtomicBool>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            status: Status::Idle,
            s: Session::default(),
            key: String::new(),
            generation: 0,
            listening_since: None,
            queued: 0,
            retrying: false,
            next_notes_at: None,
            summarizing: false,
            notes_upto: 0,
            error: None,
            stop: None,
            paused: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Default)]
pub struct Lecture(Mutex<Inner>);

fn view(inner: &Inner) -> serde_json::Value {
    serde_json::to_value(View {
        status: inner.status,
        session: &inner.s,
        listening_since: inner.listening_since,
        backlog: if inner.retrying { inner.queued } else { 0 },
        next_notes_at: inner.next_notes_at,
        summarizing: inner.summarizing,
        error: inner.error.clone(),
    })
    .unwrap_or(serde_json::Value::Null)
}

fn publish(app: &AppHandle) {
    let value = view(&lock(&app.state::<Lecture>().inner().0));
    let _ = app.emit_to("main", "lecture-state", value);
}

/// 在锁里改一下状态再发给界面。generation 对不上（已经换了一节课）就什么都不做
fn update(app: &AppHandle, generation: u64, f: impl FnOnce(&mut Inner)) -> bool {
    {
        let mut inner = lock(&app.state::<Lecture>().inner().0);
        if inner.generation != generation {
            return false;
        }
        f(&mut inner);
    }
    publish(app);
    true
}

// ---------- 存档 ----------

fn folder(app: &AppHandle) -> PathBuf {
    app.state::<crate::location::DataDir>()
        .current()
        .join("lectures")
}

fn save(app: &AppHandle, session: &Session) {
    let Some(id) = &session.id else { return };
    let dir = folder(app);
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(text) = serde_json::to_string(session) {
        let tmp = dir.join(format!("{id}.json.tmp"));
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, dir.join(format!("{id}.json")));
        }
    }
}

fn save_current(app: &AppHandle, generation: u64) {
    let session = {
        let inner = lock(&app.state::<Lecture>().inner().0);
        if inner.generation != generation {
            return;
        }
        inner.s.clone()
    };
    save(app, &session);
}

/// 文件名只认字母数字和横线，免得拿 id 拼出别的路径
fn safe_id(id: &str) -> Result<&str, String> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(id)
    } else {
        Err("找不到这份笔记".into())
    }
}

// ---------- 录音和切段 ----------

/// 按停顿切段：攒到 4 秒以上、又停顿了 0.6 秒就切；一直不停最多 15 秒也切。
/// 一句话都没说的段不送（省钱，也免得听写出一堆"嗯"）
struct Cutter {
    /// 输入的采样率 / 16000：每多少个输入样本出一个
    step: f64,
    phase: f64,
    acc: f32,
    count: u32,
    frame: Vec<f32>,
    buf: Vec<f32>,
    /// buf 第一个样本对应的时刻
    buf_at: u64,
    speech: usize,
    silence: usize,
    /// 环境噪音有多响，慢慢跟着变
    floor: f32,
}

impl Cutter {
    fn new(input_rate: u32) -> Self {
        Self {
            step: input_rate as f64 / RATE as f64,
            phase: 0.0,
            acc: 0.0,
            count: 0,
            frame: Vec::with_capacity(FRAME),
            buf: Vec::new(),
            buf_at: 0,
            speech: 0,
            silence: 0,
            floor: 0.01,
        }
    }

    /// 喂一块单声道样本。每满 0.1 秒调一次 on_level，切出一段调一次 on_chunk
    fn push(
        &mut self,
        input: &[f32],
        on_level: &mut impl FnMut(f32),
        on_chunk: &mut impl FnMut(u64, Vec<f32>),
    ) {
        for &x in input {
            // 降到 16 kHz：一个输出样本取它覆盖的那几个输入样本的平均，顺便滤掉高频
            self.acc += x;
            self.count += 1;
            self.phase += 1.0;
            if self.phase >= self.step {
                self.phase -= self.step;
                let y = self.acc / self.count as f32;
                self.acc = 0.0;
                self.count = 0;
                self.frame.push(y);
                if self.frame.len() == FRAME {
                    let frame = std::mem::take(&mut self.frame);
                    self.on_frame(frame, on_level, on_chunk);
                    self.frame = Vec::with_capacity(FRAME);
                }
            }
        }
    }

    fn on_frame(
        &mut self,
        frame: Vec<f32>,
        on_level: &mut impl FnMut(f32),
        on_chunk: &mut impl FnMut(u64, Vec<f32>),
    ) {
        let rms = (frame.iter().map(|v| v * v).sum::<f32>() / frame.len() as f32).sqrt();
        let db = 20.0 * (rms + 1e-9).log10();
        on_level(((db + 55.0) / 45.0).clamp(0.0, 1.0));

        // 噪音底：往下跟得快，往上跟得慢（说话时不会被当成噪音）
        if rms < self.floor {
            self.floor = self.floor * 0.9 + rms * 0.1;
        } else {
            self.floor = self.floor * 0.998 + rms * 0.002;
        }
        let speaking = rms > (self.floor * 2.5).max(0.006);

        if self.buf.is_empty() {
            self.buf_at = now_ms().saturating_sub(100);
        }
        self.buf.extend_from_slice(&frame);
        if speaking {
            self.speech += 1;
            self.silence = 0;
        } else {
            self.silence += 1;
        }

        // 还没人说话：只留最后 0.3 秒当开头，前面的静音扔掉
        if self.speech == 0 && self.buf.len() > FRAME * 5 {
            let keep = FRAME * 3;
            let drop = self.buf.len() - keep;
            self.buf.drain(..drop);
            self.buf_at += (drop as u64) * 1000 / RATE as u64;
            return;
        }

        let seconds = self.buf.len() / RATE as usize;
        if self.speech > 0 && ((seconds >= 4 && self.silence >= 6) || seconds >= 15) {
            self.cut(on_chunk);
        }
    }

    /// 把攒着的切出去（暂停、下课时也调）
    fn cut(&mut self, on_chunk: &mut impl FnMut(u64, Vec<f32>)) {
        let buf = std::mem::take(&mut self.buf);
        if self.speech >= 4 {
            on_chunk(self.buf_at, buf);
        }
        self.speech = 0;
        self.silence = 0;
    }
}

/// 16 位、16 kHz、单声道 WAV
fn wav(samples: &[f32]) -> Vec<u8> {
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

/// 打开默认麦克风：返回流（得一直拿着，丢了就停）、样本从哪儿来、采样率
fn open_mic() -> Result<(cpal::Stream, Receiver<Vec<f32>>, u32), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "没找到麦克风，请检查有没有插好、系统设置里有没有关掉".to_string())?;
    let config = device
        .default_input_config()
        .map_err(|_| "麦克风打不开，请检查系统设置里是否允许 ingwork 使用麦克风".to_string())?;
    let channels = config.channels().max(1) as usize;
    let rate = config.sample_rate().0;
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let err = |e: cpal::StreamError| crate::logger::error(&format!("microphone: {e}"));

    fn mono<T: Copy>(data: &[T], channels: usize, conv: impl Fn(T) -> f32) -> Vec<f32> {
        data.chunks(channels)
            .map(|frame| frame.iter().map(|&v| conv(v)).sum::<f32>() / frame.len() as f32)
            .collect()
    }

    let stream_config: cpal::StreamConfig = config.clone().into();
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => {
            let tx = tx.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let _ = tx.send(mono(data, channels, |v| v));
                },
                err,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let tx = tx.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    let _ = tx.send(mono(data, channels, |v| v as f32 / 32768.0));
                },
                err,
                None,
            )
        }
        cpal::SampleFormat::U16 => {
            let tx = tx.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    let _ = tx.send(mono(data, channels, |v| (v as f32 - 32768.0) / 32768.0));
                },
                err,
                None,
            )
        }
        _ => return Err("这个麦克风的格式不认识，换一个麦克风试试".into()),
    }
    .map_err(|_| "麦克风打不开，请检查系统设置里是否允许 ingwork 使用麦克风".to_string())?;
    stream
        .play()
        .map_err(|_| "麦克风打不开，请检查系统设置里是否允许 ingwork 使用麦克风".to_string())?;
    Ok((stream, rx, rate))
}

/// 录音线程：开麦克风，切段交给处理线程，下课时把最后一段和"下课了"交过去
fn spawn_recorder(
    app: AppHandle,
    generation: u64,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    jobs: Sender<Job>,
) -> Result<(), String> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let (stream, samples, rate) = match open_mic() {
            Ok(v) => {
                let _ = ready_tx.send(Ok(()));
                v
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
                return;
            }
        };
        let mut cutter = Cutter::new(rate);
        let mut next_id: u64 = 1;
        let mut was_paused = false;
        let mut quiet_at = Instant::now();
        let mut send_chunk = |at: u64, buf: Vec<f32>| {
            let wav = wav(&buf);
            if update(&app, generation, |inner| inner.queued += 1) {
                let _ = jobs.send(Job::Chunk {
                    id: next_id,
                    at,
                    wav,
                });
                next_id += 1;
            }
        };
        let level_app = app.clone();
        let mut on_level = move |level: f32| {
            let _ = level_app.emit_to("main", "lecture-level", level);
        };
        loop {
            if stop.load(Ordering::SeqCst) {
                cutter.cut(&mut send_chunk);
                break;
            }
            let is_paused = paused.load(Ordering::SeqCst);
            if is_paused && !was_paused {
                // 刚暂停：把攒着的这一段先切出去
                cutter.cut(&mut send_chunk);
            }
            was_paused = is_paused;
            match samples.recv_timeout(Duration::from_millis(100)) {
                Ok(block) => {
                    if is_paused {
                        // 暂停时音量带放平，0.1 秒发一次就够了
                        if quiet_at.elapsed() >= Duration::from_millis(100) {
                            quiet_at = Instant::now();
                            on_level(0.0);
                        }
                    } else {
                        cutter.push(&block, &mut on_level, &mut send_chunk);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        drop(stream);
        let _ = jobs.send(Job::Finish);
    });
    ready_rx
        .recv_timeout(Duration::from_secs(10))
        .unwrap_or_else(|_| Err("麦克风没有反应，请检查有没有被别的软件占着".into()))
}

// ---------- DeepSeek ----------

enum Fail {
    /// 等一会儿再试（断网、DeepSeek 忙、余额不够、密钥不对）
    Later(String),
    /// 这一段就算了
    Skip(String),
}

fn client(timeout: u64) -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
}

fn status_fail(code: u16) -> Fail {
    match code {
        401 => Fail::Later("DeepSeek 密钥不对，请到设置的\u{201c}听课\u{201d}里检查一下".into()),
        402 => Fail::Later("DeepSeek 账户余额不够了，充值以后会接着听写".into()),
        400 | 413 => Fail::Skip("有一段声音没听写出来，跳过了".into()),
        _ => Fail::Later("DeepSeek 暂时连不上，录下来的先攒着，连上了会自动补上".into()),
    }
}

fn transcribe(key: &str, wav: &[u8]) -> Result<String, Fail> {
    let part = reqwest::blocking::multipart::Part::bytes(wav.to_vec())
        .file_name("speech.wav")
        .mime_str("audio/wav")
        .map_err(|_| Fail::Skip("有一段声音没听写出来，跳过了".into()))?;
    let form = reqwest::blocking::multipart::Form::new().part("file", part);
    let resp = client(60)
        .post(ASR_URL)
        .bearer_auth(key)
        .multipart(form)
        .send()
        .map_err(|_| Fail::Later("DeepSeek 暂时连不上，录下来的先攒着，连上了会自动补上".into()))?;
    if !resp.status().is_success() {
        return Err(status_fail(resp.status().as_u16()));
    }
    let v: serde_json::Value = resp
        .json()
        .map_err(|_| Fail::Skip("有一段声音没听写出来，跳过了".into()))?;
    Ok(v.get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

fn chat(key: &str, system: &str, user: &str, json: bool, timeout: u64) -> Result<String, Fail> {
    let mut body = serde_json::json!({
        "model": MODEL,
        "temperature": 0.3,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ]
    });
    if json {
        body["response_format"] = serde_json::json!({ "type": "json_object" });
    }
    let resp = client(timeout)
        .post(CHAT_URL)
        .bearer_auth(key)
        .json(&body)
        .send()
        .map_err(|_| Fail::Later("DeepSeek 暂时连不上，连上了会接着翻译和整理".into()))?;
    if !resp.status().is_success() {
        return Err(status_fail(resp.status().as_u16()));
    }
    let v: serde_json::Value = resp
        .json()
        .map_err(|_| Fail::Later("DeepSeek 回来的内容读不懂，稍后再试".into()))?;
    Ok(v.pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

const TRANSLATE_PROMPT: &str =
    "你是大学课堂的同声传译。把老师刚说的这一段英文翻成自然、准确的简体中文，像中文老师在讲课。\
专业术语第一次出现时，在中文后面用括号保留英文原词。\
这段话是按停顿切出来的，开头结尾可能不完整：按意思翻，不要补充、不要解释。\
\u{201c}前文\u{201d}只是帮你理解上下文的，不要翻译它。只输出这一段的译文。";

fn translate(key: &str, context: &[Segment], en: &str) -> Result<String, Fail> {
    let mut user = String::new();
    if !context.is_empty() {
        user.push_str("前文：\n");
        for seg in context {
            user.push_str(&seg.en);
            user.push('\n');
        }
        user.push('\n');
    }
    user.push_str("这一段：\n");
    user.push_str(en);
    chat(key, TRANSLATE_PROMPT, &user, false, 45)
}

fn notes_prompt(final_pass: bool, course: &str, date: &str) -> String {
    format!(
        "你在帮一个留学生整理大学课堂笔记。课程是\u{201c}{course}\u{201d}，上课日期是 {date}。\
下面是这节课{when}的听写稿（英文，按时间顺序，每行前面是时刻），听写可能有错字，请结合上下文理解，专业词按正确写法。\
用简体中文整理，只输出一个 JSON 对象，格式是：\
{{\"summary\": \"这节课讲了什么，两三句话\", \
\"outline\": [{{\"title\": \"主题\", \"points\": [\"要点\", ...]}}, ...], \
\"terms\": [{{\"en\": \"英文术语\", \"zh\": \"中文\", \"note\": \"一句话解释，可以省略\"}}, ...], \
\"dues\": [{{\"title\": \"作业、考试或截止的事\", \"date\": \"YYYY-MM-DD，老师没说具体哪天就填 null\", \"quote\": \"老师原话（英文，简短）\"}}, ...], \
\"review\": [\"值得回去复习的地方\", ...]}}。\
提纲按主题分段，每段三到六个要点，要点写成完整的短句，保留公式、数字和例子。\
术语挑这节课真正重要的，最多十五个。dues 只放老师明确说了的作业、考试、截止日期，没有就是空数组；日期按上课日期推算（比如\u{201c}下周五\u{201d}）。{extra}",
        when = if final_pass { "完整" } else { "到目前为止" },
        extra = if final_pass {
            ""
        } else {
            "课还没上完，summary 可以留空，提纲只整理已经讲到的部分。"
        }
    )
}

fn clock(ms: u64) -> String {
    let secs = ms / 1000;
    // 只是给模型看个先后，不用换成本地时间
    format!("{:02}:{:02}", (secs / 3600) % 24, (secs / 60) % 60)
}

fn date_of(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// 整理一遍：成功返回笔记
fn summarize(key: &str, session: &Session, final_pass: bool) -> Result<Notes, Fail> {
    let mut text = String::new();
    for seg in &session.segments {
        text.push_str(&clock(seg.at));
        text.push(' ');
        text.push_str(&seg.en);
        text.push('\n');
    }
    let date = date_of(session.started_at.unwrap_or_else(now_ms));
    let prompt = notes_prompt(final_pass, &session.course, &date);
    let out = chat(key, &prompt, &text, true, 180)?;
    serde_json::from_str::<Notes>(&out).map_err(|_| Fail::Later("笔记没整理出来，稍后再试".into()))
}

/// 另开一个线程整理（听课中的提纲、或者下课后的完整整理）
fn spawn_summary(app: AppHandle, generation: u64, final_pass: bool) {
    let snapshot = {
        let mut inner = lock(&app.state::<Lecture>().inner().0);
        if inner.generation != generation || inner.summarizing {
            return;
        }
        inner.summarizing = true;
        (inner.key.clone(), inner.s.clone())
    };
    publish(&app);
    std::thread::spawn(move || {
        let (key, session) = snapshot;
        let count = session.segments.len();
        let result = summarize(&key, &session, final_pass);
        let ok = update(&app, generation, |inner| {
            inner.summarizing = false;
            // 草稿回来时已经下课了：以完整整理的为准，草稿扔掉
            let stale = !final_pass && matches!(inner.status, Status::Finishing | Status::Done);
            match result {
                Ok(notes) if !stale => {
                    inner.s.notes = Some(notes);
                    inner.s.notes_at = Some(now_ms());
                    inner.notes_upto = count;
                    inner.error = None;
                }
                Ok(_) => {}
                Err(Fail::Later(msg)) | Err(Fail::Skip(msg)) => inner.error = Some(msg),
            }
            if final_pass {
                inner.status = Status::Done;
                inner.next_notes_at = None;
            } else if matches!(inner.status, Status::Listening | Status::Paused) {
                inner.next_notes_at = Some(now_ms() + NOTES_EVERY.as_millis() as u64);
            }
        });
        if ok {
            save_current(&app, generation);
            if final_pass {
                crate::awake::lecture(false);
            }
        }
    });
}

// ---------- 处理线程 ----------

fn spawn_worker(app: AppHandle, generation: u64, jobs: Receiver<Job>) {
    std::thread::spawn(move || {
        let mut saved_at = 0usize;
        while let Ok(job) = jobs.recv() {
            match job {
                Job::Chunk { id, at, wav } => {
                    let key = {
                        let inner = lock(&app.state::<Lecture>().inner().0);
                        if inner.generation != generation {
                            return;
                        }
                        inner.key.clone()
                    };
                    // 听写：送不出去就停在这一段上，隔一会儿再试，后面的排队
                    let mut wait = 2u64;
                    let text = loop {
                        match transcribe(&key, &wav) {
                            Ok(text) => break Some(text),
                            Err(Fail::Skip(msg)) => {
                                update(&app, generation, |inner| inner.error = Some(msg));
                                break None;
                            }
                            Err(Fail::Later(msg)) => {
                                if !update(&app, generation, |inner| {
                                    inner.error = Some(msg);
                                    inner.retrying = true;
                                }) {
                                    return;
                                }
                                std::thread::sleep(Duration::from_secs(wait));
                                wait = (wait * 2).min(30);
                            }
                        }
                    };
                    let mut context = Vec::new();
                    let alive = update(&app, generation, |inner| {
                        inner.queued = inner.queued.saturating_sub(1);
                        inner.retrying = false;
                        if inner.error.as_deref().is_some_and(|e| {
                            e.contains("连不上") || e.contains("余额") || e.contains("密钥")
                        }) {
                            inner.error = None;
                        }
                        if let Some(text) = text.as_ref().filter(|t| !t.is_empty()) {
                            let n = inner.s.segments.len();
                            context = inner.s.segments[n.saturating_sub(3)..].to_vec();
                            inner.s.segments.push(Segment {
                                id,
                                at,
                                en: text.clone(),
                                zh: None,
                            });
                        }
                    });
                    if !alive {
                        return;
                    }
                    let Some(en) = text.filter(|t| !t.is_empty()) else {
                        continue;
                    };
                    // 翻译：失败两次就留空，界面上写"没翻译出来"，不卡住后面的
                    let mut zh = String::new();
                    for attempt in 0..2 {
                        match translate(&key, &context, &en) {
                            Ok(out) => {
                                zh = out;
                                break;
                            }
                            Err(_) if attempt == 0 => std::thread::sleep(Duration::from_secs(2)),
                            Err(_) => {}
                        }
                    }
                    let mut due = false;
                    update(&app, generation, |inner| {
                        if let Some(seg) = inner.s.segments.iter_mut().find(|s| s.id == id) {
                            seg.zh = Some(zh);
                        }
                        due = inner.status == Status::Listening
                            && inner.next_notes_at.is_some_and(|t| now_ms() >= t)
                            && inner.s.segments.len() > inner.notes_upto
                            && !inner.summarizing;
                    });
                    if due {
                        spawn_summary(app.clone(), generation, false);
                    }
                    // 隔几段存一次，中途关掉软件也丢不了多少
                    let count = lock(&app.state::<Lecture>().inner().0).s.segments.len();
                    if count >= saved_at + 6 {
                        saved_at = count;
                        save_current(&app, generation);
                    }
                }
                Job::Finish => {
                    save_current(&app, generation);
                    let empty = lock(&app.state::<Lecture>().inner().0)
                        .s
                        .segments
                        .is_empty();
                    if empty {
                        update(&app, generation, |inner| {
                            inner.status = Status::Done;
                            inner.next_notes_at = None;
                            inner.error = Some("这节课没听到说话，没有可整理的".into());
                        });
                        crate::awake::lecture(false);
                    } else {
                        // 正在整理草稿的话等它回来再整理完整的
                        for _ in 0..240 {
                            if !lock(&app.state::<Lecture>().inner().0).summarizing {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(500));
                        }
                        spawn_summary(app.clone(), generation, true);
                    }
                    return;
                }
            }
        }
    });
}

// ---------- 命令 ----------

#[tauri::command]
pub fn lecture_get(lecture: State<Lecture>) -> serde_json::Value {
    view(&lock(&lecture.0))
}

/// 开始听：开麦克风、起处理线程
#[tauri::command(async)]
pub fn lecture_start(
    app: AppHandle,
    lecture: State<Lecture>,
    course: String,
    course_id: Option<String>,
    key: String,
) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("先在设置的\u{201c}听课\u{201d}里填 DeepSeek 密钥".into());
    }
    let course = course.trim().chars().take(80).collect::<String>();
    if course.is_empty() {
        return Err("写一个课名".into());
    }
    let (generation, stop, paused, tx) = {
        let mut inner = lock(&lecture.0);
        if matches!(
            inner.status,
            Status::Listening | Status::Paused | Status::Finishing
        ) {
            return Err("正在听一节课，先结束它".into());
        }
        let generation = inner.generation + 1;
        let now = now_ms();
        let stop = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        *inner = Inner {
            status: Status::Listening,
            s: Session {
                id: Some(format!("{now}")),
                course,
                course_id,
                started_at: Some(now),
                ..Session::default()
            },
            key,
            generation,
            listening_since: Some(now),
            next_notes_at: Some(now + NOTES_EVERY.as_millis() as u64),
            stop: Some(stop.clone()),
            paused: paused.clone(),
            ..Inner::default()
        };
        let (tx, rx) = mpsc::channel::<Job>();
        spawn_worker(app.clone(), generation, rx);
        (generation, stop, paused, tx)
    };
    if let Err(e) = spawn_recorder(app.clone(), generation, stop, paused, tx) {
        // 麦克风打不开：退回去，什么都没开始
        let mut inner = lock(&lecture.0);
        *inner = Inner {
            generation: generation + 1,
            ..Inner::default()
        };
        drop(inner);
        publish(&app);
        return Err(e);
    }
    crate::awake::lecture(true);
    crate::logger::info("lecture started");
    publish(&app);
    Ok(())
}

/// 累加正在听的这一截
fn bank(inner: &mut Inner) {
    if let Some(since) = inner.listening_since.take() {
        inner.s.listened_ms += now_ms().saturating_sub(since);
    }
}

#[tauri::command]
pub fn lecture_pause(app: AppHandle, lecture: State<Lecture>) {
    {
        let mut inner = lock(&lecture.0);
        if inner.status != Status::Listening {
            return;
        }
        inner.paused.store(true, Ordering::SeqCst);
        inner.status = Status::Paused;
        bank(&mut inner);
    }
    publish(&app);
}

#[tauri::command]
pub fn lecture_resume(app: AppHandle, lecture: State<Lecture>) {
    {
        let mut inner = lock(&lecture.0);
        if inner.status != Status::Paused {
            return;
        }
        inner.paused.store(false, Ordering::SeqCst);
        inner.status = Status::Listening;
        inner.listening_since = Some(now_ms());
    }
    publish(&app);
}

/// 下课：停掉录音，处理完剩下的段，完整整理
#[tauri::command]
pub fn lecture_stop(app: AppHandle, lecture: State<Lecture>) {
    {
        let mut inner = lock(&lecture.0);
        if !matches!(inner.status, Status::Listening | Status::Paused) {
            return;
        }
        bank(&mut inner);
        inner.status = Status::Finishing;
        inner.next_notes_at = None;
        inner.paused.store(false, Ordering::SeqCst);
        if let Some(stop) = inner.stop.take() {
            stop.store(true, Ordering::SeqCst);
        }
    }
    crate::logger::info("lecture stopped");
    publish(&app);
}

/// 看完了：回到"要听哪节课"
#[tauri::command]
pub fn lecture_close(app: AppHandle, lecture: State<Lecture>) {
    {
        let mut inner = lock(&lecture.0);
        if matches!(
            inner.status,
            Status::Listening | Status::Paused | Status::Finishing
        ) {
            return;
        }
        let generation = inner.generation + 1;
        *inner = Inner {
            generation,
            ..Inner::default()
        };
    }
    publish(&app);
}

/// 重新完整整理一遍（整理失败、或者想再来一次）
#[tauri::command]
pub fn lecture_summarize(app: AppHandle, lecture: State<Lecture>, key: String) {
    let generation = {
        let mut inner = lock(&lecture.0);
        if inner.status != Status::Done || inner.s.segments.is_empty() {
            return;
        }
        if !key.trim().is_empty() {
            inner.key = key.trim().to_string();
        }
        inner.error = None;
        inner.generation
    };
    spawn_summary(app, generation, true);
}

/// 设置里换了密钥：正在听的这节课也换上
#[tauri::command]
pub fn lecture_set_key(lecture: State<Lecture>, key: String) {
    let key = key.trim();
    if !key.is_empty() {
        lock(&lecture.0).key = key.to_string();
    }
}

/// 打开以前的一份笔记
#[tauri::command]
pub fn lecture_open(app: AppHandle, lecture: State<Lecture>, id: String) -> Result<(), String> {
    let id = safe_id(&id)?;
    let text = std::fs::read_to_string(folder(&app).join(format!("{id}.json")))
        .map_err(|_| "找不到这份笔记，可能已经删掉了".to_string())?;
    let session: Session =
        serde_json::from_str(&text).map_err(|_| "这份笔记读不懂，文件可能坏了".to_string())?;
    {
        let mut inner = lock(&lecture.0);
        if matches!(
            inner.status,
            Status::Listening | Status::Paused | Status::Finishing
        ) {
            return Err("正在听一节课，先结束它再看以前的".into());
        }
        let generation = inner.generation + 1;
        let key = inner.key.clone();
        *inner = Inner {
            status: Status::Done,
            s: session,
            key,
            generation,
            ..Inner::default()
        };
    }
    publish(&app);
    Ok(())
}

#[tauri::command]
pub fn lecture_remove(app: AppHandle, lecture: State<Lecture>, id: String) -> Result<(), String> {
    let id = safe_id(&id)?.to_string();
    {
        let mut inner = lock(&lecture.0);
        if inner.s.id.as_deref() == Some(id.as_str()) {
            if matches!(
                inner.status,
                Status::Listening | Status::Paused | Status::Finishing
            ) {
                return Err("正在听这节课，先结束它".into());
            }
            let generation = inner.generation + 1;
            *inner = Inner {
                generation,
                ..Inner::default()
            };
        }
    }
    let _ = std::fs::remove_file(folder(&app).join(format!("{id}.json")));
    publish(&app);
    Ok(())
}

/// 以前的笔记，新的在前
#[tauri::command(async)]
pub fn lecture_list(app: AppHandle) -> Vec<Entry> {
    let mut out = Vec::new();
    let Ok(dir) = std::fs::read_dir(folder(&app)) else {
        return out;
    };
    for entry in dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(s) = serde_json::from_str::<Session>(&text) else {
            continue;
        };
        let (Some(id), Some(started_at)) = (s.id.clone(), s.started_at) else {
            continue;
        };
        let summary = s
            .notes
            .as_ref()
            .map(|n| n.summary.clone())
            .filter(|t| !t.is_empty())
            .or_else(|| s.segments.first().and_then(|seg| seg.zh.clone()))
            .unwrap_or_default()
            .chars()
            .take(80)
            .collect();
        out.push(Entry {
            id,
            course: s.course,
            started_at,
            listened_ms: s.listened_ms,
            summary,
        });
    }
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    out
}

/// 导出成 Markdown：界面写好内容，这里弹出存文件的窗口。取消了返回 false
#[tauri::command(async)]
pub fn lecture_export(app: AppHandle, name: String, content: String) -> Result<bool, String> {
    let clean: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { ' ' } else { c })
        .take(60)
        .collect();
    let Some(picked) = app
        .dialog()
        .file()
        .set_file_name(format!("{}.md", clean.trim()))
        .add_filter("Markdown", &["md"])
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = picked
        .into_path()
        .map_err(|_| "这个位置存不了，换一个文件夹试试".to_string())?;
    std::fs::write(&path, content).map_err(|_| "没存上，请检查那个文件夹能不能写".to_string())?;
    Ok(true)
}

/// 试一下密钥：查一下账户余额
#[tauri::command(async)]
pub fn lecture_check_key(key: String) -> Result<(), String> {
    // 用的是阻塞的网络请求，不能直接在异步命令里跑，另开一个线程
    std::thread::spawn(move || check_key(key.trim()))
        .join()
        .unwrap_or_else(|_| Err("DeepSeek 暂时连不上，稍后再试".into()))
}

fn check_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("先填密钥".into());
    }
    let resp = client(15)
        .get(BALANCE_URL)
        .bearer_auth(key)
        .send()
        .map_err(|_| "连不上 DeepSeek，请检查网络".to_string())?;
    match resp.status().as_u16() {
        200 => {}
        401 => return Err("密钥不对，请检查有没有复制完整".into()),
        _ => return Err("DeepSeek 暂时连不上，稍后再试".into()),
    }
    let v: serde_json::Value = resp.json().unwrap_or(serde_json::Value::Null);
    if v.get("is_available").and_then(|a| a.as_bool()) == Some(false) {
        return Err("密钥能用，但账户里没有余额，先充一点钱".into());
    }
    Ok(())
}

/// 在浏览器里打开 DeepSeek 开放平台
#[tauri::command]
pub fn lecture_open_platform() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(PLATFORM_URL).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer")
        .arg(PLATFORM_URL)
        .spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = std::process::Command::new("xdg-open")
        .arg(PLATFORM_URL)
        .spawn();
    result
        .map(|_| ())
        .map_err(|_| "没能打开浏览器，请自己打开 platform.deepseek.com".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header() {
        let w = wav(&[0.0; 160]);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(w.len(), 44 + 320);
    }

    #[test]
    fn cutter_cuts_after_pause() {
        let mut cutter = Cutter::new(16_000);
        let mut chunks = Vec::new();
        let mut levels = 0;
        // 5 秒"说话"（响的正弦），再 1 秒安静
        let speech: Vec<f32> = (0..16_000 * 5)
            .map(|i| (i as f32 * 0.05).sin() * 0.3)
            .collect();
        let quiet = vec![0.0f32; 16_000];
        cutter.push(&quiet, &mut |_| levels += 1, &mut |at, buf| {
            chunks.push((at, buf.len()))
        });
        cutter.push(&speech, &mut |_| levels += 1, &mut |at, buf| {
            chunks.push((at, buf.len()))
        });
        cutter.push(&quiet, &mut |_| levels += 1, &mut |at, buf| {
            chunks.push((at, buf.len()))
        });
        assert_eq!(levels, 70);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].1 >= 16_000 * 5);
    }

    #[test]
    fn silence_is_never_sent() {
        let mut cutter = Cutter::new(48_000);
        let mut chunks = 0;
        cutter.push(&vec![0.0f32; 48_000 * 20], &mut |_| {}, &mut |_, _| {
            chunks += 1
        });
        cutter.cut(&mut |_, _| chunks += 1);
        assert_eq!(chunks, 0);
    }

    #[test]
    fn dates() {
        assert_eq!(date_of(0), "1970-01-01");
        assert_eq!(date_of(1_795_000_000_000), "2026-11-18");
    }

    #[test]
    fn ids() {
        assert!(safe_id("1795000000000").is_ok());
        assert!(safe_id("../x").is_err());
    }
}
