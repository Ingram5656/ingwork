//! Mac 触控板的轻震（Force Touch 触控板才有）。用在调番茄时长的每一格、调到头、刘海番茄展开。
//! 手指没放在触控板上、用的是鼠标、或者在 Windows 上时，什么都不做。设置里能关。

use std::sync::atomic::{AtomicBool, Ordering};

/// 设置里的"触控板轻震"开没开。主窗口启动和改设置时告诉这里
static ON: AtomicBool = AtomicBool::new(true);

/// 震哪一种
#[derive(Clone, Copy)]
pub enum Kind {
    /// 最轻的"咔哒"：调了一格、刘海展开
    Tick,
    /// 重一点：调到头了，再滑也不动
    Edge,
}

/// 震一下。Mac 上只能在主线程调（同步的命令就在主线程上跑）
pub fn tap(kind: Kind) {
    if !ON.load(Ordering::SeqCst) {
        return;
    }
    #[cfg(target_os = "macos")]
    mac::perform(kind);
    #[cfg(not(target_os = "macos"))]
    let _ = kind;
}

#[cfg(target_os = "macos")]
mod mac {
    use super::Kind;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    pub fn perform(kind: Kind) {
        // NSHapticFeedbackPatternGeneric = 0、Alignment = 1（最轻）、LevelChange = 2（重一点）；
        // NSHapticFeedbackPerformanceTimeNow = 1
        let pattern: isize = match kind {
            Kind::Tick => 1,
            Kind::Edge => 2,
        };
        unsafe {
            let performer: *mut AnyObject =
                msg_send![class!(NSHapticFeedbackManager), defaultPerformer];
            if performer.is_null() {
                return;
            }
            let _: () =
                msg_send![performer, performFeedbackPattern: pattern, performanceTime: 1usize];
        }
    }
}

/// 界面要震一下：kind 是 "tick" 或 "edge"
#[tauri::command]
pub fn haptic(kind: String) {
    tap(if kind == "edge" {
        Kind::Edge
    } else {
        Kind::Tick
    });
}

/// 设置里开关触控板轻震
#[tauri::command]
pub fn haptics_enable(on: bool) {
    ON.store(on, Ordering::SeqCst);
}
