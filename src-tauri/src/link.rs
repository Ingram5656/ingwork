//! 和 ingfy 联动：两个软件通过 `%APPDATA%\ing-series\` 里的几个小文件互相知道对方的状态。
//! 不开端口、不联网。对方没开，文件就不会更新，超过几秒没更新就当对方不在，各自照常单独用。
//!
//! - `ingclock.json`：ingclock 写，ingfy 读。现在是哪一段、还剩多久、当前任务、最近一次到点
//! - `ingfy.json`：ingfy 写，ingclock 读。灵动岛开没开
//! - `ingclock-command.json`：ingfy 写，ingclock 读。灵动岛上点了暂停、跳过、开始休息、再专注几分钟
//!
//! 字段的写法和 ingfy 的 src-tauri/src/ingclock.rs 一致，改一边要改另一边。
//!
//! ingwork 是从 ingclock 长出来的，沿用同一套文件名，ingfy 不用改就能把 ingwork 的番茄显示在灵动岛上。
//! 所以 ingwork 和 ingclock 不要同时开：两个都在写 ingclock.json，灵动岛会在两边之间来回跳。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::timer::{Finished, Phase, Snapshot};

/// 对方的文件超过这么久没更新，就当它没开
const FRESH_MS: u64 = 5_000;
/// 命令发出超过这么久才看到，就不执行了（免得重开软件时执行一个旧命令）
const COMMAND_TTL_MS: u64 = 10_000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn dir() -> Option<PathBuf> {
    let roaming = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(roaming).join("ing-series"))
}

/// 先写临时文件再改名，对方读的时候不会读到写了一半的内容
fn write_atomic(name: &str, text: &str) {
    let Some(dir) = dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join(name);
    let tmp = dir.join(format!("{name}.tmp"));
    if std::fs::write(&tmp, text).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// 最近一次到点。ingfy 看到新的 id 就把灵动岛展开提醒一下
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FinishedNote {
    id: u64,
    at: u64,
    finished: Phase,
    next: Phase,
    /// 加时走完的不记番茄
    bonus: bool,
    /// 下一段已经自动开始了
    auto_started: bool,
    /// 下一段多少分钟
    next_minutes: u32,
    /// 刚走完的这段专注记在哪个任务上
    task: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status<'a> {
    v: u32,
    updated_at: u64,
    #[serde(flatten)]
    timer: &'a Snapshot,
    task: Option<String>,
    finished: Option<&'a FinishedNote>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IngfyStatus {
    #[serde(default)]
    updated_at: u64,
    #[serde(default)]
    island: bool,
}

/// ingfy 发来的命令
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    id: u64,
    at: u64,
    pub cmd: String,
    #[serde(default)]
    pub minutes: Option<u32>,
}

#[derive(Default)]
pub struct Link {
    finished: Mutex<Option<FinishedNote>>,
    /// 上一次写 ingclock.json 的时刻，用来做心跳
    last_write: AtomicU64,
    /// ingfy 的灵动岛开着
    island: AtomicBool,
    /// ingfy 开着（不管灵动岛开没开）。没开时不用每秒都写，隔一会儿写一次心跳就够
    present: AtomicBool,
    /// 有一次到点还没写出去
    finished_unsent: AtomicBool,
    /// 执行过的最后一个命令
    last_command: AtomicU64,
    command_mtime: Mutex<Option<SystemTime>>,
}

impl Link {
    /// 把现在的状态写出去。状态变了、或者每秒走表时调用。
    /// ingfy 没开时只写心跳（隔 2 秒一次），不每秒写盘；当前任务的名字用到时才去取
    pub fn write(&self, snap: &Snapshot, task: impl FnOnce() -> Option<String>) {
        if dir().is_none() {
            return;
        }
        let quiet = !self.present.load(Ordering::SeqCst)
            && !self.finished_unsent.load(Ordering::SeqCst)
            && !self.needs_heartbeat();
        if quiet {
            return;
        }
        let task = task();
        let finished = self.finished.lock().unwrap_or_else(|e| e.into_inner());
        let status = Status {
            v: 1,
            updated_at: now_ms(),
            timer: snap,
            task,
            finished: finished.as_ref(),
        };
        if let Ok(text) = serde_json::to_string(&status) {
            write_atomic("ingclock.json", &text);
            self.last_write.store(now_ms(), Ordering::SeqCst);
            self.finished_unsent.store(false, Ordering::SeqCst);
        }
    }

    /// 停下来不走时也要每隔两秒写一次，ingfy 才知道 ingclock 还开着
    pub fn needs_heartbeat(&self) -> bool {
        now_ms().saturating_sub(self.last_write.load(Ordering::SeqCst)) >= 2_000
    }

    /// 记下一次到点，下一次 write 时一起写出去
    pub fn note_finished(&self, finished: &Finished, snap: &Snapshot, task: Option<String>) {
        let at = now_ms();
        *self.finished.lock().unwrap_or_else(|e| e.into_inner()) = Some(FinishedNote {
            id: at,
            at,
            finished: finished.finished,
            next: finished.next,
            bonus: finished.bonus,
            auto_started: snap.running,
            next_minutes: ((snap.total_ms + 59_999) / 60_000) as u32,
            task,
        });
        self.finished_unsent.store(true, Ordering::SeqCst);
    }

    /// 退出时删掉自己的文件，ingfy 马上就知道 ingclock 关了
    pub fn goodbye(&self) {
        if let Some(dir) = dir() {
            let _ = std::fs::remove_file(dir.join("ingclock.json"));
        }
    }

    /// 读一次 ingfy.json。灵动岛开没开变了的话返回新的值
    pub fn poll_island(&self) -> Option<bool> {
        let status = dir()
            .and_then(|d| std::fs::read_to_string(d.join("ingfy.json")).ok())
            .and_then(|text| serde_json::from_str::<IngfyStatus>(&text).ok())
            .filter(|s| now_ms().saturating_sub(s.updated_at) < FRESH_MS);
        self.present.store(status.is_some(), Ordering::SeqCst);
        let present = status.is_some_and(|s| s.island);
        let before = self.island.swap(present, Ordering::SeqCst);
        (before != present).then_some(present)
    }

    /// ingfy 的灵动岛现在开着
    pub fn island(&self) -> bool {
        self.island.load(Ordering::SeqCst)
    }

    /// 看一眼有没有新命令。文件没变就只花一次取修改时间
    pub fn take_command(&self) -> Option<Command> {
        let path = dir()?.join("ingclock-command.json");
        let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok()?;
        {
            let mut seen = self.command_mtime.lock().unwrap_or_else(|e| e.into_inner());
            if *seen == Some(mtime) {
                return None;
            }
            *seen = Some(mtime);
        }
        let text = std::fs::read_to_string(&path).ok()?;
        let command: Command = serde_json::from_str(&text).ok()?;
        if command.id <= self.last_command.load(Ordering::SeqCst) {
            return None;
        }
        self.last_command.store(command.id, Ordering::SeqCst);
        if now_ms().saturating_sub(command.at) > COMMAND_TTL_MS {
            return None;
        }
        Some(command)
    }

    /// 启动时把已经在那里的旧命令记成"执行过"，免得一打开就执行上次留下的
    pub fn skip_old_command(&self) {
        let _ = self.take_command();
    }
}
