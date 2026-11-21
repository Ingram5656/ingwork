//! 上课提醒：界面算好今明两天每节课"该在几点提醒"，交给这里；到点由后端发系统通知。
//!
//! 以前整个提醒都在主窗口的网页里每 20 秒查一次。可主窗口一收起来，网页的定时器会被系统大幅拖慢，
//! Mac 上尤其狠，提醒就会晚甚至漏掉。现在网页只负责排时间（课表、设置变了，或者过了零点再排一次），
//! 到点由后端的走表线程来发，和番茄钟到点用同一条路。
//!
//! 时间用的是 Unix 毫秒，不用管时区：本地的几点几分由界面换算好。

use serde::Deserialize;
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;

/// 一条排好的提醒
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    /// 同一节课的同一次只提醒一次：日期 + 课的 id + 上课时间
    key: String,
    /// 从这一刻起提醒
    at: u64,
    /// 上课时间。过了就不提醒了（开着电脑的人那时已经在上课了）
    until: u64,
    /// 标题，里面的 {n} 换成还有几分钟上课
    title: String,
    body: String,
}

#[derive(Default)]
pub struct Reminders {
    pending: Mutex<Vec<Reminder>>,
    /// 已经提醒过的 key。只增不减，一天也就几条
    done: Mutex<HashSet<String>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Reminders {
    /// 到点了的提醒：从排队里拿出来，记成已提醒。过了上课时间的直接丢掉
    fn due(&self, now: u64) -> Vec<Reminder> {
        let mut pending = lock(&self.pending);
        let mut done = lock(&self.done);
        let mut fire = Vec::new();
        pending.retain(|r| {
            if done.contains(&r.key) || now >= r.until {
                return false;
            }
            if now >= r.at {
                done.insert(r.key.clone());
                fire.push(r.clone());
                return false;
            }
            true
        });
        fire
    }
}

/// 走表线程每秒调一次
pub fn check(app: &AppHandle) {
    let Some(state) = app.try_state::<Reminders>() else {
        return;
    };
    let now = now_ms();
    for reminder in state.due(now) {
        // 向上取整：差 4 分 10 秒说"5 分钟后"
        let minutes = (reminder.until.saturating_sub(now) + 59_999) / 60_000;
        let title = reminder.title.replace("{n}", &minutes.to_string());
        let _ = app
            .notification()
            .builder()
            .title(title)
            .body(reminder.body)
            .show();
    }
}

/// 界面排好的提醒，整个换掉。已经提醒过的不会再提醒
#[tauri::command]
pub fn reminders_set(reminders: State<Reminders>, list: Vec<Reminder>) {
    let done = lock(&reminders.done);
    let list: Vec<Reminder> = list
        .into_iter()
        .filter(|r| !done.contains(&r.key) && r.at < r.until)
        .take(200)
        .collect();
    drop(done);
    *lock(&reminders.pending) = list;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(key: &str, at: u64, until: u64) -> Reminder {
        Reminder {
            key: key.into(),
            at,
            until,
            title: "{n} 分钟后上课".into(),
            body: String::new(),
        }
    }

    #[test]
    fn fires_once_between_at_and_until() {
        let state = Reminders::default();
        *lock(&state.pending) = vec![r("a", 100, 200), r("b", 300, 400)];
        assert!(state.due(50).is_empty());
        let fired = state.due(150);
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].key, "a");
        // 同一条不会再提醒
        assert!(state.due(160).is_empty());
        // 过了上课时间才看到：不提醒
        assert!(state.due(450).is_empty());
        assert!(lock(&state.pending).is_empty());
    }
}
