//! 听写用哪个：DeepSeek 的语音识别（默认，一个密钥就能用），或者 Groq 上的 Whisper。
//!
//! DeepSeek 的听写只收一段声音、语言靠它自己猜：口音重、声音糊的时候会猜成别的语言，
//! 再"脑补"出一段通顺的话（英文课里冒出整段中文）。Whisper 可以：
//! - 指定语言：说了是英文就只出英文；
//! - 带提示：把这门课的术语和上一句话传过去，专业词更容易听对、前后接得上；
//! - 告诉我们每一小段有多大把握：把握太小的（多半是瞎编的）不要，标成"没听清"。
//!
//! Groq 用不了（额度用完、连不上、密钥不对）就退回 DeepSeek，这节课不会断。
//! 不管用哪个，讲课语言定了是英文时，听写里的中日韩文字都去掉。

use super::glossary::GTerm;
use super::{client, status_fail, Fail};
use serde::Deserialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const DEEPSEEK_URL: &str = "https://api.deepseek.com/v1/tools/asr";
const GROQ_URL: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODELS_URL: &str = "https://api.groq.com/openai/v1/models";
/// 免费额度里两个 Whisper 的限制一样，用准的那个
const GROQ_MODEL: &str = "whisper-large-v3";
pub const GROQ_SITE: &str = "https://console.groq.com/keys";
/// Groq 每次请求最少按这么多算
const GROQ_MIN_MS: u64 = 10_000;

const SKIPPED: &str = "有一段声音没听写出来，跳过了";
const OFFLINE: &str = "DeepSeek 暂时连不上，录下来的先攒着，连上了会自动补上";

#[derive(Clone, Copy, PartialEq, Eq, Default, Deserialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    #[default]
    DeepSeek,
    Groq,
}

/// 设置里选的：用哪个听写、Groq 的密钥、老师讲课的语言
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub engine: Engine,
    pub groq_key: String,
    /// "en"；空的或 "auto" 是不限
    pub language: String,
}

impl Config {
    /// 选了 Groq 而且填了密钥
    pub fn groq(&self) -> bool {
        self.engine == Engine::Groq && !self.groq_key.trim().is_empty()
    }

    fn lang(&self) -> Option<&str> {
        match self.language.trim() {
            "" | "auto" => None,
            l => Some(l),
        }
    }

    /// 讲课语言是用拉丁字母写的（英文这类）：听写里的中日韩文字就是听错的
    fn latin(&self) -> bool {
        self.lang()
            .is_some_and(|l| !matches!(l, "zh" | "yue" | "ja" | "ko"))
    }
}

/// 听写回来的一段
#[derive(Default, Debug, PartialEq)]
pub struct Heard {
    pub text: String,
    /// DeepSeek 听了多久（毫秒）
    pub ms: u64,
    /// Groq 听了多久（毫秒，按它的算法：不到 10 秒算 10 秒）
    pub groq_ms: u64,
    /// 有声音但没听清：听写出来的不可信，已经去掉了
    pub unclear: bool,
    /// 要告诉用户的话（Groq 用不了，先用 DeepSeek 了）
    pub note: Option<String>,
}

// ---------- Groq 暂时用不了时歇一会儿 ----------

static GROQ_PAUSED: Mutex<Option<Instant>> = Mutex::new(None);

fn groq_paused() -> bool {
    let mut until = GROQ_PAUSED.lock().unwrap_or_else(|e| e.into_inner());
    match *until {
        Some(t) if Instant::now() < t => true,
        Some(_) => {
            *until = None;
            false
        }
        None => false,
    }
}

fn pause_groq(secs: u64) {
    *GROQ_PAUSED.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(Instant::now() + Duration::from_secs(secs));
}

/// 设置改了（比如换了密钥）：马上再试 Groq
pub fn resume_groq() {
    *GROQ_PAUSED.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

// ---------- 讲课语言 ----------

/// 中日韩的字（汉字、假名、谚文）
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xAC00..=0xD7AF
        | 0xF900..=0xFAFF | 0x20000..=0x2FA1F)
}

/// 中日韩的标点、全角符号
fn is_cjk_punct(c: char) -> bool {
    matches!(c as u32, 0x3000..=0x303F | 0xFF00..=0xFFEF)
}

/// 讲课语言是英文这类时，去掉听写里的中日韩文字。
/// 夹在中间的拉丁字母片段至少三个词才留（"ENTP OC" 这种零碎的多半也是瞎编的）。
/// 返回（留下的，有没有去掉过东西）
pub fn keep_latin(text: &str) -> (String, bool) {
    if !text.chars().any(is_cjk) {
        return (text.trim().to_string(), false);
    }
    let mut kept: Vec<String> = Vec::new();
    let mut piece = String::new();
    let mut flush = |piece: &mut String| {
        let p = piece
            .trim()
            .trim_start_matches(|c: char| !c.is_alphanumeric())
            .trim();
        let words = p
            .split_whitespace()
            .filter(|w| w.chars().any(|c| c.is_alphabetic()))
            .count();
        if words >= 3 {
            kept.push(p.to_string());
        }
        piece.clear();
    };
    for c in text.chars() {
        if is_cjk(c) || is_cjk_punct(c) {
            flush(&mut piece);
        } else {
            piece.push(c);
        }
    }
    flush(&mut piece);
    (kept.join(" "), true)
}

// ---------- 给 Whisper 的提示 ----------

/// 提示最多 224 个 token：术语留三百来个字符，上一句留两百来个
const HINT_TERMS: usize = 320;
const HINT_TAIL: usize = 200;

/// 课名、这门课的术语（有中文译法的是课件里来的，排前面）、上一句话的结尾。
/// Whisper 把提示当成"前面刚说过的话"：里面出现过的词更容易听对，句子也接得上。
pub fn hint(course: &str, terms: &[GTerm], last: &str) -> String {
    let mut out = String::new();
    let course = course.trim();
    if !course.is_empty() {
        out.push_str(course);
        out.push_str(". ");
    }
    let mut names: Vec<&str> = terms
        .iter()
        .filter(|t| !t.zh.is_empty())
        .chain(terms.iter().filter(|t| t.zh.is_empty()))
        .map(|t| t.en.trim())
        .filter(|n| !n.is_empty())
        .collect();
    // 太多放不下：隔几个取一个，别只取到字母表前面的
    let total: usize = names.iter().map(|n| n.chars().count() + 2).sum();
    if total > HINT_TERMS {
        let step = total.div_ceil(HINT_TERMS);
        names = names.into_iter().step_by(step).collect();
    }
    let mut used = 0;
    let mut list = Vec::new();
    for n in names {
        used += n.chars().count() + 2;
        if used > HINT_TERMS {
            break;
        }
        list.push(n);
    }
    if !list.is_empty() {
        out.push_str(&list.join(", "));
        out.push_str(". ");
    }
    // 上一句的结尾，从一个词的开头截
    let last = last.trim();
    let count = last.chars().count();
    if count > HINT_TAIL {
        let tail: String = last.chars().skip(count - HINT_TAIL).collect();
        out.push_str(tail.split_once(' ').map(|(_, rest)| rest).unwrap_or(&tail));
    } else {
        out.push_str(last);
    }
    out.trim().to_string()
}

fn squash(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// 没听清时 Whisper 有时把提示里的话原样吐回来
fn echoes(text: &str, hint: &str) -> bool {
    let t = squash(text);
    t.split(' ').count() >= 4 && squash(hint).contains(&t)
}

// ---------- Whisper 的把握 ----------

/// Whisper 给每一小段的把握
#[derive(Clone, Debug)]
pub struct Piece {
    pub text: String,
    /// 平均对数概率：越接近 0 越有把握
    pub avg_logprob: f64,
    /// 这一段不是人说话的可能
    pub no_speech_prob: f64,
    /// 压缩比：太高是在重复同一句
    pub compression_ratio: f64,
}

/// 这一小段不可信（Whisper 自己用的也是这几条线）
fn shaky(p: &Piece) -> bool {
    p.avg_logprob < -1.0
        || p.compression_ratio > 2.4
        || (p.no_speech_prob > 0.6 && p.avg_logprob < -0.5)
}

/// 只留可信的小段。返回（文字，去掉了几段）
pub fn pick(pieces: &[Piece]) -> (String, usize) {
    let mut out = String::new();
    let mut dropped = 0;
    for p in pieces {
        let t = p.text.trim();
        if t.is_empty() {
            continue;
        }
        if shaky(p) {
            dropped += 1;
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(t);
    }
    (out, dropped)
}

// ---------- 请求 ----------

fn wav_ms(wav: &[u8]) -> u64 {
    // 16 kHz、16 位、单声道：每毫秒 32 字节
    (wav.len().saturating_sub(44) / 32) as u64
}

fn wav_part(wav: &[u8]) -> Option<reqwest::blocking::multipart::Part> {
    reqwest::blocking::multipart::Part::bytes(wav.to_vec())
        .file_name("speech.wav")
        .mime_str("audio/wav")
        .ok()
}

fn deepseek(key: &str, wav: &[u8]) -> Result<Heard, Fail> {
    let part = wav_part(wav).ok_or_else(|| Fail::Skip(SKIPPED.into()))?;
    let form = reqwest::blocking::multipart::Form::new().part("file", part);
    let resp = client(60)
        .post(DEEPSEEK_URL)
        .bearer_auth(key)
        .multipart(form)
        .send()
        .map_err(|_| Fail::Later(OFFLINE.into()))?;
    if !resp.status().is_success() {
        return Err(status_fail(resp.status().as_u16()));
    }
    let v: serde_json::Value = resp.json().map_err(|_| Fail::Skip(SKIPPED.into()))?;
    let text = v
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let ms = v
        .get("duration_ms")
        .and_then(|d| d.as_u64())
        .unwrap_or_else(|| wav_ms(wav));
    Ok(Heard {
        text,
        ms,
        ..Heard::default()
    })
}

enum GroqFail {
    /// 这段声音它不收：换谁也一样，跳过
    Skip,
    /// 这会儿用不了：歇多少秒，跟用户说什么
    Paused(u64, &'static str),
}

const GROQ_KEY_BAD: &str =
    "Groq 密钥不对，先用 DeepSeek 听写。请到设置的\u{201c}听课\u{201d}里检查一下";
const GROQ_LIMIT: &str = "Groq 的额度暂时用完了，先用 DeepSeek 听写，过一会儿自动换回来";
const GROQ_DOWN: &str = "Groq 暂时用不了，先用 DeepSeek 听写，过一会儿自动换回来";

fn groq(cfg: &Config, wav: &[u8], hint: &str) -> Result<Heard, GroqFail> {
    let part = wav_part(wav).ok_or(GroqFail::Skip)?;
    let mut form = reqwest::blocking::multipart::Form::new()
        .part("file", part)
        .text("model", GROQ_MODEL)
        .text("response_format", "verbose_json")
        .text("temperature", "0");
    if let Some(lang) = cfg.lang() {
        form = form.text("language", lang.to_string());
    }
    if !hint.is_empty() {
        form = form.text("prompt", hint.to_string());
    }
    let resp = client(40)
        .post(GROQ_URL)
        .bearer_auth(cfg.groq_key.trim())
        .multipart(form)
        .send()
        .map_err(|_| GroqFail::Paused(30, GROQ_DOWN))?;
    let code = resp.status().as_u16();
    if !resp.status().is_success() {
        crate::logger::error(&format!("lecture groq: http {code}"));
        return Err(match code {
            401 | 403 => GroqFail::Paused(600, GROQ_KEY_BAD),
            429 => {
                // 它说等多久就等多久，最多一小时
                let wait = resp
                    .headers()
                    .get("retry-after")
                    .and_then(|h| h.to_str().ok())
                    .and_then(|s| s.trim().parse::<f64>().ok())
                    .map(|s| s.ceil() as u64)
                    .unwrap_or(60);
                GroqFail::Paused(wait.clamp(10, 3600), GROQ_LIMIT)
            }
            400 | 413 => GroqFail::Skip,
            _ => GroqFail::Paused(60, GROQ_DOWN),
        });
    }
    let v: serde_json::Value = resp.json().map_err(|_| GroqFail::Paused(30, GROQ_DOWN))?;
    let pieces: Vec<Piece> = v
        .get("segments")
        .and_then(|s| s.as_array())
        .map(|list| {
            let num = |seg: &serde_json::Value, name: &str, or: f64| {
                seg.get(name).and_then(|x| x.as_f64()).unwrap_or(or)
            };
            list.iter()
                .map(|seg| Piece {
                    text: seg
                        .get("text")
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string(),
                    avg_logprob: num(seg, "avg_logprob", 0.0),
                    no_speech_prob: num(seg, "no_speech_prob", 0.0),
                    compression_ratio: num(seg, "compression_ratio", 1.0),
                })
                .collect()
        })
        .unwrap_or_default();
    let (mut text, mut dropped) = if pieces.is_empty() {
        let whole = v.get("text").and_then(|t| t.as_str()).unwrap_or("");
        (whole.trim().to_string(), 0)
    } else {
        pick(&pieces)
    };
    if !text.is_empty() && echoes(&text, hint) {
        text.clear();
        dropped += 1;
    }
    if dropped > 0 {
        crate::logger::info(&format!(
            "lecture groq: dropped {dropped} of {} unclear pieces",
            pieces.len().max(1)
        ));
    }
    Ok(Heard {
        unclear: text.is_empty() && dropped > 0,
        text,
        groq_ms: wav_ms(wav).max(GROQ_MIN_MS),
        ..Heard::default()
    })
}

/// 讲课语言定了是英文这类：去掉中日韩文字，全去掉了就算没听清
fn guard(cfg: &Config, mut heard: Heard) -> Heard {
    if cfg.latin() && !heard.text.is_empty() {
        let (kept, cut) = keep_latin(&heard.text);
        if cut {
            crate::logger::info("lecture asr: dropped text in another language");
            heard.unclear = kept.is_empty();
            heard.text = kept;
        }
    }
    heard
}

/// 听写一段（16 kHz 单声道的 WAV）。hint 是给 Whisper 的提示，DeepSeek 用不上
pub fn transcribe(key: &str, cfg: &Config, wav: &[u8], hint: &str) -> Result<Heard, Fail> {
    let mut note = None;
    if cfg.groq() && !groq_paused() {
        match groq(cfg, wav, hint) {
            Ok(heard) => return Ok(guard(cfg, heard)),
            Err(GroqFail::Skip) => return Err(Fail::Skip(SKIPPED.into())),
            Err(GroqFail::Paused(secs, msg)) => {
                pause_groq(secs);
                note = Some(msg.to_string());
            }
        }
    }
    let mut heard = guard(cfg, deepseek(key, wav)?);
    heard.note = note;
    Ok(heard)
}

/// 试一下 Groq 的密钥
pub fn check_groq_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("先填密钥".into());
    }
    let resp = client(15)
        .get(GROQ_MODELS_URL)
        .bearer_auth(key)
        .send()
        .map_err(|_| "连不上 Groq，请检查网络（在国内可能需要代理）".to_string())?;
    match resp.status().as_u16() {
        200 => Ok(()),
        401 | 403 => Err("密钥不对，请检查有没有复制完整".into()),
        _ => Err("Groq 暂时连不上，稍后再试".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn piece(text: &str, logprob: f64, no_speech: f64, ratio: f64) -> Piece {
        Piece {
            text: text.into(),
            avg_logprob: logprob,
            no_speech_prob: no_speech,
            compression_ratio: ratio,
        }
    }

    #[test]
    fn english_is_untouched() {
        let text = "The Doppler shift is zero because cosine of 90 degrees is zero.";
        assert_eq!(keep_latin(text), (text.to_string(), false));
    }

    #[test]
    fn chinese_made_up_text_is_removed() {
        assert_eq!(
            keep_latin("抖音那个，或者是。 哎，奥古。"),
            (String::new(), true)
        );
        // 零碎的字母也不留
        assert_eq!(
            keep_latin("啊，抽的白六蝴蝶忍NPD抽牌ENTP OC."),
            (String::new(), true)
        );
    }

    #[test]
    fn english_inside_chinese_is_kept() {
        assert_eq!(
            keep_latin("我注意的。Interacting is needed in the life."),
            ("Interacting is needed in the life.".to_string(), true)
        );
        assert_eq!(
            keep_latin("哎，你看这个。The end goal is go to somewhere.啊，对。牛油鸡，很多。"),
            ("The end goal is go to somewhere.".to_string(), true)
        );
        assert_eq!(
            keep_latin(
                "曾经也是 a little bit harder to be. The two languages seem to be the main thing."
            ),
            (
                "a little bit harder to be. The two languages seem to be the main thing."
                    .to_string(),
                true
            )
        );
    }

    #[test]
    fn language_setting_decides_the_guard() {
        let cfg = |language: &str| Config {
            language: language.into(),
            ..Config::default()
        };
        assert!(cfg("en").latin());
        assert!(cfg("it").latin());
        assert!(!cfg("auto").latin());
        assert!(!cfg("").latin());
        assert!(!cfg("zh").latin());
        let heard = Heard {
            text: "抖音那个，或者是。".into(),
            ms: 5000,
            ..Heard::default()
        };
        let out = guard(&cfg("en"), heard);
        assert!(out.unclear && out.text.is_empty() && out.ms == 5000);
        let heard = Heard {
            text: "抖音那个，或者是。".into(),
            ..Heard::default()
        };
        assert!(!guard(&cfg("auto"), heard).unclear);
    }

    #[test]
    fn unsure_pieces_are_dropped() {
        let pieces = [
            piece(" The beam hits the vessel.", -0.2, 0.01, 1.3),
            piece(" Thank you for watching.", -1.4, 0.2, 1.1),
            piece(" at an angle theta.", -0.35, 0.05, 1.2),
            piece(" yes yes yes yes yes yes yes yes", -0.3, 0.1, 3.1),
            piece(" mm", -0.7, 0.8, 0.9),
        ];
        assert_eq!(
            pick(&pieces),
            (
                "The beam hits the vessel. at an angle theta.".to_string(),
                3
            )
        );
        // 口音重、把握不大但还过得去的留着
        assert_eq!(pick(&[piece("So the flow is here.", -0.8, 0.3, 1.2)]).1, 0);
    }

    #[test]
    fn hint_has_course_terms_and_last_words() {
        let terms = vec![
            GTerm {
                en: "aliasing".into(),
                zh: String::new(),
            },
            GTerm {
                en: "Doppler shift".into(),
                zh: "多普勒频移".into(),
            },
        ];
        let h = hint("Medical Ultrasound", &terms, "So the beam is steered.");
        assert_eq!(
            h,
            "Medical Ultrasound. Doppler shift, aliasing. So the beam is steered."
        );
        assert_eq!(hint("", &[], ""), "");
    }

    #[test]
    fn hint_stays_short() {
        let terms: Vec<GTerm> = (0..300)
            .map(|i| GTerm {
                en: format!("term number {i}"),
                zh: String::new(),
            })
            .collect();
        let last = "word ".repeat(200);
        let h = hint("Course", &terms, &last);
        assert!(
            h.chars().count() <= 8 + HINT_TERMS + 2 + HINT_TAIL,
            "{}",
            h.len()
        );
        // 不只是字母表前面的
        assert!(h.contains("term number 2"));
        assert!(h.ends_with("word"));
    }

    #[test]
    fn echo_of_the_hint_is_noticed() {
        let h = "Medical Ultrasound. Doppler shift, aliasing. So the beam is steered.";
        assert!(echoes("So the beam is steered.", h));
        assert!(echoes("Doppler shift, aliasing. So the", h));
        assert!(!echoes("The beam is steered away.", h));
        assert!(!echoes("Doppler shift.", h));
    }
}
