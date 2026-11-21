//! 任务：待办清单，每个任务有预计番茄数和已完成番茄数。
//!
//! 放在 Rust 里，是因为"专注走完给当前任务加 1"要和计时在一起，主窗口关着也照记。
//!
//! 数据存在数据文件夹的 `tasks.json` 里。数据文件夹默认在 `%APPDATA%\com.ingram.ingwork\`，
//! 设置里可以换到 OneDrive 这类同步文件夹，几台电脑共用一份（见 location.rs）。
//!
//! 几台电脑共用时，网盘可能拿别的电脑上的版本把这里的盖掉，两边同时改时还会另存一份冲突副本
//! （OneDrive 起的名字是 `tasks-电脑名.json`）。所以读到别人改过的文件时不直接换掉，而是按任务逐条合并：
//! - 每个任务记着最后修改的时刻，同一个任务两边都改了，用新的那份
//! - 删掉的任务留一个删除记号，免得别的电脑上的旧版本又把它带回来
//! - 只有一边有的任务都留下
//! - 顺序用较晚保存的那份，另一边独有的任务插在它原来的邻居后面
//!
//! 合并的结果和两边的先后无关，几台电脑反复读写最后会停在同一份内容上，不会来回改个没完。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_NAME: usize = 80;
const MAX_ESTIMATE: u32 = 20;
const MAX_TASKS: usize = 200;
/// 删除记号留多久。别的电脑隔这么久都没同步过的话，它上面的旧任务会被带回来
const KEEP_REMOVED_MS: u64 = 60 * 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub name: String,
    /// 预计要几个番茄
    pub estimate: u32,
    /// 已经完成了几个番茄
    #[serde(default)]
    pub spent: u32,
    /// 勾掉了
    #[serde(default)]
    pub finished: bool,
    /// 最后一次修改的时刻（毫秒时间戳）。合并时同一个任务用新的那份
    #[serde(default)]
    pub updated_at: u64,
}

/// 删掉的任务留下的记号
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Removed {
    pub id: String,
    /// 什么时候删的
    pub at: u64,
}

/// 存下来的全部内容，也是发给界面的内容。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Store {
    pub tasks: Vec<Task>,
    /// 当前任务的 id。专注走完时给它加 1
    pub current: Option<String>,
    /// 什么时候选的当前任务。合并时用较晚选的
    pub current_at: u64,
    /// 删掉的任务
    pub removed: Vec<Removed>,
    /// 最后一次保存的时刻。合并时顺序以较晚保存的为准
    pub saved_at: u64,
}

fn clean_name(name: &str) -> Result<String, String> {
    let name: String = name.trim().chars().take(MAX_NAME).collect();
    if name.is_empty() {
        return Err("先写下要做什么".to_string());
    }
    Ok(name)
}

fn clean_estimate(estimate: u32) -> u32 {
    estimate.clamp(1, MAX_ESTIMATE)
}

/// 把已完成的挪到最后，其余先后不变
fn finished_last(tasks: Vec<Task>) -> Vec<Task> {
    let (mut open, done): (Vec<Task>, Vec<Task>) = tasks.into_iter().partition(|t| !t.finished);
    open.extend(done);
    open
}

/// 同一个任务的两份，用哪份：修改时刻晚的；一样晚就按内容定一个，保证两边算出来一样
fn newer<'a>(x: &'a Task, y: &'a Task) -> &'a Task {
    let key = |t: &'a Task| (t.updated_at, t.finished, t.spent, t.estimate, &t.name);
    if key(y) > key(x) {
        y
    } else {
        x
    }
}

/// 两份任务表合成一份。`now` 只用来丢掉太旧的删除记号。
pub fn merge(a: &Store, b: &Store, now: u64) -> Store {
    // 顺序以较晚保存的那份为准；一样晚时按任务数定一个，两边要一致
    let a_first = (a.saved_at, a.tasks.len()) >= (b.saved_at, b.tasks.len());
    let (first, second) = if a_first { (a, b) } else { (b, a) };

    let mut removed: Vec<Removed> = Vec::new();
    for mark in first.removed.iter().chain(second.removed.iter()) {
        if now.saturating_sub(mark.at) > KEEP_REMOVED_MS {
            continue;
        }
        match removed.iter_mut().find(|r| r.id == mark.id) {
            Some(r) => r.at = r.at.max(mark.at),
            None => removed.push(mark.clone()),
        }
    }
    removed.sort_by(|x, y| x.id.cmp(&y.id));

    let mut ids: Vec<&str> = first.tasks.iter().map(|t| t.id.as_str()).collect();
    for (i, task) in second.tasks.iter().enumerate() {
        if ids.contains(&task.id.as_str()) {
            continue;
        }
        // 插在它在另一边的前一个邻居后面；前面的邻居都不在，就放最前
        let at = second.tasks[..i]
            .iter()
            .rev()
            .find_map(|p| ids.iter().position(|id| *id == p.id))
            .map_or(0, |p| p + 1);
        ids.insert(at, task.id.as_str());
    }

    let find = |s: &Store, id: &str| s.tasks.iter().find(|t| t.id == id).cloned();
    let tasks: Vec<Task> = ids
        .iter()
        .filter_map(|id| match (find(first, id), find(second, id)) {
            (Some(x), Some(y)) => Some(newer(&x, &y).clone()),
            (x, y) => x.or(y),
        })
        // 删除记号比任务最后一次修改还晚，才算删掉。删了以后又在别处改过，就留着
        .filter(|t| !removed.iter().any(|r| r.id == t.id && r.at >= t.updated_at))
        .collect();

    let (current, current_at) = if second.current_at > first.current_at {
        (second.current.clone(), second.current_at)
    } else {
        (first.current.clone(), first.current_at)
    };
    let mut store = Store {
        tasks: finished_last(tasks),
        current,
        current_at,
        removed,
        saved_at: first.saved_at.max(second.saved_at),
    };
    store.normalize();
    store
}

impl Store {
    fn find(&mut self, id: &str) -> Result<&mut Task, String> {
        self.tasks
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or_else(|| "这个任务已经不在了".to_string())
    }

    /// 当前任务必须是一个还没勾掉的任务，否则清空。
    fn normalize(&mut self) {
        let valid = match &self.current {
            Some(id) => self.tasks.iter().any(|t| &t.id == id && !t.finished),
            None => true,
        };
        if !valid {
            self.current = None;
        }
    }

    fn add(&mut self, id: String, name: &str, estimate: u32, now: u64) -> Result<(), String> {
        let name = clean_name(name)?;
        if self.tasks.len() >= MAX_TASKS {
            return Err("任务太多了，先清空一些已完成的".to_string());
        }
        // 新任务排在还没完成的任务后面、已完成的前面
        let at = self
            .tasks
            .iter()
            .position(|task| task.finished)
            .unwrap_or(self.tasks.len());
        self.tasks.insert(
            at,
            Task {
                id: id.clone(),
                name,
                estimate: clean_estimate(estimate),
                spent: 0,
                finished: false,
                updated_at: now,
            },
        );
        // 还没有当前任务时，新加的这个就是
        if self.current.is_none() {
            self.current = Some(id);
            self.current_at = now;
        }
        Ok(())
    }

    fn edit(&mut self, id: &str, name: &str, estimate: u32, now: u64) -> Result<(), String> {
        let name = clean_name(name)?;
        let estimate = clean_estimate(estimate);
        let task = self.find(id)?;
        if task.name != name || task.estimate != estimate {
            task.name = name;
            task.estimate = estimate;
            task.updated_at = now;
        }
        Ok(())
    }

    fn set_finished(&mut self, id: &str, finished: bool, now: u64) -> Result<(), String> {
        let task = self.find(id)?;
        if task.finished == finished {
            return Ok(());
        }
        task.finished = finished;
        task.updated_at = now;

        // 勾掉的挪到已完成那一堆的最前面；取消勾选的挪回未完成的最后面
        let from = self.tasks.iter().position(|t| t.id == id).unwrap_or(0);
        let task = self.tasks.remove(from);
        let at = self
            .tasks
            .iter()
            .position(|t| t.finished)
            .unwrap_or(self.tasks.len());
        self.tasks.insert(at, task);

        // 勾掉的是当前任务：当前任务换成下一个还没完成的
        if finished && self.current.as_deref() == Some(id) {
            self.current = self
                .tasks
                .iter()
                .find(|t| !t.finished)
                .map(|t| t.id.clone());
            self.current_at = now;
        }
        Ok(())
    }

    fn set_current(&mut self, id: Option<&str>, now: u64) -> Result<(), String> {
        match id {
            None => self.current = None,
            Some(id) => {
                let task = self.find(id)?;
                if task.finished {
                    return Err("这个任务已经完成了，先取消勾选".to_string());
                }
                self.current = Some(id.to_string());
            }
        }
        self.current_at = now;
        Ok(())
    }

    fn mark_removed(&mut self, id: &str, now: u64) {
        self.removed.retain(|r| r.id != id);
        self.removed.push(Removed {
            id: id.to_string(),
            at: now,
        });
        self.removed.sort_by(|x, y| x.id.cmp(&y.id));
    }

    fn remove(&mut self, id: &str, now: u64) -> Result<(), String> {
        if self.tasks.iter().any(|t| t.id == id) {
            self.tasks.retain(|task| task.id != id);
            self.mark_removed(id, now);
        }
        self.normalize();
        Ok(())
    }

    /// 按给的顺序重排。没提到的任务保持原来的先后，接在后面。
    fn reorder(&mut self, ids: &[String]) -> Result<(), String> {
        let mut rest = std::mem::take(&mut self.tasks);
        let mut ordered = Vec::with_capacity(rest.len());
        for id in ids {
            if let Some(at) = rest.iter().position(|task| &task.id == id) {
                ordered.push(rest.remove(at));
            }
        }
        ordered.append(&mut rest);
        // 无论怎么排，已完成的都在后面
        self.tasks = finished_last(ordered);
        Ok(())
    }

    fn clear_finished(&mut self, now: u64) -> Result<(), String> {
        let done: Vec<String> = self
            .tasks
            .iter()
            .filter(|t| t.finished)
            .map(|t| t.id.clone())
            .collect();
        for id in &done {
            self.mark_removed(id, now);
        }
        self.tasks.retain(|task| !task.finished);
        self.normalize();
        Ok(())
    }

    /// 一段专注走完：给当前任务加一个番茄。没有当前任务时什么都不做，返回假。
    fn add_pomodoro(&mut self, now: u64) -> bool {
        let Some(id) = self.current.clone() else {
            return false;
        };
        match self.tasks.iter_mut().find(|t| t.id == id && !t.finished) {
            Some(task) => {
                task.spent = task.spent.saturating_add(1);
                task.updated_at = now;
                true
            }
            None => false,
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 新任务的 id，写成 36 进制短一些：时刻 + 这台电脑上的序号（同一毫秒加好几个也不撞）
/// + 一点随机数（几台电脑同一毫秒各加一个也不撞）
fn new_id(now: u64) -> String {
    static COUNT: AtomicU32 = AtomicU32::new(0);
    let count = COUNT.fetch_add(1, Ordering::Relaxed) % 1296;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!(
        "t{}{:0>2}{:0>2}",
        base36(now),
        base36(u64::from(count)),
        base36(u64::from(nanos % 1296))
    )
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

// ---------- 读写文件 ----------

/// 锁文件的名字。AI 的接口用的也是它
const LOCK: &str = "tasks.lock";

const SAVE_FAILED: &str = "任务没存下来，请检查数据文件夹还在不在、磁盘有没有满";
const BUSY: &str = "任务文件正被别的程序占着，请再试一次";
const NOT_READY: &str = "任务文件还没从网盘下载下来，请稍后再试";

/// 读文件的结果
enum Disk {
    /// 还没有这个文件
    Missing,
    Ok(Store),
    /// 文件在但读不出来：多半是网盘还没下载完、断网了，或者正被别的程序占着。过一会儿再试
    NotReady,
    /// 读出来了但不是任务表
    Broken,
}

fn read_disk(path: &Path) -> Disk {
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<Store>(&text) {
            Ok(mut store) => {
                store.normalize();
                Disk::Ok(store)
            }
            Err(_) => Disk::Broken,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Disk::Missing,
        Err(_) => Disk::NotReady,
    }
}

/// 文件的样子：修改时刻和大小。和上次看到的不一样，就是别的程序（AI、网盘）改过了
type Sig = Option<(SystemTime, u64)>;

fn sig(path: &Path) -> Sig {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// 先写临时文件再改名，写到一半断电也不会把原来的文件弄坏。
/// 网盘有时正在上传这个文件，改名会被拒，稍等再试。
pub(crate) fn write_atomic(path: &Path, text: &str) -> Result<(), ()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, text).map_err(|_| ())?;
    for attempt in 0..20 {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(_) if attempt < 19 => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Err(())
}

/// OneDrive 这类网盘留下的冲突副本：`tasks-电脑名.json`、`tasks-电脑名-1.json`
fn conflict_copies(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("tasks-") && n.ends_with(".json"))
        })
        .collect();
    found.sort();
    found
}

/// 改 tasks.json 之前先拿到这把锁，免得软件和 AI 的接口（mcp/ingwork-mcp.mjs）同时写。
/// 锁就是一个 tasks.lock 文件：谁先建出来谁拿到，用完删掉。planner.rs 用同样的办法锁 planner.lock。
/// 它总放在本机的文件夹里，不放进网盘：锁只管这台电脑上的程序，同步出去反而会锁住别的电脑。
/// 规则和 mcp/ingwork-mcp.mjs 里的一样，改一边要改另一边。
pub(crate) struct FileLock(PathBuf);

/// 锁文件放了这么久还在，就是上次拿锁的程序没来得及删（比如被强行结束），当它作废
const STALE_LOCK: Duration = Duration::from_secs(10);

impl FileLock {
    pub(crate) fn acquire(dir: &Path, name: &str) -> Option<Self> {
        let _ = std::fs::create_dir_all(dir);
        let path = dir.join(name);
        for _ in 0..80 {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(_) => return Some(Self(path)),
                Err(_) => {
                    let stale = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age > STALE_LOCK);
                    if stale {
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
            }
        }
        None
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

struct Inner {
    store: Store,
    /// 数据文件夹（可能在网盘里）
    dir: PathBuf,
    /// 上一次读或写 tasks.json 时它的样子
    known: Sig,
    /// 上一次读的时候文件还没准备好（网盘没下载完），要接着试
    pending: bool,
}

impl Inner {
    fn new(store: Store, dir: PathBuf) -> Self {
        Self {
            store,
            dir,
            known: None,
            pending: true,
        }
    }

    fn path(&self) -> PathBuf {
        self.dir.join("tasks.json")
    }

    /// 读文件、并上冲突副本、和内存里的合并；有 `apply` 就在合并结果上改。
    /// 结果和文件上的不一样就存回去。返回内存里的任务变没变。调用时要拿着文件锁。
    fn sync<F>(&mut self, apply: Option<F>, now: u64) -> Result<bool, String>
    where
        F: FnOnce(&mut Store, u64) -> Result<(), String>,
    {
        let path = self.path();
        let before = sig(&path);
        let disk = match read_disk(&path) {
            Disk::Ok(store) => store,
            Disk::Missing => Store::default(),
            Disk::NotReady => {
                self.pending = true;
                return if apply.is_some() {
                    Err(NOT_READY.to_string())
                } else {
                    Ok(false)
                };
            }
            Disk::Broken => {
                // 读不懂的文件不删，留一份备份，然后用内存里的内容把它盖掉
                let backup = self.dir.join(format!("tasks.broken-{now}.json"));
                let _ = std::fs::copy(&path, backup);
                Store::default()
            }
        };

        let mut merged = merge(&self.store, &disk, now);
        let mut absorbed = Vec::new();
        for copy in conflict_copies(&self.dir) {
            if let Disk::Ok(other) = read_disk(&copy) {
                merged = merge(&merged, &other, now);
                absorbed.push(copy);
            }
        }
        if let Some(apply) = apply {
            apply(&mut merged, now)?;
        }

        if merged != disk || !absorbed.is_empty() {
            merged.saved_at = now.max(merged.saved_at + 1);
            let text =
                serde_json::to_string_pretty(&merged).map_err(|_| SAVE_FAILED.to_string())?;
            // 读完以后文件又变了（网盘刚下载了新版本）：这次先不写，下一轮再合并
            if sig(&path) != before {
                self.pending = true;
                return Err(BUSY.to_string());
            }
            write_atomic(&path, &text).map_err(|_| SAVE_FAILED.to_string())?;
            for copy in absorbed {
                let _ = std::fs::remove_file(copy);
            }
        }
        self.known = sig(&path);
        self.pending = false;
        let changed = merged != self.store;
        self.store = merged;
        Ok(changed)
    }
}

/// 不改内容、只读文件合并时用的空操作
type NoApply = fn(&mut Store, u64) -> Result<(), String>;

pub struct Tasks {
    inner: Mutex<Inner>,
    /// 本机的文件夹，放锁
    local: PathBuf,
}

impl Tasks {
    /// `dir` 是数据文件夹，`local` 是本机的文件夹（放锁）
    pub fn load(dir: PathBuf, local: PathBuf) -> Self {
        let tasks = Self {
            inner: Mutex::new(Inner::new(Store::default(), dir)),
            local,
        };
        if let Some(_lock) = FileLock::acquire(&tasks.local, LOCK) {
            let _ = tasks.lock().sync(None::<NoApply>, now_ms());
        }
        tasks
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn snapshot(&self) -> Store {
        self.lock().store.clone()
    }

    /// 改一下再存盘。存不下来就不改，并把原因告诉界面，不悄悄失败。
    fn change<F>(&self, apply: F) -> Result<Store, String>
    where
        F: FnOnce(&mut Store, u64) -> Result<(), String>,
    {
        let mut inner = self.lock();
        let _lock = FileLock::acquire(&self.local, LOCK).ok_or_else(|| BUSY.to_string())?;
        inner.sync(Some(apply), now_ms())?;
        Ok(inner.store.clone())
    }

    /// 定时调用：文件被别的程序（AI、网盘）改过，或者有冲突副本，就合并进来，返回新内容。
    pub fn poll(&self) -> Option<Store> {
        // 大多数时候什么都没变，看一眼就返回。看的时候不拿着锁：
        // 网盘里的文件有时要现下载，看一眼也可能要等，别让界面上的操作陪着等
        let (dir, path, known, pending) = {
            let inner = self.lock();
            (inner.dir.clone(), inner.path(), inner.known, inner.pending)
        };
        if !pending && sig(&path) == known && conflict_copies(&dir).is_empty() {
            return None;
        }
        let mut inner = self.lock();
        let _lock = FileLock::acquire(&self.local, LOCK)?;
        match inner.sync(None::<NoApply>, now_ms()) {
            Ok(true) => Some(inner.store.clone()),
            _ => None,
        }
    }

    /// 换数据文件夹。`keep` 为真：把现在的任务带过去，和那边已有的合并；为假：直接用那边的。
    pub fn relocate(&self, dir: PathBuf, keep: bool) -> Result<Store, String> {
        let mut inner = self.lock();
        let _lock = FileLock::acquire(&self.local, LOCK).ok_or_else(|| BUSY.to_string())?;
        let start = if keep {
            inner.store.clone()
        } else {
            Store::default()
        };
        let mut next = Inner::new(start, dir);
        next.sync(None::<NoApply>, now_ms())?;
        *inner = next;
        Ok(inner.store.clone())
    }
}

/// 看一眼某个文件夹里有几个任务（换文件夹之前问用户要不要合并用）。读不出来返回 None。
pub fn count_in(dir: &Path) -> Option<usize> {
    match read_disk(&dir.join("tasks.json")) {
        Disk::Ok(store) => Some(store.tasks.len()),
        Disk::Missing => Some(0),
        Disk::NotReady | Disk::Broken => None,
    }
}

/// 定时调用：AI 或别的电脑改过任务的话，告诉所有窗口。
pub fn poll_external(app: &AppHandle) {
    if let Some(tasks) = app.try_state::<Tasks>() {
        if let Some(store) = tasks.poll() {
            announce(app, &store);
        }
    }
}

pub fn announce(app: &AppHandle, store: &Store) {
    let _ = app.emit("tasks-changed", store);
}

/// 当前任务的名字。统计里记"这段专注是在做什么"用。
pub fn current_name(app: &AppHandle) -> Option<String> {
    let tasks = app.try_state::<Tasks>()?;
    let inner = tasks.lock();
    let id = inner.store.current.as_ref()?;
    inner
        .store
        .tasks
        .iter()
        .find(|task| &task.id == id)
        .map(|task| task.name.clone())
}

/// 一段专注自然走完时调用：给当前任务加一个番茄。
pub fn pomodoro_done(app: &AppHandle) {
    let Some(tasks) = app.try_state::<Tasks>() else {
        return;
    };
    let result = tasks.change(|store, now| {
        store.add_pomodoro(now);
        Ok(())
    });
    if let Ok(store) = result {
        announce(app, &store);
    }
}

/// 加一个任务（杂念箱里的一条转成待办时用）
pub(crate) fn add_task(app: &AppHandle, name: &str, estimate: u32) -> Result<Store, String> {
    let tasks = app
        .try_state::<Tasks>()
        .ok_or_else(|| "任务还没准备好，请再试一次".to_string())?;
    let store = tasks.change(|store, now| store.add(new_id(now), name, estimate, now))?;
    announce(app, &store);
    Ok(store)
}

// 改东西的命令都用 command(async)，放到后台线程跑：它们要读写数据文件夹，还可能等文件锁，
// 文件在网盘里、刚好要现下载时会等上好几秒。不加的话命令在主线程上跑，等的时候整个界面都卡住
#[tauri::command]
pub fn tasks_get(tasks: State<Tasks>) -> Store {
    tasks.snapshot()
}

#[tauri::command(async)]
pub fn task_add(
    app: AppHandle,
    tasks: State<Tasks>,
    name: String,
    estimate: u32,
) -> Result<Store, String> {
    let store = tasks.change(|store, now| store.add(new_id(now), &name, estimate, now))?;
    announce(&app, &store);
    Ok(store)
}

#[tauri::command(async)]
pub fn task_edit(
    app: AppHandle,
    tasks: State<Tasks>,
    id: String,
    name: String,
    estimate: u32,
) -> Result<Store, String> {
    let store = tasks.change(|store, now| store.edit(&id, &name, estimate, now))?;
    announce(&app, &store);
    Ok(store)
}

#[tauri::command(async)]
pub fn task_set_finished(
    app: AppHandle,
    tasks: State<Tasks>,
    id: String,
    finished: bool,
) -> Result<Store, String> {
    let store = tasks.change(|store, now| store.set_finished(&id, finished, now))?;
    announce(&app, &store);
    Ok(store)
}

/// 选当前任务。`id` 为空是不选任何任务。
#[tauri::command(async)]
pub fn task_set_current(
    app: AppHandle,
    tasks: State<Tasks>,
    id: Option<String>,
) -> Result<Store, String> {
    let store = tasks.change(|store, now| store.set_current(id.as_deref(), now))?;
    announce(&app, &store);
    Ok(store)
}

#[tauri::command(async)]
pub fn task_remove(app: AppHandle, tasks: State<Tasks>, id: String) -> Result<Store, String> {
    let store = tasks.change(|store, now| store.remove(&id, now))?;
    announce(&app, &store);
    Ok(store)
}

#[tauri::command(async)]
pub fn tasks_reorder(
    app: AppHandle,
    tasks: State<Tasks>,
    ids: Vec<String>,
) -> Result<Store, String> {
    let store = tasks.change(|store, _| store.reorder(&ids))?;
    announce(&app, &store);
    Ok(store)
}

#[tauri::command(async)]
pub fn tasks_clear_finished(app: AppHandle, tasks: State<Tasks>) -> Result<Store, String> {
    let store = tasks.change(|store, now| store.clear_finished(now))?;
    announce(&app, &store);
    Ok(store)
}
