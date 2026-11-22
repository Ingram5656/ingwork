//! 听课录音（设置里打开才存，默认不存）：16 kHz 单声道，IMA ADPCM 压缩成 4 位，一小时约 29 MB。
//! 文件是标准的 ADPCM WAV，别的播放器也能放。只存在这台电脑上，不放进同步的数据文件夹。
//!
//! 每 512 字节一块、一块 1017 个样本，块和块互不依赖：回放某一句时直接跳到那一块解码，不用从头读。
//! 暂停的时候不录，所以录音里的位置和时刻不是一一对应的：每次开始、继续时记一个"标记"（时刻 → 第几个样本）。

use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

pub const RATE: u32 = 16_000;
const BLOCK: usize = 512;
const PER_BLOCK: usize = (BLOCK - 4) * 2 + 1;
const HEADER: usize = 60;

const STEPS: [i32; 89] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
    73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
    494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272,
    2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493,
    10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX: [i32; 16] = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

struct Codec {
    predictor: i32,
    index: i32,
}

impl Codec {
    fn decode(&mut self, nibble: u8) -> i16 {
        let step = STEPS[self.index as usize];
        let mut diff = step >> 3;
        if nibble & 4 != 0 {
            diff += step;
        }
        if nibble & 2 != 0 {
            diff += step >> 1;
        }
        if nibble & 1 != 0 {
            diff += step >> 2;
        }
        if nibble & 8 != 0 {
            self.predictor -= diff;
        } else {
            self.predictor += diff;
        }
        self.predictor = self.predictor.clamp(-32768, 32767);
        self.index = (self.index + INDEX[nibble as usize]).clamp(0, 88);
        self.predictor as i16
    }

    fn encode(&mut self, sample: i16) -> u8 {
        let step = STEPS[self.index as usize];
        let mut diff = sample as i32 - self.predictor;
        let mut nibble = 0u8;
        if diff < 0 {
            nibble = 8;
            diff = -diff;
        }
        let mut s = step;
        if diff >= s {
            nibble |= 4;
            diff -= s;
        }
        s >>= 1;
        if diff >= s {
            nibble |= 2;
            diff -= s;
        }
        s >>= 1;
        if diff >= s {
            nibble |= 1;
        }
        // 用解码器的算法更新状态，保证两边一致
        self.decode(nibble);
        nibble
    }
}

fn to_i16(x: f32) -> i16 {
    (x.clamp(-1.0, 1.0) * 32767.0) as i16
}

fn encode_block(samples: &[i16], index: &mut i32) -> [u8; BLOCK] {
    let mut out = [0u8; BLOCK];
    let first = samples.first().copied().unwrap_or(0);
    out[0..2].copy_from_slice(&first.to_le_bytes());
    out[2] = *index as u8;
    let mut codec = Codec {
        predictor: first as i32,
        index: *index,
    };
    for i in 0..(PER_BLOCK - 1) {
        let s = samples.get(i + 1).copied().unwrap_or(0);
        let nibble = codec.encode(s);
        let byte = 4 + i / 2;
        if i % 2 == 0 {
            out[byte] = nibble;
        } else {
            out[byte] |= nibble << 4;
        }
    }
    *index = codec.index;
    out
}

fn decode_block(block: &[u8], out: &mut Vec<f32>) {
    if block.len() < 4 {
        return;
    }
    let first = i16::from_le_bytes([block[0], block[1]]);
    let mut codec = Codec {
        predictor: first as i32,
        index: (block[2] as i32).clamp(0, 88),
    };
    out.push(first as f32 / 32768.0);
    for &byte in &block[4..] {
        out.push(codec.decode(byte & 0x0f) as f32 / 32768.0);
        out.push(codec.decode(byte >> 4) as f32 / 32768.0);
    }
}

fn header(data_bytes: u32, samples: u32) -> [u8; HEADER] {
    let mut h = [0u8; HEADER];
    let mut w = 0;
    let mut put = |bytes: &[u8]| {
        h[w..w + bytes.len()].copy_from_slice(bytes);
        w += bytes.len();
    };
    put(b"RIFF");
    put(&(HEADER as u32 - 8 + data_bytes).to_le_bytes());
    put(b"WAVEfmt ");
    put(&20u32.to_le_bytes());
    put(&0x11u16.to_le_bytes()); // IMA ADPCM
    put(&1u16.to_le_bytes());
    put(&RATE.to_le_bytes());
    put(&((RATE as usize * BLOCK / PER_BLOCK) as u32).to_le_bytes());
    put(&(BLOCK as u16).to_le_bytes());
    put(&4u16.to_le_bytes());
    put(&2u16.to_le_bytes());
    put(&(PER_BLOCK as u16).to_le_bytes());
    put(b"fact");
    put(&4u32.to_le_bytes());
    put(&samples.to_le_bytes());
    put(b"data");
    put(&data_bytes.to_le_bytes());
    h
}

/// 边录边写
pub struct Writer {
    file: BufWriter<File>,
    pending: Vec<i16>,
    index: i32,
    blocks: u32,
    /// 写进去的样本数（含还没凑成一块的）
    pub samples: u64,
}

impl Writer {
    pub fn create(path: &Path) -> std::io::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut file = BufWriter::new(File::create(path)?);
        file.write_all(&header(0, 0))?;
        Ok(Self {
            file,
            pending: Vec::with_capacity(PER_BLOCK),
            index: 0,
            blocks: 0,
            samples: 0,
        })
    }

    pub fn push(&mut self, input: &[f32]) -> std::io::Result<()> {
        for &x in input {
            self.pending.push(to_i16(x));
            if self.pending.len() == PER_BLOCK {
                let block = encode_block(&self.pending, &mut self.index);
                self.file.write_all(&block)?;
                self.blocks += 1;
                self.pending.clear();
            }
        }
        self.samples += input.len() as u64;
        Ok(())
    }

    /// 补齐最后一块、写好文件头里的长度
    pub fn finish(mut self) -> std::io::Result<()> {
        if !self.pending.is_empty() {
            let block = encode_block(&self.pending, &mut self.index);
            self.file.write_all(&block)?;
            self.blocks += 1;
        }
        let data = self.blocks * BLOCK as u32;
        let samples = self.samples.min(u32::MAX as u64) as u32;
        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(&header(data, samples))?;
        self.file.flush()
    }
}

/// 文件里有多少个样本（按文件大小算，录到一半软件被关掉也能读）
pub fn length(path: &Path) -> Option<u64> {
    let size = std::fs::metadata(path).ok()?.len();
    Some(size.saturating_sub(HEADER as u64) / BLOCK as u64 * PER_BLOCK as u64)
}

/// 读 [from, to) 这一段样本
pub fn read(path: &Path, from: u64, to: u64) -> std::io::Result<Vec<f32>> {
    let mut file = File::open(path)?;
    let first = from / PER_BLOCK as u64;
    let last = to.div_ceil(PER_BLOCK as u64);
    file.seek(SeekFrom::Start(HEADER as u64 + first * BLOCK as u64))?;
    let mut buf = vec![0u8; ((last - first) as usize) * BLOCK];
    let mut got = 0;
    while got < buf.len() {
        match file.read(&mut buf[got..])? {
            0 => break,
            n => got += n,
        }
    }
    buf.truncate(got - got % BLOCK);
    let mut out = Vec::with_capacity(buf.len() * 2);
    for block in buf.chunks(BLOCK) {
        decode_block(block, &mut out);
    }
    let skip = (from - first * PER_BLOCK as u64) as usize;
    let take = (to - from) as usize;
    Ok(out.into_iter().skip(skip).take(take).collect())
}

/// 录音里的位置：每次开始、继续时记下"这个时刻对应第几个样本"
#[derive(Clone, Copy, Default, serde::Serialize, serde::Deserialize, PartialEq, Debug)]
pub struct Mark {
    pub at: u64,
    pub sample: u64,
}

/// 某个时刻在录音里的位置（落在暂停的空当里就算到下一截开头）
pub fn sample_at(marks: &[Mark], at: u64) -> Option<u64> {
    let i = marks.iter().rposition(|m| m.at <= at)?;
    let m = marks[i];
    let pos = m.sample + (at - m.at) * RATE as u64 / 1000;
    Some(match marks.get(i + 1) {
        Some(next) => pos.min(next.sample),
        None => pos,
    })
}

/// 录音里第几个样本是哪个时刻
pub fn time_at(marks: &[Mark], sample: u64) -> u64 {
    let Some(i) = marks.iter().rposition(|m| m.sample <= sample) else {
        return marks.first().map(|m| m.at).unwrap_or(0);
    };
    let m = marks[i];
    m.at + (sample - m.sample) * 1000 / RATE as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (i as f32 * 0.07).sin() * 0.4 + (i as f32 * 0.013).sin() * 0.2)
            .collect()
    }

    #[test]
    fn round_trip() {
        let dir = std::env::temp_dir().join(format!("adpcm-{}", std::process::id()));
        let path = dir.join("a.wav");
        let audio = tone(16_000 * 3 + 123);
        let mut w = Writer::create(&path).unwrap();
        for c in audio.chunks(777) {
            w.push(c).unwrap();
        }
        w.finish().unwrap();
        let n = length(&path).unwrap();
        assert!(n >= audio.len() as u64 && n < audio.len() as u64 + PER_BLOCK as u64);
        // 整段读回来：信噪比够听
        let back = read(&path, 0, audio.len() as u64).unwrap();
        assert_eq!(back.len(), audio.len());
        let noise: f32 = audio.iter().zip(&back).map(|(a, b)| (a - b).powi(2)).sum();
        let signal: f32 = audio.iter().map(|a| a * a).sum();
        let snr = 10.0 * (signal / noise).log10();
        assert!(snr > 20.0, "snr {snr}");
        // 从中间读一小段，和整段读出来的对应部分一样
        let part = read(&path, 20_000, 21_500).unwrap();
        assert_eq!(part, back[20_000..21_500].to_vec());
        // 文件头是标准的 ADPCM WAV
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(u16::from_le_bytes([bytes[20], bytes[21]]), 0x11);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn marks() {
        // 10:00 开始，录了 60 秒暂停；10:05 继续
        let m = [
            Mark {
                at: 600_000,
                sample: 0,
            },
            Mark {
                at: 900_000,
                sample: 960_000,
            },
        ];
        assert_eq!(sample_at(&m, 610_000), Some(160_000));
        // 暂停的空当里：算到继续的地方
        assert_eq!(sample_at(&m, 800_000), Some(960_000));
        assert_eq!(sample_at(&m, 901_000), Some(976_000));
        assert_eq!(sample_at(&m, 100), None);
        assert_eq!(time_at(&m, 160_000), 610_000);
        assert_eq!(time_at(&m, 976_000), 901_000);
    }
}
