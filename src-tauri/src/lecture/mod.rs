//! 听课：麦克风录下老师讲的话，交给 DeepSeek 一段一段听写成英文、翻成中文；
//! 听课中每 5 分钟左右整理一次提纲，下课后从头到尾完整整理成笔记。
//!
//! 三条线：
//! - 录音线程：开麦克风，换成 16 kHz（可以先降噪），判断有没有人说话、按停顿切段（audio.rs），
//!   每 0.1 秒把音量发给界面（音量带）。切好的段交给处理线程。
//! - 处理线程：按顺序送去听写（DeepSeek 的语音识别）；断网时攒着，恢复后几段合成一次送。
//!   听写回来去掉和上一段重叠的词、过滤听写幻觉，拼成整句再翻译（stitch.rs，deepseek-flash）。
//! - 整理：每 5 分钟另开一个线程整理一版提纲；下课时处理完最后一段，再完整整理一遍。
//!
//! 录音不存，只存文字：每节课一个文件，放在数据文件夹的 lectures/ 里，几台电脑同步。
//! 状态每变一次就把整份发给界面（lecture-state），界面只管画。

mod audio;
// 命令要用完整路径登记（tauri 的命令宏不跟着 pub use 走），所以这个模块是 pub
pub mod course;
mod glossary;
mod notes;
// 命令要用完整路径登记，所以是 pub
pub mod import;
mod record;
mod redo;
mod source;
mod stitch;

use glossary::Glossary;
use notes::Notes;

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
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
const MODEL: &str = "deepseek-flash";

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

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Idle,
    Listening,
    Paused,
    Finishing,
    Done,
    /// 正在导入录音或视频
    Importing,
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
    /// 上课那台电脑的时区（比 UTC 快多少分钟），给模型看日期、时刻用
    utc_offset_min: i32,
    /// 用了多少：听写时长、字数，用来估算花费
    usage: Usage,
    /// 存了录音的话：每次开始、继续的时刻对应录音里第几个样本（录音文件只在录的那台电脑上）
    audio_marks: Vec<record::Mark>,
    /// 从录音或视频导入的：文件名。时刻显示成"第几分几秒"
    imported: Option<String>,
}

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Usage {
    /// 送去听写的声音有多长（毫秒）
    asr_ms: u64,
    /// 输入里命中缓存的字数（token）
    hit: u64,
    /// 输入里没命中缓存的
    miss: u64,
    /// 输出
    out: u64,
}

impl Usage {
    fn add(&mut self, other: Usage) {
        self.asr_ms += other.asr_ms;
        self.hit += other.hit;
        self.miss += other.miss;
        self.out += other.out;
    }
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
    /// 还没说完、等着凑成整句的半句话
    pending: Option<Pending>,
    /// 说话的声音太小
    quiet: bool,
    /// 这台电脑上有这节课的录音（能回放、能用录音重新整理）
    audio_here: bool,
    /// 正在用录音重新整理：进度 0～100
    redo: Option<u8>,
    /// 正在导入：进度 0～100
    progress: Option<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    at: u64,
    en: String,
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
    /// 切好的一段
    Chunk(audio::Chunk),
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
    pending: Option<Pending>,
    quiet: bool,
    /// 这门课的术语表（课件、以前笔记、生词本）
    glossary: Arc<Glossary>,
    /// 生词本里的词（重新拼术语表时用）
    words: Vec<String>,
    audio_here: bool,
    redo: Option<u8>,
    progress: Option<u8>,
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
            pending: None,
            quiet: false,
            glossary: Arc::new(Glossary::default()),
            words: Vec::new(),
            audio_here: false,
            redo: None,
            progress: None,
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
        pending: inner.pending.clone(),
        quiet: inner.quiet && inner.status == Status::Listening,
        audio_here: inner.audio_here,
        redo: inner.redo,
        progress: inner.progress,
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

/// 录音存在哪：这台电脑的应用数据文件夹，不放进同步的文件夹（太大）
fn audio_path(app: &AppHandle, id: &str) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("lecture-audio")
        .join(format!("{id}.wav"))
}

/// 正在听、正在收尾、正在用录音重新整理：这时候不能换课、删课
fn busy(inner: &Inner) -> bool {
    matches!(
        inner.status,
        Status::Listening | Status::Paused | Status::Finishing | Status::Importing
    ) || inner.redo.is_some()
}

// ---------- 录音 ----------

/// 录音线程：开麦克风，处理成 16 kHz、切段交给处理线程，下课时把最后一段和"下课了"交过去
fn spawn_recorder(
    app: AppHandle,
    generation: u64,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    denoise: bool,
    source: source::Source,
    audio_file: Option<PathBuf>,
    jobs: Sender<Job>,
) -> Result<(), String> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let (stream, samples, rate) = match source::open(source) {
            Ok(v) => {
                let _ = ready_tx.send(Ok(()));
                v
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
                return;
            }
        };
        crate::logger::info(&format!(
            "lecture input: {source:?}, {rate} Hz, denoise {denoise}"
        ));
        let mut pipeline = audio::Pipeline::new(rate, denoise);
        // 要存录音的话边录边写；暂停后继续时记一个标记（时刻 → 录音里第几个样本）
        let mut writer = audio_file.and_then(|path| match record::Writer::create(&path) {
            Ok(w) => Some(w),
            Err(e) => {
                crate::logger::error(&format!("lecture audio file: {e}"));
                None
            }
        });
        if writer.is_some() {
            update(&app, generation, |inner| inner.audio_here = true);
        }
        let mut need_mark = true;
        let mut cutter = audio::Cutter::new(audio::detector());
        let mut out = Vec::new();
        let mut was_paused = false;
        let mut quiet_at = Instant::now();
        let mut send_chunk = |chunk: audio::Chunk| {
            if update(&app, generation, |inner| inner.queued += 1) {
                let _ = jobs.send(Job::Chunk(chunk));
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
                need_mark = true;
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
                        out.clear();
                        pipeline.push(&block, &mut out);
                        let now = now_ms();
                        if let Some(w) = writer.as_mut() {
                            if need_mark && !out.is_empty() {
                                need_mark = false;
                                let mark = record::Mark {
                                    at: now.saturating_sub(
                                        out.len() as u64 * 1000 / audio::RATE as u64,
                                    ),
                                    sample: w.samples,
                                };
                                update(&app, generation, |inner| inner.s.audio_marks.push(mark));
                            }
                            if let Err(e) = w.push(&out) {
                                crate::logger::error(&format!("lecture audio write: {e}"));
                                writer = None;
                            }
                        }
                        cutter.push(&out, now, &mut on_level, &mut send_chunk);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        drop(stream);
        if let Some(w) = writer {
            if let Err(e) = w.finish() {
                crate::logger::error(&format!("lecture audio finish: {e}"));
            }
        }
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
        // 地址或模型名不认了：一直重试也没用，直接说
        404 | 410 | 422 => Fail::Skip(
            "DeepSeek 不认这个请求了，可能是接口有变化，请看看 ingwork 有没有新版本".into(),
        ),
        400 | 413 => Fail::Skip("有一段声音没听写出来，跳过了".into()),
        _ => Fail::Later("DeepSeek 暂时连不上，录下来的先攒着，连上了会自动补上".into()),
    }
}

/// 听写一段：返回文字和这段声音的时长（毫秒）
fn transcribe(key: &str, wav: &[u8]) -> Result<(String, u64), Fail> {
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
    let text = v
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    // 接口没给时长就按 WAV 的大小算（16 kHz、16 位：每毫秒 32 字节）
    let ms = v
        .get("duration_ms")
        .and_then(|d| d.as_u64())
        .unwrap_or((wav.len().saturating_sub(44) / 32) as u64);
    Ok((text, ms))
}

/// DeepSeek 实际用的是哪个模型：变了就记一笔日志，方便查问题
fn note_model(v: &serde_json::Value) {
    static LAST: Mutex<String> = Mutex::new(String::new());
    let Some(model) = v.get("model").and_then(|m| m.as_str()) else {
        return;
    };
    let mut last = lock(&LAST);
    if *last != model {
        crate::logger::info(&format!("lecture model: {model}"));
        *last = model.to_string();
    }
}

fn usage_of(v: &serde_json::Value) -> Usage {
    let n = |name: &str| {
        v.pointer(&format!("/usage/{name}"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0)
    };
    let hit = n("prompt_cache_hit_tokens");
    let miss = match n("prompt_cache_miss_tokens") {
        0 => n("prompt_tokens").saturating_sub(hit),
        m => m,
    };
    Usage {
        asr_ms: 0,
        hit,
        miss,
        out: n("completion_tokens"),
    }
}

fn chat(
    key: &str,
    system: &str,
    user: &str,
    json: bool,
    timeout: u64,
) -> Result<(String, Usage), Fail> {
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
        // 笔记可能挺长，别被默认的输出上限截断
        body["max_tokens"] = serde_json::json!(8192);
    }
    let resp = client(timeout)
        .post(CHAT_URL)
        .bearer_auth(key)
        .json(&body)
        .send()
        .map_err(|_| Fail::Later("DeepSeek 暂时连不上，连上了会接着翻译和整理".into()))?;
    if !resp.status().is_success() {
        return Err(match resp.status().as_u16() {
            400 => Fail::Skip("DeepSeek 不接受这次请求，跳过了".into()),
            code => status_fail(code),
        });
    }
    let v: serde_json::Value = resp
        .json()
        .map_err(|_| Fail::Later("DeepSeek 回来的内容读不懂，稍后再试".into()))?;
    note_model(&v);
    let text = v
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok((text, usage_of(&v)))
}

const TRANSLATE_PROMPT: &str =
    "你是大学课堂的同声传译。把老师刚说的这一段英文翻成自然、准确的简体中文，像中文老师在讲课。\
专业术语第一次出现时，在中文后面用括号保留英文原词。\
这段话是按停顿切出来的，开头结尾可能不完整：按意思翻，不要补充、不要解释。\
\u{201c}前文\u{201d}只是帮你理解上下文的，不要翻译它。只输出这一段的译文。";

fn translate(
    key: &str,
    glossary: &str,
    context: &[Segment],
    en: &str,
) -> Result<(String, Usage), Fail> {
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
    // 说明和术语表放在最前面：每次都一样，能吃到缓存
    let system = format!("{TRANSLATE_PROMPT}{glossary}");
    chat(key, &system, &user, false, 45)
}

/// 整理一遍：成功返回笔记。
/// 听课中有上一版笔记的话，只给新增的听写让模型合并；下课后用完整的听写稿从头整理
fn summarize(
    key: &str,
    glossary: &str,
    session: &Session,
    previous: Option<(Notes, usize)>,
    final_pass: bool,
) -> Result<(Notes, Usage), Fail> {
    let off = session.utc_offset_min;
    let date = notes::local_date(session.started_at.unwrap_or_else(now_ms), off);
    let previous = if final_pass { None } else { previous };
    let from = previous
        .as_ref()
        .map(|(_, upto)| (*upto).min(session.segments.len()))
        .unwrap_or(0);
    // 导入的录音按"第几分几秒"标时刻
    let base = session.imported.as_ref().and(session.started_at);
    let lines = notes::transcript(
        session.segments[from..]
            .iter()
            .map(|s| (s.id, s.at, s.en.as_str())),
        off,
        base,
    );
    let (system, user) = notes::request(
        glossary,
        &session.course,
        &date,
        previous.as_ref().map(|(n, _)| n),
        &lines,
        final_pass,
    );
    let (out, usage) = chat(key, &system, &user, true, 240)?;
    let mut valid: Vec<u64> = session.segments.iter().map(|s| s.id).collect();
    valid.sort_unstable();
    let notes = notes::parse(&out, &date, &valid)
        .ok_or_else(|| Fail::Later("笔记没整理出来，稍后再试".into()))?;
    Ok((notes, usage))
}

/// 另开一个线程整理（听课中的提纲、或者下课后的完整整理）
fn spawn_summary(app: AppHandle, generation: u64, final_pass: bool) {
    let snapshot = {
        let mut inner = lock(&app.state::<Lecture>().inner().0);
        if inner.generation != generation || inner.summarizing {
            return;
        }
        inner.summarizing = true;
        // 上一版笔记和它整理到第几句：听课中只把新增的给模型合并
        let previous = match (&inner.s.notes, inner.notes_upto) {
            (Some(n), upto) if upto > 0 => Some((n.clone(), upto)),
            _ => None,
        };
        (
            inner.key.clone(),
            inner.glossary.prompt_block(),
            inner.s.clone(),
            previous,
        )
    };
    publish(&app);
    std::thread::spawn(move || {
        let (key, glossary, session, previous) = snapshot;
        let count = session.segments.len();
        let result = summarize(&key, &glossary, &session, previous, final_pass);
        let ok = update(&app, generation, |inner| {
            inner.summarizing = false;
            // 草稿回来时已经下课了：以完整整理的为准，草稿扔掉
            let stale = !final_pass && matches!(inner.status, Status::Finishing | Status::Done);
            if let Ok((_, usage)) = &result {
                inner.s.usage.add(*usage);
            }
            match result {
                Ok((notes, _)) if !stale => {
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

/// 一次最多合并多少秒送去听写（接口上限 120 秒）
const MERGE_MAX_SAMPLES: usize = audio::RATE as usize * 110;

/// 把一句话加进左边、翻译好；返回要不要顺便整理一版提纲
fn emit_sentence(
    app: &AppHandle,
    generation: u64,
    key: &str,
    glossary: &str,
    id: u64,
    at: u64,
    en: String,
) -> bool {
    let mut context = Vec::new();
    let alive = update(app, generation, |inner| {
        let n = inner.s.segments.len();
        context = inner.s.segments[n.saturating_sub(3)..].to_vec();
        inner.s.segments.push(Segment {
            id,
            at,
            en: en.clone(),
            zh: None,
        });
    });
    if !alive {
        return false;
    }
    // 翻译：失败两次就留空，界面上写"没翻译出来"，不卡住后面的
    let mut zh = String::new();
    let mut spent = Usage::default();
    let mut failed = None;
    for attempt in 0..2 {
        match translate(key, glossary, &context, &en) {
            Ok((out, usage)) => {
                zh = out;
                spent = usage;
                failed = None;
                break;
            }
            // 请求本身不被接受：再试也一样
            Err(Fail::Skip(msg)) => {
                failed = Some(msg);
                break;
            }
            Err(Fail::Later(msg)) => {
                failed = Some(msg);
                if attempt == 0 {
                    std::thread::sleep(Duration::from_secs(2));
                }
            }
        }
    }
    let mut due = false;
    update(app, generation, |inner| {
        inner.s.usage.add(spent);
        if let Some(msg) = failed {
            inner.error = Some(msg);
        }
        if let Some(seg) = inner.s.segments.iter_mut().find(|s| s.id == id) {
            seg.zh = Some(zh);
        }
        due = inner.status == Status::Listening
            && inner.next_notes_at.is_some_and(|t| now_ms() >= t)
            && inner.s.segments.len() > inner.notes_upto
            && !inner.summarizing;
    });
    due
}

fn spawn_worker(app: AppHandle, generation: u64, jobs: Receiver<Job>) {
    std::thread::spawn(move || {
        let mut queue: VecDeque<audio::Chunk> = VecDeque::new();
        let mut finishing = false;
        let mut assembler = stitch::Assembler::default();
        // 上一段听写出来的字（去重叠、过滤重复用）
        let mut last_text = String::new();
        let mut next_id: u64 = 1;
        let mut saved_at = 0usize;
        let mut wait = 2u64;
        loop {
            // 收新的段：手上没活就最多等 1 秒（顺便看看半句话是不是等太久了）
            let first = if queue.is_empty() && !finishing {
                jobs.recv_timeout(Duration::from_secs(1))
            } else {
                jobs.try_recv().map_err(|e| match e {
                    mpsc::TryRecvError::Empty => RecvTimeoutError::Timeout,
                    mpsc::TryRecvError::Disconnected => RecvTimeoutError::Disconnected,
                })
            };
            let mut incoming = match first {
                Ok(job) => vec![job],
                Err(RecvTimeoutError::Timeout) => Vec::new(),
                Err(RecvTimeoutError::Disconnected) => {
                    finishing = true;
                    Vec::new()
                }
            };
            while let Ok(job) = jobs.try_recv() {
                incoming.push(job);
            }
            for job in incoming {
                match job {
                    Job::Chunk(chunk) => queue.push_back(chunk),
                    Job::Finish => finishing = true,
                }
            }
            let (key, glossary) = {
                let inner = lock(&app.state::<Lecture>().inner().0);
                if inner.generation != generation {
                    return;
                }
                (inner.key.clone(), inner.glossary.clone())
            };
            let block = glossary.prompt_block();

            if queue.is_empty() {
                // 半句话等太久，或者下课了：不等了
                if assembler.stale(now_ms()) || finishing {
                    if let Some((at, en)) = assembler.flush() {
                        update(&app, generation, |inner| inner.pending = None);
                        let id = next_id;
                        next_id += 1;
                        if emit_sentence(&app, generation, &key, &block, id, at, en) {
                            spawn_summary(app.clone(), generation, false);
                        }
                    }
                }
                if finishing {
                    break;
                }
                continue;
            }

            // 排着好几段（断网刚恢复）：合成一次送去听写，少发请求、追得快
            let mut merged: Vec<f32> = queue[0].samples.clone();
            let mut count = 1;
            while count < queue.len()
                && merged.len() + queue[count].samples.len() - queue[count].overlap
                    <= MERGE_MAX_SAMPLES
            {
                merged.extend_from_slice(&queue[count].samples[queue[count].overlap..]);
                count += 1;
            }
            let at = queue[0].at;
            let overlap = queue[0].overlap > 0;
            let quiet = queue.iter().take(count).any(|c| c.quiet);

            let heard = match transcribe(&key, &audio::wav(&merged)) {
                Ok((text, ms)) => {
                    wait = 2;
                    Some((text, ms))
                }
                Err(Fail::Skip(msg)) => {
                    update(&app, generation, |inner| inner.error = Some(msg));
                    None
                }
                Err(Fail::Later(msg)) => {
                    // 送不出去：这几段先留着，隔一会儿再试，那时候可能又多攒了几段，一起送
                    if !update(&app, generation, |inner| {
                        inner.error = Some(msg);
                        inner.retrying = true;
                    }) {
                        return;
                    }
                    std::thread::sleep(Duration::from_secs(wait));
                    wait = (wait * 2).min(30);
                    continue;
                }
            };
            queue.drain(..count);
            let mut text = heard.as_ref().map(|(t, _)| t.clone()).unwrap_or_default();
            if overlap && !text.is_empty() {
                text = stitch::dedupe(&last_text, &text);
            }
            // 听错的专业词按术语表改过来
            text = glossary.correct(&text);
            let keep = !stitch::is_noise(&text, &last_text);
            if keep {
                last_text = text.clone();
            }
            let sentence = if keep {
                assembler.push(&text, at, now_ms())
            } else {
                None
            };
            let pending = assembler.pending().map(|(at, en)| Pending { at, en });
            let alive = update(&app, generation, |inner| {
                if let Some((_, ms)) = &heard {
                    inner.s.usage.asr_ms += ms;
                }
                inner.queued = inner.queued.saturating_sub(count);
                inner.retrying = false;
                inner.quiet = quiet;
                if inner.error.as_deref().is_some_and(|e| {
                    e.contains("连不上") || e.contains("余额") || e.contains("密钥")
                }) {
                    inner.error = None;
                }
                inner.pending = pending;
            });
            if !alive {
                return;
            }
            if let Some((at, en)) = sentence {
                let id = next_id;
                next_id += 1;
                if emit_sentence(&app, generation, &key, &block, id, at, en) {
                    spawn_summary(app.clone(), generation, false);
                }
            }
            // 隔几句存一次，中途关掉软件也丢不了多少
            let count = lock(&app.state::<Lecture>().inner().0).s.segments.len();
            if count >= saved_at + 6 {
                saved_at = count;
                save_current(&app, generation);
            }
        }

        // 下课：存一下，再完整整理
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
    utc_offset_min: Option<i32>,
    denoise: Option<bool>,
    words: Option<Vec<String>>,
    save_audio: Option<bool>,
    source: Option<String>,
) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("先在设置的\u{201c}听课\u{201d}里填 DeepSeek 密钥".into());
    }
    let course = course.trim().chars().take(80).collect::<String>();
    if course.is_empty() {
        return Err("写一个课名".into());
    }
    // 这门课的术语表：课件、以前的笔记、生词本
    let words: Vec<String> = words.unwrap_or_default().into_iter().take(500).collect();
    let glossary = Arc::new(course::glossary_for(
        &app,
        &course,
        course_id.as_deref(),
        &words,
    ));
    let (generation, stop, paused, tx, audio_file) = {
        let mut inner = lock(&lecture.0);
        if busy(&inner) {
            return Err("正在听一节课，先结束它".into());
        }
        let generation = inner.generation + 1;
        let now = now_ms();
        let audio_file = save_audio
            .unwrap_or(false)
            .then(|| audio_path(&app, &format!("{now}")));
        let stop = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        *inner = Inner {
            status: Status::Listening,
            s: Session {
                id: Some(format!("{now}")),
                course,
                course_id,
                started_at: Some(now),
                utc_offset_min: utc_offset_min.unwrap_or(0).clamp(-14 * 60, 14 * 60),
                ..Session::default()
            },
            key,
            generation,
            listening_since: Some(now),
            next_notes_at: Some(now + NOTES_EVERY.as_millis() as u64),
            glossary,
            words,
            stop: Some(stop.clone()),
            paused: paused.clone(),
            ..Inner::default()
        };
        let (tx, rx) = mpsc::channel::<Job>();
        spawn_worker(app.clone(), generation, rx);
        (generation, stop, paused, tx, audio_file)
    };
    if let Err(e) = spawn_recorder(
        app.clone(),
        generation,
        stop,
        paused,
        denoise.unwrap_or(false),
        source::Source::parse(source.as_deref()),
        audio_file,
        tx,
    ) {
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
        if inner.status == Status::Importing {
            // 导入停下：已经读到的照样翻译、整理
            if let Some(stop) = inner.stop.take() {
                stop.store(true, Ordering::SeqCst);
            }
            drop(inner);
            publish(&app);
            return;
        }
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
        if busy(&inner) {
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
        if inner.status != Status::Done || inner.s.segments.is_empty() || inner.redo.is_some() {
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
        if busy(&inner) {
            return Err("正在听一节课，先结束它再看以前的".into());
        }
        let generation = inner.generation + 1;
        let key = inner.key.clone();
        let audio_here = !session.audio_marks.is_empty() && audio_path(&app, id).exists();
        *inner = Inner {
            status: Status::Done,
            s: session,
            key,
            generation,
            audio_here,
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
            if busy(&inner) {
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
    // 录音也一起删
    let _ = std::fs::remove_file(audio_path(&app, &id));
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

/// 下课后用录音重新整理一遍（只在录了音的那台电脑上能用）
#[tauri::command]
pub fn lecture_redo(app: AppHandle, lecture: State<Lecture>, key: String) -> Result<(), String> {
    let generation = {
        let mut inner = lock(&lecture.0);
        if inner.status != Status::Done || busy(&inner) || inner.summarizing {
            return Err("现在不能重新整理，等手上这件事做完".into());
        }
        if !inner.audio_here {
            return Err("这台电脑上没有这节课的录音".into());
        }
        if !key.trim().is_empty() {
            inner.key = key.trim().to_string();
        }
        inner.redo = Some(0);
        inner.error = None;
        inner.generation
    };
    publish(&app);
    redo::spawn(app, generation);
    Ok(())
}

/// 回放一句原声：给出这一段的 WAV（最多 30 秒）
#[tauri::command(async)]
pub fn lecture_clip(
    app: AppHandle,
    lecture: State<'_, Lecture>,
    id: String,
    from: u64,
    to: u64,
) -> Result<tauri::ipc::Response, String> {
    let id = safe_id(&id)?.to_string();
    let marks = {
        let inner = lock(&lecture.0);
        if inner.s.id.as_deref() == Some(id.as_str()) {
            inner.s.audio_marks.clone()
        } else {
            std::fs::read_to_string(folder(&app).join(format!("{id}.json")))
                .ok()
                .and_then(|t| serde_json::from_str::<Session>(&t).ok())
                .map(|s| s.audio_marks)
                .unwrap_or_default()
        }
    };
    let path = audio_path(&app, &id);
    let total = record::length(&path).ok_or_else(|| "这台电脑上没有这节课的录音".to_string())?;
    // 往前多放 0.3 秒，免得第一个字被切掉
    let start = record::sample_at(&marks, from.saturating_sub(300))
        .ok_or_else(|| "这一句没有录音".to_string())?;
    let end = record::sample_at(&marks, to)
        .unwrap_or(start)
        .clamp(start + 8_000, start + 30 * audio::RATE as u64)
        .min(total);
    if start >= end {
        return Err("这一句没有录音".into());
    }
    let samples =
        record::read(&path, start, end).map_err(|_| "录音读不出来，文件可能坏了".to_string())?;
    Ok(tauri::ipc::Response::new(audio::wav(&samples)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert!(safe_id("1795000000000").is_ok());
        assert!(safe_id("../x").is_err());
    }
}
