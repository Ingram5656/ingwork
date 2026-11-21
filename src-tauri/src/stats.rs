//! 专注记录：每段专注记一条，统计面板用它算每天、每周的时长和连续打卡。
//!
//! 记在数据文件夹里，一行一条，只往后追加。哪条记录算在哪一天要看本地时区，这件事交给界面去算，这里只记时刻。
//!
//! 数据文件夹可能在 OneDrive 这类网盘里、几台电脑共用，所以每台电脑只往自己的文件里写
//! （`history-电脑名.jsonl`），读的时候把文件夹里所有的记录文件加在一起。
//! 这样几台电脑同时记也不会互相盖掉；网盘万一生成了冲突副本，它也是 `history-*.jsonl`，
//! 一起读进来，重复的记录去掉就好。

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

/// 中途停下的专注，不到这么久就不记了（点了开始马上又停的那种）。
const MIN_PARTIAL_MS: u64 = 60_000;
/// 旧版本只有这一个文件。打开时把它并进这台电脑自己的文件里
const LEGACY: &str = "history.jsonl";

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Record {
    /// 这段专注结束的时刻（毫秒时间戳）
    pub t: u64,
    /// 实际专注了多久（毫秒）
    pub ms: u64,
    /// 真：走完了整段，算一个番茄；假：中途停下，只算时长
    pub done: bool,
    /// 当时的当前任务名
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
}

/// 这条记录该不该记：走完的都记；中途停下的要够一分钟。
fn worth_keeping(ms: u64, done: bool) -> bool {
    done || ms >= MIN_PARTIAL_MS
}

/// 把文件内容读成记录。读不懂的行跳过，不影响其他行。
fn parse(text: &str) -> Vec<Record> {
    text.lines()
        .filter_map(|line| serde_json::from_str::<Record>(line.trim()).ok())
        .collect()
}

/// 按时间排好，去掉重复的（冲突副本、合并文件夹时会有重复）
fn tidy(mut records: Vec<Record>) -> Vec<Record> {
    records.sort();
    records.dedup();
    records
}

/// 电脑名。Windows 从环境变量读；Mac 读网络上用的那个名字（"Ingrams-MacBook-Pro" 这种，都是英文字母）。
/// Mac 上要另起一个系统命令去读，读一次就记住，不每记一次专注都读一遍
fn computer_name() -> String {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        if let Ok(name) = std::env::var("COMPUTERNAME") {
            return name;
        }
        #[cfg(target_os = "macos")]
        if let Ok(out) = std::process::Command::new("scutil")
            .args(["--get", "LocalHostName"])
            .output()
        {
            return String::from_utf8_lossy(&out.stdout).trim().to_string();
        }
        String::new()
    })
    .clone()
}

/// 这台电脑自己的记录文件名。电脑名里只留字母数字，免得有文件名不能用的字符
pub fn own_file_name() -> String {
    let raw = computer_name();
    let name: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(40)
        .collect();
    // 电脑名全是中文之类的：用名字算一个编号，几台这样的电脑也不会撞到同一个文件
    let name = if name.is_empty() {
        let hash = raw.bytes().fold(0x811c_9dc5_u32, |h, b| {
            (h ^ u32::from(b)).wrapping_mul(0x0100_0193)
        });
        format!("pc{:08x}", hash)
    } else {
        name.to_lowercase()
    };
    format!("history-{name}.jsonl")
}

fn is_history(name: &str) -> bool {
    name == LEGACY || (name.starts_with("history-") && name.ends_with(".jsonl"))
}

/// 文件夹里所有记录文件，按名字排好，带上修改时刻和大小（看有没有变）
fn history_files(dir: &Path) -> Vec<(PathBuf, Option<(SystemTime, u64)>)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_str().is_some_and(is_history))
        .map(|e| {
            let sig = e
                .metadata()
                .ok()
                .and_then(|m| Some((m.modified().ok()?, m.len())));
            (e.path(), sig)
        })
        .collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}

/// 往文件末尾追加几条
fn append_lines(path: &Path, records: &[Record]) -> Result<(), ()> {
    if records.is_empty() {
        return Ok(());
    }
    let mut text = String::new();
    for record in records {
        text.push_str(&serde_json::to_string(record).map_err(|_| ())?);
        text.push('\n');
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|_| ())?;
    file.write_all(text.as_bytes()).map_err(|_| ())
}

/// 把 `from` 里的记录并进 `to`：`to` 里已经有的不重复写
fn union_into(from: &Path, to: &Path) -> Result<(), ()> {
    let incoming = parse(&std::fs::read_to_string(from).map_err(|_| ())?);
    let existing = match std::fs::read_to_string(to) {
        Ok(text) => parse(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(_) => return Err(()),
    };
    let missing: Vec<Record> = tidy(incoming)
        .into_iter()
        .filter(|r| !existing.contains(r))
        .collect();
    append_lines(to, &missing)
}

/// 旧版本的 history.jsonl 并进这台电脑自己的文件，然后删掉
fn migrate_legacy(dir: &Path) {
    let legacy = dir.join(LEGACY);
    if legacy.exists() && union_into(&legacy, &dir.join(own_file_name())).is_ok() {
        let _ = std::fs::remove_file(legacy);
    }
}

/// 发给界面的内容。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsView {
    pub records: Vec<Record>,
    /// 最近有记录没存进文件（多半是磁盘满了），界面要告诉用户
    pub save_failed: bool,
}

struct Inner {
    dir: PathBuf,
    records: Vec<Record>,
    /// 没写进文件的记录。这次运行期间还留在内存里，界面照样算进去
    unsaved: Vec<Record>,
    /// 上次读的时候文件夹里记录文件的样子
    seen: Vec<(PathBuf, Option<(SystemTime, u64)>)>,
    /// 上次有文件没读出来（网盘还没下载完），要接着试
    pending: bool,
}

impl Inner {
    fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            records: Vec::new(),
            unsaved: Vec::new(),
            seen: Vec::new(),
            pending: true,
        }
    }

    /// 把文件夹里所有记录文件读一遍。返回记录变没变
    fn reload(&mut self) -> bool {
        let files = history_files(&self.dir);
        let mut all = self.unsaved.clone();
        let mut pending = false;
        for (path, _) in &files {
            match std::fs::read_to_string(path) {
                Ok(text) => all.extend(parse(&text)),
                Err(_) => pending = true,
            }
        }
        self.seen = files;
        self.pending = pending;
        let all = tidy(all);
        let changed = all != self.records;
        self.records = all;
        changed
    }
}

pub struct Stats {
    inner: Mutex<Inner>,
    save_failed: AtomicBool,
}

impl Stats {
    pub fn load(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        migrate_legacy(&dir);
        let mut inner = Inner::new(dir);
        inner.reload();
        Self {
            inner: Mutex::new(inner),
            save_failed: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn view(&self) -> StatsView {
        StatsView {
            records: self.lock().records.clone(),
            save_failed: self.save_failed.load(Ordering::SeqCst),
        }
    }

    /// 追加一条。写文件失败时记录仍然留在内存里（这次运行期间还看得到），并记下"没存上"。
    fn append(&self, record: Record) {
        let mut inner = self.lock();
        let path = inner.dir.join(own_file_name());
        // 之前没写进去的这次一起补上
        let mut batch = std::mem::take(&mut inner.unsaved);
        batch.push(record);
        let written = append_lines(&path, &batch);
        if written.is_err() {
            inner.unsaved = batch;
        }
        self.save_failed.store(written.is_err(), Ordering::SeqCst);
        inner.reload();
    }

    /// 定时调用：别的电脑记了新的（网盘同步过来了），或者清空了，就重新读，返回新内容
    fn poll(&self) -> Option<StatsView> {
        // 先不拿锁看一眼文件夹：网盘里看一眼也可能要等，别让记专注、看统计陪着等
        let (dir, pending) = {
            let inner = self.lock();
            (inner.dir.clone(), inner.pending)
        };
        let files = history_files(&dir);
        let changed = {
            let mut inner = self.lock();
            if !pending && inner.dir == dir && files == inner.seen {
                return None;
            }
            inner.reload()
        };
        changed.then(|| self.view())
    }

    /// 清空全部记录。数据文件夹是几台电脑共用的话，所有电脑的记录都会清掉
    fn clear(&self) -> Result<(), String> {
        let mut inner = self.lock();
        for (path, _) in history_files(&inner.dir) {
            std::fs::remove_file(path).map_err(|_| "记录没清掉，请再试一次".to_string())?;
        }
        inner.unsaved.clear();
        inner.reload();
        self.save_failed.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// 换数据文件夹。`keep` 为真：把这边的记录文件并过去；为假：直接用那边的
    pub fn relocate(&self, dir: PathBuf, keep: bool) -> Result<(), String> {
        let mut inner = self.lock();
        let _ = std::fs::create_dir_all(&dir);
        if keep {
            for (path, _) in history_files(&inner.dir) {
                let Some(name) = path.file_name() else {
                    continue;
                };
                let target = if name == LEGACY {
                    dir.join(own_file_name())
                } else {
                    dir.join(name)
                };
                union_into(&path, &target)
                    .map_err(|_| "专注记录没能搬过去，请检查那个文件夹能不能写".to_string())?;
            }
        }
        migrate_legacy(&dir);
        let mut next = Inner::new(dir);
        next.unsaved = std::mem::take(&mut inner.unsaved);
        next.reload();
        *inner = next;
        Ok(())
    }
}

/// 某个文件夹里有几条专注记录（换文件夹之前问用户要不要合并用）
pub fn count_in(dir: &Path) -> usize {
    let mut all = Vec::new();
    for (path, _) in history_files(dir) {
        if let Ok(text) = std::fs::read_to_string(path) {
            all.extend(parse(&text));
        }
    }
    tidy(all).len()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 记一段专注。`done` 为真是走完了整段，为假是中途停下（跳过、重置、切阶段、退出）。
pub fn record(app: &AppHandle, ms: u64, done: bool) {
    if !worth_keeping(ms, done) {
        return;
    }
    let Some(stats) = app.try_state::<Stats>() else {
        return;
    };
    stats.append(Record {
        t: now_ms(),
        ms,
        done,
        task: crate::tasks::current_name(app),
    });
    announce(app);
}

pub fn announce(app: &AppHandle) {
    if let Some(stats) = app.try_state::<Stats>() {
        let _ = app.emit("stats-changed", stats.view());
    }
}

/// 定时调用：别的电脑的记录同步过来了，告诉所有窗口
pub fn poll_external(app: &AppHandle) {
    if let Some(stats) = app.try_state::<Stats>() {
        if let Some(view) = stats.poll() {
            let _ = app.emit("stats-changed", view);
        }
    }
}

#[tauri::command]
pub fn stats_get(stats: State<Stats>) -> StatsView {
    stats.view()
}

// 改东西的命令都用 command(async)，放到后台线程跑：它们要读写数据文件夹，还可能等文件锁，
// 文件在网盘里、刚好要现下载时会等上好几秒。不加的话命令在主线程上跑，等的时候整个界面都卡住
/// 备份用：全部专注记录（各台电脑的都在）
pub fn export_records(app: &AppHandle) -> Vec<Record> {
    app.try_state::<Stats>()
        .map(|stats| stats.lock().records.clone())
        .unwrap_or_default()
}

/// 从备份恢复：已经有的记录跳过，没有的写进一个单独的文件（history-backup.jsonl）。返回补了几条
pub fn import_records(app: &AppHandle, incoming: &[Record]) -> Result<usize, String> {
    let Some(stats) = app.try_state::<Stats>() else {
        return Ok(0);
    };
    let count = {
        let mut inner = stats.lock();
        let fresh: Vec<Record> = tidy(incoming.to_vec())
            .into_iter()
            .filter(|r| inner.records.binary_search(r).is_err())
            .collect();
        append_lines(&inner.dir.join("history-backup.jsonl"), &fresh)
            .map_err(|_| "专注记录没能恢复，请检查数据文件夹能不能写".to_string())?;
        inner.reload();
        fresh.len()
    };
    if count > 0 {
        announce(app);
    }
    Ok(count)
}

/// 清空全部记录
#[tauri::command(async)]
pub fn stats_clear(app: AppHandle, stats: State<Stats>) -> Result<StatsView, String> {
    stats.clear()?;
    let view = stats.view();
    let _ = app.emit("stats-changed", view.clone());
    Ok(view)
}
