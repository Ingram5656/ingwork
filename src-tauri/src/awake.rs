//! Mac：计时进行中时，告诉系统别让 ingwork "打盹"（App Nap）。
//!
//! 窗口都看不见时（主窗口收进菜单栏），macOS 会把这个软件的定时器拖慢，好几秒才醒一次，
//! 番茄钟和提醒就会晚。计时开始时登记一项"用户发起的活动"，系统就不会再拖慢它；
//! 暂停或停下时撤掉，不白白耗电。电脑照样可以睡眠。
//!
//! 别的系统上什么都不做。

#[cfg(target_os = "macos")]
mod mac {
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::sync::Mutex;

    /// NSActivityUserInitiatedAllowingIdleSystemSleep：用户发起的活动，但允许电脑闲置时睡眠
    const OPTIONS: u64 = 0x00FF_FFFF & !(1 << 20);

    /// 登记活动时系统给的凭证，撤掉时要交回去
    struct Token(Retained<AnyObject>);
    // 凭证只是交给 NSProcessInfo 的一个普通对象，NSProcessInfo 本身可以在任何线程上用
    unsafe impl Send for Token {}

    static TOKEN: Mutex<Option<Token>> = Mutex::new(None);

    pub fn keep(running: bool) {
        let mut token = TOKEN.lock().unwrap_or_else(|e| e.into_inner());
        if running == token.is_some() {
            return;
        }
        autoreleasepool(|_| unsafe {
            let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
            if info.is_null() {
                return;
            }
            match token.take() {
                Some(Token(held)) => {
                    let _: () = msg_send![info, endActivity: &*held];
                }
                None => {
                    let reason: *mut AnyObject = msg_send![
                        class!(NSString),
                        stringWithUTF8String: c"ingwork is timing a pomodoro".as_ptr()
                    ];
                    let activity: Option<Retained<AnyObject>> =
                        msg_send![info, beginActivityWithOptions: OPTIONS, reason: reason];
                    *token = activity.map(Token);
                }
            }
        });
    }
}

/// 计时在走：别让系统拖慢 ingwork；停了：恢复平常。重复调用没关系
pub fn keep(running: bool) {
    #[cfg(target_os = "macos")]
    mac::keep(running);
    #[cfg(not(target_os = "macos"))]
    let _ = running;
}
