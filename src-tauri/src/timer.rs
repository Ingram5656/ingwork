//! 计时本身。放在 Rust 里，主窗口关了也照走；界面只负责显示。
//!
//! 计时按真实流逝的时间一小步一小步累加，不靠"每秒减一"。
//! 电脑睡眠的那段时间不算，等于睡眠时暂停：
//! - Windows：两步之间隔了很久，就当睡眠过
//! - Mac：这里用的时钟本来就不算睡眠，不用猜

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Windows：两次走表之间超过这么久，就当电脑睡眠过，这段时间不计入。
/// Mac 上不用：时钟本来就不算睡眠；而软件在后台时系统会把线程拖慢（App Nap），
/// 两次走表隔上好几秒是常事，当成睡眠丢掉的话，番茄就走慢了
#[cfg(not(target_os = "macos"))]
const SLEEP_GAP: Option<Duration> = Some(Duration::from_secs(5));
#[cfg(target_os = "macos")]
const SLEEP_GAP: Option<Duration> = None;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Focus,
    ShortBreak,
    LongBreak,
}

/// 界面发过来的计时和提醒设置。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub focus_min: u32,
    pub short_min: u32,
    pub long_min: u32,
    /// 几轮专注后长休息
    pub rounds: u32,
    /// 一段结束后自动开始下一段
    pub auto_start: bool,
    /// 提示音的名字，"none" 是不出声
    pub sound: String,
    pub volume: f32,
    /// 到点发系统通知
    pub notify: bool,
    /// 到点把主窗口叫出来
    pub raise_window: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            focus_min: 25,
            short_min: 5,
            long_min: 15,
            rounds: 4,
            auto_start: false,
            sound: "bell".into(),
            volume: 0.7,
            notify: true,
            raise_window: true,
        }
    }
}

impl Config {
    fn duration(&self, phase: Phase) -> Duration {
        let min = match phase {
            Phase::Focus => self.focus_min,
            Phase::ShortBreak => self.short_min,
            Phase::LongBreak => self.long_min,
        };
        Duration::from_secs(u64::from(min.clamp(1, 600)) * 60)
    }
}

/// 发给界面的当前状态。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub phase: Phase,
    pub running: bool,
    pub remaining_ms: u64,
    pub total_ms: u64,
    /// 这一组里已经完成了几轮专注
    pub round: u32,
    pub rounds: u32,
    /// 这一段是"再专注几分钟"的加时：走完只算时长，不算番茄
    pub bonus: bool,
}

/// 一段自然走完时发给界面的事件。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    pub finished: Phase,
    pub next: Phase,
    /// 这一段实际走了多久（毫秒）。暂停和睡眠的时间不算
    pub focused_ms: u64,
    /// 走完的是加时：只记时长，不给任务记番茄
    pub bonus: bool,
}

/// 走一步表的结果。
pub enum Tick {
    /// 没有需要告诉界面的变化
    Idle,
    /// 秒数变了
    Second(Snapshot),
    /// 这一段走完了
    Finished(Finished, Config, Snapshot),
}

struct Inner {
    config: Config,
    phase: Phase,
    running: bool,
    remaining: Duration,
    /// 这一段一共多长。平时就是设置里的时长，加时的时候是加的那几分钟
    total: Duration,
    /// 正在加时（专注结束后又多专注几分钟）。里面是加时走完后该进的那段休息
    bonus: Option<Phase>,
    /// 这一段已经实际走了多久。统计用它，不用"总时长减剩余"，这样中途改了时长也准
    elapsed: Duration,
    round: u32,
    last_tick: Instant,
    last_sec: u64,
}

impl Inner {
    /// 要离开当前这一段了：如果它是一段已经走了一些时间的专注，返回走了多久（毫秒）。
    fn focused_so_far(&self) -> Option<u64> {
        if self.phase == Phase::Focus && !self.elapsed.is_zero() {
            Some(self.elapsed.as_millis() as u64)
        } else {
            None
        }
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            phase: self.phase,
            running: self.running,
            remaining_ms: self.remaining.as_millis() as u64,
            total_ms: self.total.as_millis() as u64,
            round: self.round,
            rounds: self.config.rounds.max(1),
            bonus: self.bonus.is_some(),
        }
    }

    /// 进入某个阶段，时间回到这个阶段的满值。
    fn enter(&mut self, phase: Phase, run: bool) {
        self.phase = phase;
        self.total = self.config.duration(phase);
        self.remaining = self.total;
        self.bonus = None;
        self.elapsed = Duration::ZERO;
        self.running = run;
        self.last_tick = Instant::now();
        self.last_sec = self.remaining.as_secs();
    }

    /// 当前阶段之后该进哪个阶段。`counted` 为假表示这段专注是跳过的，不算一轮。
    fn next_after(&mut self, counted: bool) -> Phase {
        match self.phase {
            Phase::Focus => {
                if counted {
                    self.round += 1;
                }
                if self.round >= self.config.rounds.max(1) {
                    Phase::LongBreak
                } else {
                    Phase::ShortBreak
                }
            }
            Phase::ShortBreak => Phase::Focus,
            Phase::LongBreak => {
                self.round = 0;
                Phase::Focus
            }
        }
    }
}

#[derive(Clone)]
pub struct Timer(Arc<Mutex<Inner>>);

impl Timer {
    pub fn new() -> Self {
        let config = Config::default();
        let remaining = config.duration(Phase::Focus);
        Self(Arc::new(Mutex::new(Inner {
            last_sec: remaining.as_secs(),
            config,
            phase: Phase::Focus,
            running: false,
            remaining,
            total: remaining,
            bonus: None,
            elapsed: Duration::ZERO,
            round: 0,
            last_tick: Instant::now(),
        })))
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn snapshot(&self) -> Snapshot {
        self.lock().snapshot()
    }

    /// 开始 / 暂停
    pub fn toggle(&self) -> Snapshot {
        let mut g = self.lock();
        g.running = !g.running;
        g.last_tick = Instant::now();
        g.snapshot()
    }

    /// 现在这一段如果是专注，已经走了多久（毫秒）。退出软件前用它把没走完的专注记下来。
    pub fn focused_so_far(&self) -> Option<u64> {
        self.lock().focused_so_far()
    }

    // 下面三个操作都会离开当前这一段。返回值的第二项：
    // 离开的如果是一段走了一些时间的专注，是它走了多久（毫秒），统计里记成"中途停下"。

    /// 跳过这一段。跳过的专注不算一轮。
    pub fn skip(&self) -> (Snapshot, Option<u64>) {
        let mut g = self.lock();
        let left = g.focused_so_far();
        let next = match g.bonus {
            Some(rest) => rest,
            None => g.next_after(false),
        };
        let run = g.config.auto_start;
        g.enter(next, run);
        (g.snapshot(), left)
    }

    /// 重置这一段
    pub fn reset(&self) -> (Snapshot, Option<u64>) {
        let mut g = self.lock();
        let left = g.focused_so_far();
        let phase = g.phase;
        g.enter(phase, false);
        (g.snapshot(), left)
    }

    /// 手动切到某个阶段
    pub fn set_phase(&self, phase: Phase) -> (Snapshot, Option<u64>) {
        let mut g = self.lock();
        let left = g.focused_so_far();
        if g.phase == Phase::LongBreak && phase != Phase::LongBreak {
            g.round = 0;
        }
        g.enter(phase, false);
        (g.snapshot(), left)
    }

    /// 界面改了设置。还没开始的这一段直接用新的时长。加时的长度不跟着设置变。
    pub fn configure(&self, config: Config) -> Snapshot {
        let mut g = self.lock();
        let fresh = !g.running && g.remaining == g.total;
        g.config = config;
        if g.bonus.is_none() {
            let total = g.config.duration(g.phase);
            g.total = total;
            if fresh || g.remaining > total {
                g.remaining = total;
                g.last_sec = total.as_secs();
            }
        }
        g.snapshot()
    }

    /// 只改这一段的长度，不动设置（离下节课不够一个完整番茄时用）。
    /// 只在这一段还没开始时有效；之后的每一段照设置里的时长来。
    pub fn set_length(&self, minutes: u32) -> Snapshot {
        let mut g = self.lock();
        let fresh = !g.running && g.remaining == g.total;
        if fresh && g.bonus.is_none() {
            let length = Duration::from_secs(u64::from(minutes.clamp(1, 600)) * 60);
            g.total = length;
            g.remaining = length;
            g.last_sec = length.as_secs();
        }
        g.snapshot()
    }

    /// 专注刚结束、休息还没怎么开始时，再专注几分钟。走完后回到这段休息。
    /// 现在不是休息就什么都不做。
    pub fn extend(&self, minutes: u32) -> Snapshot {
        let mut g = self.lock();
        if g.phase == Phase::Focus || g.bonus.is_some() {
            return g.snapshot();
        }
        let rest = g.phase;
        let length = Duration::from_secs(u64::from(minutes.clamp(1, 60)) * 60);
        g.phase = Phase::Focus;
        g.total = length;
        g.remaining = length;
        g.elapsed = Duration::ZERO;
        g.bonus = Some(rest);
        g.running = true;
        g.last_tick = Instant::now();
        g.last_sec = length.as_secs();
        g.snapshot()
    }

    /// 还没开始的这一段：开始。已经在走或暂停中：不动。
    pub fn start(&self) -> Snapshot {
        let mut g = self.lock();
        if !g.running {
            g.running = true;
            g.last_tick = Instant::now();
        }
        g.snapshot()
    }

    /// 走一步表。由后台线程每 200 毫秒调一次。
    pub fn tick(&self) -> Tick {
        let mut g = self.lock();
        let now = Instant::now();
        let mut dt = now.duration_since(g.last_tick);
        g.last_tick = now;
        if SLEEP_GAP.is_some_and(|gap| dt > gap) {
            dt = Duration::ZERO;
        }
        if !g.running {
            return Tick::Idle;
        }
        if dt >= g.remaining {
            let finished = g.phase;
            let focused_ms = (g.elapsed + g.remaining).as_millis() as u64;
            let bonus = g.bonus.is_some();
            // 加时走完：不算一轮，回到原来那段休息
            let next = match g.bonus {
                Some(rest) => rest,
                None => g.next_after(true),
            };
            let run = g.config.auto_start;
            g.enter(next, run);
            let config = g.config.clone();
            let snapshot = g.snapshot();
            return Tick::Finished(
                Finished {
                    finished,
                    next,
                    focused_ms,
                    bonus,
                },
                config,
                snapshot,
            );
        }
        g.remaining -= dt;
        g.elapsed += dt;
        let sec = (g.remaining.as_millis() as u64 + 999) / 1000;
        if sec != g.last_sec {
            g.last_sec = sec;
            Tick::Second(g.snapshot())
        } else {
            Tick::Idle
        }
    }
}
