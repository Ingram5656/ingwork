//! 计划：课表、截止日期、杂念箱、生词本。
//!
//! 和任务一样存在数据文件夹里（`planner.json`），数据文件夹换到网盘里时几台电脑共用一份。
//! 合并的办法也一样：每一条记着最后修改的时刻，删掉的留一个删除记号，网盘的冲突副本（`planner-电脑名.json`）读进来合并后删掉。
//! 合并的规则在 logic.rs 里，带测试。
//!
//! 课表的一节课是"每隔几周的星期几、几点到几点"，从哪天上到哪天，中间有几天不上。
//! 学校导出的 .ics 文件在界面里解析成这个样子再发过来（src/lib/ics.ts），这里不认识 .ics。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::logic::{merge_entries, merge_removed, Entry};
use crate::tasks::{write_atomic, FileLock};

const FILE: &str = "planner.json";
const LOCK: &str = "planner.lock";
/// 删除记号留多久（和任务一样是 60 天）
const KEEP_REMOVED_MS: u64 = 60 * 24 * 60 * 60 * 1000;

const MAX_COURSES: usize = 300;
const MAX_DEADLINES: usize = 200;
const MAX_NOTES: usize = 300;
const MAX_WORDS: usize = 3000;

const SAVE_FAILED: &str = "没存下来，请检查数据文件夹还在不在、磁盘有没有满";
const BUSY: &str = "数据文件正被别的程序占着，请再试一次";
const NOT_READY: &str = "数据文件还没从网盘下载下来，请稍后再试";
const GONE: &str = "这一条已经不在了";

// ---------- 四种条目 ----------

/// 一节课
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Course {
    pub id: String,
    pub title: String,
    /// 教室，可以空着
    #[serde(default)]
    pub place: String,
    /// 星期几，1 是周一，7 是周日
    pub weekday: u8,
    /// 几点开始、几点结束，都是从零点算起的分钟数
    pub start: u16,
    pub end: u16,
    /// 从哪天上到哪天，写成 2026-09-07
    pub from: String,
    pub until: String,
    /// 每隔几周上一次，1 是每周
    #[serde(default = "one")]
    pub every: u8,
    /// 这几天不上（放假、调课）
    #[serde(default)]
    pub skip: Vec<String>,
    #[serde(default)]
    pub updated_at: u64,
}

fn one() -> u8 {
    1
}

/// 一个截止日期：考试、交作业
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deadline {
    pub id: String,
    pub title: String,
    /// 哪天截止，写成 2026-11-26
    pub due: String,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub updated_at: u64,
}

/// 杂念箱里的一条：专注时冒出来的念头，先记下，专注完再处理
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub text: String,
    /// 什么时候记的
    pub at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

/// 生词本里的一个词
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub id: String,
    pub word: String,
    /// 释义，翻译小窗查到的
    #[serde(default)]
    pub meaning: String,
    pub added_at: u64,
    /// 连续几次复习都记得
    #[serde(default)]
    pub known: u32,
    /// 上次复习的时刻，没复习过是 0
    #[serde(default)]
    pub reviewed_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

macro_rules! entry {
    ($t:ty) => {
        impl Entry for $t {
            fn id(&self) -> &str {
                &self.id
            }
            fn updated_at(&self) -> u64 {
                self.updated_at
            }
            fn fingerprint(&self) -> String {
                serde_json::to_string(self).unwrap_or_default()
            }
        }
    };
}

entry!(Course);
entry!(Deadline);
entry!(Note);
entry!(Word);

/// 存下来的全部内容，也是发给界面的内容
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Store {
    pub courses: Vec<Course>,
    pub deadlines: Vec<Deadline>,
    pub notes: Vec<Note>,
    pub words: Vec<Word>,
    /// 删掉的条目：id → 删除时刻
    pub removed: BTreeMap<String, u64>,
    pub saved_at: u64,
}

impl Store {
    /// 每种条目排成固定的顺序，合并结果才和两边的先后无关
    fn sort(&mut self) {
        self.courses.sort_by(|a, b| {
            (a.weekday, a.start, &a.title, &a.id).cmp(&(b.weekday, b.start, &b.title, &b.id))
        });
        self.deadlines.sort_by(|a, b| {
            (a.done, &a.due, &a.title, &a.id).cmp(&(b.done, &b.due, &b.title, &b.id))
        });
        self.notes.sort_by(|a, b| (a.at, &a.id).cmp(&(b.at, &b.id)));
        self.words
            .sort_by(|a, b| (a.added_at, &a.id).cmp(&(b.added_at, &b.id)));
    }

    fn remove_id(&mut self, id: &str, now: u64) {
        self.removed.insert(id.to_string(), now);
        self.courses.retain(|x| x.id != id);
        self.deadlines.retain(|x| x.id != id);
        self.notes.retain(|x| x.id != id);
        self.words.retain(|x| x.id != id);
    }
}

pub fn merge(a: &Store, b: &Store, now: u64) -> Store {
    let removed = merge_removed(&a.removed, &b.removed, now, KEEP_REMOVED_MS);
    let mut store = Store {
        courses: merge_entries(&a.courses, &b.courses, &removed),
        deadlines: merge_entries(&a.deadlines, &b.deadlines, &removed),
        notes: merge_entries(&a.notes, &b.notes, &removed),
        words: merge_entries(&a.words, &b.words, &removed),
        removed,
        saved_at: a.saved_at.max(b.saved_at),
    };
    store.sort();
    store
}

// ---------- 检查界面发来的内容 ----------

fn clean_text(text: &str, max: usize, empty: &str) -> Result<String, String> {
    let text: String = text.trim().chars().take(max).collect();
    if text.is_empty() {
        return Err(empty.to_string());
    }
    Ok(text)
}

/// 日期要写成 2026-09-07
fn valid_date(date: &str) -> bool {
    let b = date.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// 界面发来的一节课（还没有 id 和修改时刻）
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseInput {
    pub title: String,
    #[serde(default)]
    pub place: String,
    pub weekday: u8,
    pub start: u16,
    pub end: u16,
    pub from: String,
    pub until: String,
    #[serde(default = "one")]
    pub every: u8,
    #[serde(default)]
    pub skip: Vec<String>,
}

fn clean_course(input: CourseInput, id: String, now: u64) -> Result<Course, String> {
    let title = clean_text(&input.title, 60, "先写课程名")?;
    let place: String = input.place.trim().chars().take(40).collect();
    if !(1..=7).contains(&input.weekday) {
        return Err("星期几不对".to_string());
    }
    if input.start >= input.end || input.end > 24 * 60 {
        return Err("下课时间要比上课时间晚".to_string());
    }
    if !valid_date(&input.from) || !valid_date(&input.until) {
        return Err("日期要写成 2026-09-07 这样".to_string());
    }
    if input.from > input.until {
        return Err("结束日期要在开始日期之后".to_string());
    }
    let mut skip: Vec<String> = input.skip.into_iter().filter(|d| valid_date(d)).collect();
    skip.sort();
    skip.dedup();
    skip.truncate(120);
    Ok(Course {
        id,
        title,
        place,
        weekday: input.weekday,
        start: input.start,
        end: input.end,
        from: input.from,
        until: input.until,
        every: input.every.clamp(1, 8),
        skip,
        updated_at: now,
    })
}

// ---------- id ----------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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

/// 新条目的 id：前缀（c 课、d 截止、n 杂念、w 生词）+ 时刻 + 序号 + 一点随机数
fn new_id(prefix: char, now: u64) -> String {
    static COUNT: AtomicU32 = AtomicU32::new(0);
    let count = COUNT.fetch_add(1, Ordering::Relaxed) % 1296;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!(
        "{prefix}{}{:0>2}{:0>2}",
        base36(now),
        base36(u64::from(count)),
        base36(u64::from(nanos % 1296))
    )
}

// ---------- 读写文件（和 tasks.rs 一样的办法） ----------

enum Disk {
    Missing,
    Ok(Store),
    NotReady,
    Broken,
}

fn read_disk(path: &Path) -> Disk {
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<Store>(&text) {
            Ok(mut store) => {
                store.sort();
                Disk::Ok(store)
            }
            Err(_) => Disk::Broken,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Disk::Missing,
        Err(_) => Disk::NotReady,
    }
}

type Sig = Option<(SystemTime, u64)>;

fn sig(path: &Path) -> Sig {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

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
                .is_some_and(|n| n.starts_with("planner-") && n.ends_with(".json"))
        })
        .collect();
    found.sort();
    found
}

struct Inner {
    store: Store,
    dir: PathBuf,
    known: Sig,
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
        self.dir.join(FILE)
    }

    /// 读文件、并上冲突副本、和内存里的合并；有 `apply` 就在合并结果上改。和文件上不一样就存回去。
    /// 返回内存里的内容变没变。调用时要拿着文件锁。
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
                let backup = self.dir.join(format!("planner.broken-{now}.json"));
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
            merged.sort();
        }

        if merged != disk || !absorbed.is_empty() {
            merged.saved_at = now.max(merged.saved_at + 1);
            let text =
                serde_json::to_string_pretty(&merged).map_err(|_| SAVE_FAILED.to_string())?;
            if sig(&path) != before {
                self.pending = true;
                return Err(BUSY.to_string());
            }
            let _ = std::fs::create_dir_all(&self.dir);
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

type NoApply = fn(&mut Store, u64) -> Result<(), String>;

pub struct Planner {
    inner: Mutex<Inner>,
    /// 本机的文件夹，放锁
    local: PathBuf,
}

impl Planner {
    pub fn load(dir: PathBuf, local: PathBuf) -> Self {
        let planner = Self {
            inner: Mutex::new(Inner::new(Store::default(), dir)),
            local,
        };
        if let Some(_lock) = FileLock::acquire(&planner.local, LOCK) {
            let _ = planner.lock().sync(None::<NoApply>, now_ms());
        }
        planner
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn snapshot(&self) -> Store {
        self.lock().store.clone()
    }

    fn change<F>(&self, apply: F) -> Result<Store, String>
    where
        F: FnOnce(&mut Store, u64) -> Result<(), String>,
    {
        let mut inner = self.lock();
        let _lock = FileLock::acquire(&self.local, LOCK).ok_or_else(|| BUSY.to_string())?;
        inner.sync(Some(apply), now_ms())?;
        Ok(inner.store.clone())
    }

    fn poll(&self) -> Option<Store> {
        let mut inner = self.lock();
        let quiet = !inner.pending
            && sig(&inner.path()) == inner.known
            && conflict_copies(&inner.dir).is_empty();
        if quiet {
            return None;
        }
        let _lock = FileLock::acquire(&self.local, LOCK)?;
        match inner.sync(None::<NoApply>, now_ms()) {
            Ok(true) => Some(inner.store.clone()),
            _ => None,
        }
    }

    /// 换数据文件夹。`keep` 为真：带过去合并；为假：直接用那边的
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

pub fn announce(app: &AppHandle, store: &Store) {
    let _ = app.emit("planner-changed", store);
}

/// 定时调用：别的电脑改过（网盘同步过来了），告诉所有窗口
pub fn poll_external(app: &AppHandle) {
    if let Some(planner) = app.try_state::<Planner>() {
        if let Some(store) = planner.poll() {
            announce(app, &store);
        }
    }
}

/// 改一下、存盘、告诉所有窗口
fn change<F>(app: &AppHandle, planner: &Planner, apply: F) -> Result<Store, String>
where
    F: FnOnce(&mut Store, u64) -> Result<(), String>,
{
    let store = planner.change(apply)?;
    announce(app, &store);
    Ok(store)
}

// ---------- 命令：课表 ----------

#[tauri::command]
pub fn planner_get(planner: State<Planner>) -> Store {
    planner.snapshot()
}

#[tauri::command]
pub fn course_add(
    app: AppHandle,
    planner: State<Planner>,
    course: CourseInput,
) -> Result<Store, String> {
    change(&app, &planner, |store, now| {
        if store.courses.len() >= MAX_COURSES {
            return Err("课太多了，先清掉一些旧的".to_string());
        }
        store
            .courses
            .push(clean_course(course, new_id('c', now), now)?);
        Ok(())
    })
}

#[tauri::command]
pub fn course_edit(
    app: AppHandle,
    planner: State<Planner>,
    id: String,
    course: CourseInput,
) -> Result<Store, String> {
    change(&app, &planner, |store, now| {
        let at = store
            .courses
            .iter()
            .position(|c| c.id == id)
            .ok_or_else(|| GONE.to_string())?;
        store.courses[at] = clean_course(course, id.clone(), now)?;
        Ok(())
    })
}

/// 导入一整份课表。`replace` 为真：先清掉原来的课
#[tauri::command]
pub fn courses_import(
    app: AppHandle,
    planner: State<Planner>,
    courses: Vec<CourseInput>,
    replace: bool,
) -> Result<Store, String> {
    if courses.is_empty() {
        return Err("文件里没有找到课".to_string());
    }
    change(&app, &planner, |store, now| {
        if replace {
            let ids: Vec<String> = store.courses.iter().map(|c| c.id.clone()).collect();
            for id in ids {
                store.remove_id(&id, now);
            }
        }
        if store.courses.len() + courses.len() > MAX_COURSES {
            return Err("课太多了，一份课表最多 300 节".to_string());
        }
        // 有一节读不懂就整份不导入，免得导进去一半
        let mut cleaned = Vec::with_capacity(courses.len());
        for course in courses {
            cleaned.push(clean_course(course, new_id('c', now), now)?);
        }
        store.courses.extend(cleaned);
        Ok(())
    })
}

#[tauri::command]
pub fn courses_clear(app: AppHandle, planner: State<Planner>) -> Result<Store, String> {
    change(&app, &planner, |store, now| {
        let ids: Vec<String> = store.courses.iter().map(|c| c.id.clone()).collect();
        for id in ids {
            store.remove_id(&id, now);
        }
        Ok(())
    })
}

// ---------- 命令：截止日期 ----------

#[tauri::command]
pub fn deadline_add(
    app: AppHandle,
    planner: State<Planner>,
    title: String,
    due: String,
) -> Result<Store, String> {
    change(&app, &planner, |store, now| {
        if store.deadlines.len() >= MAX_DEADLINES {
            return Err("截止日期太多了，先删掉一些做完的".to_string());
        }
        let title = clean_text(&title, 60, "先写是什么要截止")?;
        if !valid_date(&due) {
            return Err("先选截止日期".to_string());
        }
        store.deadlines.push(Deadline {
            id: new_id('d', now),
            title,
            due,
            done: false,
            updated_at: now,
        });
        Ok(())
    })
}

#[tauri::command]
pub fn deadline_set_done(
    app: AppHandle,
    planner: State<Planner>,
    id: String,
    done: bool,
) -> Result<Store, String> {
    change(&app, &planner, |store, now| {
        let item = store
            .deadlines
            .iter_mut()
            .find(|d| d.id == id)
            .ok_or_else(|| GONE.to_string())?;
        if item.done != done {
            item.done = done;
            item.updated_at = now;
        }
        Ok(())
    })
}

// ---------- 命令：杂念箱 ----------

#[tauri::command]
pub fn note_add(app: AppHandle, planner: State<Planner>, text: String) -> Result<Store, String> {
    change(&app, &planner, |store, now| {
        if store.notes.len() >= MAX_NOTES {
            return Err("杂念箱满了，先整理一下".to_string());
        }
        let text = clean_text(&text, 200, "先写下想到的事")?;
        store.notes.push(Note {
            id: new_id('n', now),
            text,
            at: now,
            updated_at: now,
        });
        Ok(())
    })
}

/// 杂念箱里的一条转成待办：加一个任务，再把这条删掉
#[tauri::command]
pub fn note_to_task(app: AppHandle, planner: State<Planner>, id: String) -> Result<Store, String> {
    let text = planner
        .snapshot()
        .notes
        .into_iter()
        .find(|n| n.id == id)
        .map(|n| n.text)
        .ok_or_else(|| GONE.to_string())?;
    crate::tasks::add_task(&app, &text, 1)?;
    change(&app, &planner, |store, now| {
        store.remove_id(&id, now);
        Ok(())
    })
}

// ---------- 命令：生词本 ----------

/// 加一个生词。已经有了就更新释义，不重复加
#[tauri::command]
pub fn word_add(
    app: AppHandle,
    planner: State<Planner>,
    word: String,
    meaning: String,
) -> Result<Store, String> {
    change(&app, &planner, |store, now| {
        let word = clean_text(&word, 80, "没有要记的词")?;
        let meaning: String = meaning.trim().chars().take(300).collect();
        let key = word.to_lowercase();
        if let Some(found) = store
            .words
            .iter_mut()
            .find(|w| w.word.to_lowercase() == key)
        {
            if !meaning.is_empty() && found.meaning != meaning {
                found.meaning = meaning;
                found.updated_at = now;
            }
            return Ok(());
        }
        if store.words.len() >= MAX_WORDS {
            return Err("生词本满了，先删掉一些记熟的".to_string());
        }
        store.words.push(Word {
            id: new_id('w', now),
            word,
            meaning,
            added_at: now,
            known: 0,
            reviewed_at: 0,
            updated_at: now,
        });
        Ok(())
    })
}

/// 复习一次：记得就加一，不记得从头来
#[tauri::command]
pub fn word_review(
    app: AppHandle,
    planner: State<Planner>,
    id: String,
    known: bool,
) -> Result<Store, String> {
    change(&app, &planner, |store, now| {
        let item = store
            .words
            .iter_mut()
            .find(|w| w.id == id)
            .ok_or_else(|| GONE.to_string())?;
        item.known = if known {
            item.known.saturating_add(1)
        } else {
            0
        };
        item.reviewed_at = now;
        item.updated_at = now;
        Ok(())
    })
}

// ---------- 命令：删除（四种通用） ----------

#[tauri::command]
pub fn planner_remove(
    app: AppHandle,
    planner: State<Planner>,
    id: String,
) -> Result<Store, String> {
    change(&app, &planner, |store, now| {
        store.remove_id(&id, now);
        Ok(())
    })
}
