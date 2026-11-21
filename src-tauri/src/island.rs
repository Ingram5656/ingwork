//! Mac 的刘海番茄（灵动岛）：一块纯黑的小窗盖在刘海上，和刘海连成一片。
//!
//! 平时只比刘海宽一点，左边是进度环，右边是剩余时间；鼠标移上去往下展开，能暂停、跳过。
//! 苹果没给 Mac 开放灵动岛的接口，灵动歌词这类软件都是这样做的：
//! - 窗口层级比菜单栏高，不然会被菜单栏盖住；
//! - 在所有桌面空间、全屏应用里都显示，不进 ⌘Tab；
//! - 收起时鼠标穿透（点得到下面的菜单栏），展开时才接鼠标。
//!
//! 窗口一直是展开时那么大，收起时页面只画中间那一小块，其余透明。
//! 鼠标在不在上面由后端每 50 毫秒查一次（穿透时页面收不到鼠标事件）。
//! 位置、大小都用 Cocoa 的坐标（点，原点在主屏幕左下角）直接设，不经过 Tauri 换算，
//! 刘海的位置也是从 NSScreen 直接读的。
//!
//! 窗口的样子写在 tauri.macos.conf.json 里（"create": false），第一次用到时才创建。
//! 别的系统上没有刘海，`island_apply` 打开时直接报错。

// 别的系统上只用到命令的空壳，大小的计算只在 Mac 上用
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use serde::Serialize;

pub const ISLAND: &str = "island";

/// 收起时刘海两边各伸出多宽（点）：左边放进度环，右边放剩余时间
pub const WING: f64 = 76.0;
/// 展开后面板比刘海两边各宽多少，最少多宽、比刘海高多少
const SPREAD: f64 = 130.0;
const MIN_WIDTH: f64 = 420.0;
const DROP: f64 = 116.0;
/// 面板左右留给"肩膀"（和屏幕上沿接上的那两道内凹圆角）的边
pub const SHOULDER: f64 = 12.0;

/// 告诉页面刘海多大、窗口多大（点 = CSS 像素）
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    /// 这块屏幕有没有刘海。没有就画成菜单栏正中的一颗胶囊
    pub has_notch: bool,
    pub notch_w: f64,
    pub notch_h: f64,
    pub wing: f64,
    /// 窗口的宽高；面板展开时是 (width - 2 × shoulder) × height
    pub width: f64,
    pub height: f64,
    pub shoulder: f64,
}

impl Geometry {
    /// 按刘海的大小算出窗口要多大
    pub fn new(has_notch: bool, notch_w: f64, notch_h: f64) -> Self {
        let panel = (notch_w + SPREAD * 2.0).max(MIN_WIDTH);
        Self {
            has_notch,
            notch_w,
            notch_h,
            wing: WING,
            width: panel + SHOULDER * 2.0,
            height: notch_h + DROP,
            shoulder: SHOULDER,
        }
    }

    /// 收起时能"摸到"的那一块：刘海（加上两边伸出来的部分）。
    /// 返回相对窗口中线的半宽和从屏幕上沿往下的高度
    pub fn collapsed_zone(&self, wings: bool) -> (f64, f64) {
        let mut half = self.notch_w / 2.0;
        if wings || !self.has_notch {
            half += self.wing;
        }
        // 刘海下沿往下多给几个点，鼠标不用摸得那么准
        (half, self.notch_h + 4.0)
    }

    /// 展开后的面板：相对窗口中线的半宽和高度
    pub fn expanded_zone(&self) -> (f64, f64) {
        (self.width / 2.0 - self.shoulder, self.height)
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{Geometry, ISLAND};
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send, sel, Encode, Encoding};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct Point {
        x: f64,
        y: f64,
    }
    unsafe impl Encode for Point {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct Size {
        w: f64,
        h: f64,
    }
    unsafe impl Encode for Size {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct Rect {
        origin: Point,
        size: Size,
    }
    unsafe impl Encode for Rect {
        const ENCODING: Encoding = Encoding::Struct("CGRect", &[Point::ENCODING, Size::ENCODING]);
    }

    /// 只用到 top，另外三个字段要留着，布局才和系统的 NSEdgeInsets 一样
    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    #[allow(dead_code)]
    struct Insets {
        top: f64,
        left: f64,
        bottom: f64,
        right: f64,
    }
    unsafe impl Encode for Insets {
        const ENCODING: Encoding = Encoding::Struct(
            "NSEdgeInsets",
            &[f64::ENCODING, f64::ENCODING, f64::ENCODING, f64::ENCODING],
        );
    }

    /// 菜单栏是 24，状态栏图标 25，下拉菜单 101：放在中间，盖得住菜单栏，又不挡菜单
    const LEVEL: isize = 27;
    /// 所有桌面空间都在（1）、切空间时不动（16）、不进窗口循环（64）、全屏应用上也显示（256）
    const BEHAVIOR: usize = 1 | 16 | 64 | 256;
    /// 鼠标离开后等多少个 50 毫秒再收起，免得擦边时一开一合
    const LEAVE_TICKS: u32 = 6;
    /// 每多少个 50 毫秒重新读一次屏幕（插拔显示器、改分辨率后要挪位置）
    const SCREEN_TICKS: u32 = 40;

    /// 刘海所在的屏幕和窗口该放在哪（Cocoa 坐标）
    #[derive(Clone, Copy, Debug, Default)]
    struct Placement {
        geometry: Geometry,
        /// 刘海中线的 x、屏幕上沿的 y
        center_x: f64,
        top: f64,
    }

    #[derive(Default)]
    pub struct Island {
        /// 打开着（后台轮询靠它决定还要不要继续）
        open: AtomicBool,
        /// 轮询线程已经起了
        polling: AtomicBool,
        /// 上一次的轮询还没在主线程上跑完，这一次先跳过
        busy: AtomicBool,
        /// 页面画好第一帧了，可以显示
        ready: AtomicBool,
        /// 收起时两边伸出来了没有（计时没开始时只剩刘海本身）
        wings: AtomicBool,
        expanded: AtomicBool,
        /// 鼠标离开了几个 50 毫秒
        away: AtomicU32,
        tick: AtomicU32,
        placement: Mutex<Option<Placement>>,
    }

    fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        m.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn ns_window(win: &WebviewWindow) -> Option<*mut AnyObject> {
        win.ns_window()
            .ok()
            .map(|p| p as *mut AnyObject)
            .filter(|p| !p.is_null())
    }

    /// 找刘海：有刘海的屏幕（safeAreaInsets.top > 0）优先；都没有就用有菜单栏的主屏幕，
    /// 把菜单栏正中当作"刘海"，宽度算 0。只能在主线程上调
    unsafe fn find_screen() -> Option<Placement> {
        let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
        if screens.is_null() {
            return None;
        }
        let count: usize = msg_send![screens, count];
        let mut fallback = None;
        for i in 0..count {
            let screen: *mut AnyObject = msg_send![screens, objectAtIndex: i];
            if screen.is_null() {
                continue;
            }
            let frame: Rect = msg_send![screen, frame];
            let top = frame.origin.y + frame.size.h;
            // safeAreaInsets 是 macOS 12 才有的
            let can: Bool = msg_send![screen, respondsToSelector: sel!(safeAreaInsets)];
            if can.as_bool() {
                let insets: Insets = msg_send![screen, safeAreaInsets];
                if insets.top > 0.0 {
                    let left: Rect = msg_send![screen, auxiliaryTopLeftArea];
                    let right: Rect = msg_send![screen, auxiliaryTopRightArea];
                    let notch_w = (frame.size.w - left.size.w - right.size.w).max(0.0);
                    if notch_w > 0.0 {
                        return Some(Placement {
                            geometry: Geometry::new(true, notch_w, insets.top),
                            center_x: frame.origin.x + left.size.w + notch_w / 2.0,
                            top,
                        });
                    }
                }
            }
            // screens 的第一个是有菜单栏的那块
            if i == 0 {
                let visible: Rect = msg_send![screen, visibleFrame];
                let menu_bar = top - (visible.origin.y + visible.size.h);
                // 菜单栏设成自动隐藏时量出来是 0，按常见的高度算
                let height = if menu_bar >= 20.0 { menu_bar } else { 24.0 };
                fallback = Some(Placement {
                    geometry: Geometry::new(false, 0.0, height),
                    center_x: frame.origin.x + frame.size.w / 2.0,
                    top,
                });
            }
        }
        fallback
    }

    /// 窗口在 Cocoa 坐标里的位置
    fn frame_of(p: &Placement) -> Rect {
        let g = p.geometry;
        Rect {
            origin: Point {
                x: p.center_x - g.width / 2.0,
                y: p.top - g.height,
            },
            size: Size {
                w: g.width,
                h: g.height,
            },
        }
    }

    /// 层级、空间、阴影这些只设一次。只能在主线程上调
    unsafe fn configure(window: *mut AnyObject) {
        let _: () = msg_send![window, setLevel: LEVEL];
        let _: () = msg_send![window, setCollectionBehavior: BEHAVIOR];
        let _: () = msg_send![window, setHasShadow: Bool::NO];
        let _: () = msg_send![window, setIgnoresMouseEvents: Bool::YES];
    }

    unsafe fn set_frame(window: *mut AnyObject, frame: Rect) {
        let _: () = msg_send![window, setFrame: frame, display: Bool::YES];
    }

    /// 重新读屏幕，位置变了就挪窗口，并把新的大小告诉页面。只能在主线程上调
    fn relocate(app: &AppHandle, state: &Island, win: &WebviewWindow, force: bool) {
        let Some(window) = ns_window(win) else {
            return;
        };
        let Some(next) = (unsafe { find_screen() }) else {
            return;
        };
        let mut placement = lock(&state.placement);
        let changed = match *placement {
            Some(p) => {
                p.geometry != next.geometry
                    || (p.center_x - next.center_x).abs() > 0.5
                    || (p.top - next.top).abs() > 0.5
            }
            None => true,
        };
        if !changed && !force {
            return;
        }
        *placement = Some(next);
        drop(placement);
        unsafe { set_frame(window, frame_of(&next)) };
        let _ = app.emit("island-geometry", next.geometry);
    }

    /// 鼠标在不在能"摸到"的那一块里
    fn hovering(p: &Placement, mouse: Point, expanded: bool, wings: bool) -> bool {
        let (half, depth) = if expanded {
            p.geometry.expanded_zone()
        } else {
            p.geometry.collapsed_zone(wings)
        };
        (mouse.x - p.center_x).abs() <= half && mouse.y <= p.top + 1.0 && mouse.y >= p.top - depth
    }

    /// 每 50 毫秒在主线程上跑一次：鼠标进来就展开、接鼠标；离开一会儿就收起、穿透
    fn tick(app: &AppHandle) {
        let state = app.state::<Island>();
        let Some(win) = app.get_webview_window(ISLAND) else {
            return;
        };
        let n = state.tick.fetch_add(1, Ordering::Relaxed);
        if n % SCREEN_TICKS == 0 {
            relocate(app, &state, &win, false);
        }
        let Some(placement) = *lock(&state.placement) else {
            return;
        };
        let mouse: Point = unsafe { msg_send![class!(NSEvent), mouseLocation] };
        let expanded = state.expanded.load(Ordering::SeqCst);
        let inside = hovering(
            &placement,
            mouse,
            expanded,
            state.wings.load(Ordering::SeqCst),
        );
        let want = if inside {
            state.away.store(0, Ordering::SeqCst);
            true
        } else if expanded {
            state.away.fetch_add(1, Ordering::SeqCst) + 1 < LEAVE_TICKS
        } else {
            false
        };
        if want == expanded {
            return;
        }
        state.expanded.store(want, Ordering::SeqCst);
        let Some(window) = ns_window(&win) else {
            return;
        };
        unsafe {
            let ignore = if want { Bool::NO } else { Bool::YES };
            let _: () = msg_send![window, setIgnoresMouseEvents: ignore];
            // 收起时，如果刚才点了刘海上的按钮让 ingwork 成了前台，把前台还给原来的软件
            if !want {
                let key: Bool = msg_send![window, isKeyWindow];
                if key.as_bool() {
                    deactivate();
                }
            }
        }
        let _ = app.emit("island-hover", want);
    }

    /// 让出前台：ingwork 不再是当前软件，系统把前台还给之前用的那个。只能在主线程上调
    unsafe fn deactivate() {
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        if !ns_app.is_null() {
            let _: () = msg_send![ns_app, deactivate];
        }
    }

    /// 后台线程：打开期间每 50 毫秒让主线程查一次鼠标
    fn start_polling(app: &AppHandle) {
        let state = app.state::<Island>();
        if state.polling.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(50));
            let state = app.state::<Island>();
            if !state.open.load(Ordering::SeqCst) {
                state.polling.store(false, Ordering::SeqCst);
                break;
            }
            if state.busy.swap(true, Ordering::SeqCst) {
                continue;
            }
            let handle = app.clone();
            let queued = app.run_on_main_thread(move || {
                autoreleasepool(|_| tick(&handle));
                handle.state::<Island>().busy.store(false, Ordering::SeqCst);
            });
            if queued.is_err() {
                state.busy.store(false, Ordering::SeqCst);
            }
        });
    }

    fn build(app: &AppHandle) -> Result<WebviewWindow, String> {
        let config = app
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == ISLAND)
            .cloned()
            .ok_or_else(|| "刘海番茄的窗口配置找不到了".to_string())?;
        tauri::WebviewWindowBuilder::from_config(app, &config)
            .and_then(|builder| builder.build())
            .map_err(|_| "刘海番茄没能打开，请再试一次".to_string())
    }

    /// 页面画好以后显示。用 orderFrontRegardless：显示出来但不抢前台
    fn reveal(app: &AppHandle) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let state = handle.state::<Island>();
            if !state.open.load(Ordering::SeqCst) || !state.ready.load(Ordering::SeqCst) {
                return;
            }
            let Some(win) = handle.get_webview_window(ISLAND) else {
                return;
            };
            if let Some(window) = ns_window(&win) {
                unsafe {
                    let _: () = msg_send![window, orderFrontRegardless];
                }
            }
        });
    }

    pub async fn apply(app: AppHandle, open: bool) -> Result<(), String> {
        let state = app.state::<Island>();
        let existing = app.get_webview_window(ISLAND);
        if !open {
            state.open.store(false, Ordering::SeqCst);
            state.expanded.store(false, Ordering::SeqCst);
            if let Some(win) = existing {
                let _ = win.close();
            }
            state.ready.store(false, Ordering::SeqCst);
            *lock(&state.placement) = None;
            crate::island_changed(&app, false);
            return Ok(());
        }
        if state.open.swap(true, Ordering::SeqCst) && existing.is_some() {
            return Ok(());
        }
        let win = match existing {
            Some(win) => win,
            None => {
                state.ready.store(false, Ordering::SeqCst);
                build(&app)?
            }
        };
        let handle = app.clone();
        let target = win.clone();
        app.run_on_main_thread(move || {
            let Some(window) = ns_window(&target) else {
                return;
            };
            unsafe { configure(window) };
            let state = handle.state::<Island>();
            state.expanded.store(false, Ordering::SeqCst);
            relocate(&handle, &state, &target, true);
        })
        .map_err(|_| "刘海番茄没能打开，请再试一次".to_string())?;
        start_polling(&app);
        reveal(&app);
        crate::island_changed(&app, true);
        Ok(())
    }

    pub fn ready(app: &AppHandle) {
        app.state::<Island>().ready.store(true, Ordering::SeqCst);
        reveal(app);
    }

    pub fn set_wings(app: &AppHandle, shown: bool) {
        app.state::<Island>().wings.store(shown, Ordering::SeqCst);
    }

    pub fn geometry(app: &AppHandle) -> Option<Geometry> {
        lock(&app.state::<Island>().placement).map(|p| p.geometry)
    }
}

#[cfg(target_os = "macos")]
pub use mac::Island;

/// 别的系统上什么都不存
#[cfg(not(target_os = "macos"))]
#[derive(Default)]
pub struct Island;

/// 打开或关掉刘海番茄。创建窗口要在 async 命令里（同步命令里建窗口在 Windows 上会卡死，Mac 上也照做）
#[tauri::command]
pub async fn island_apply(app: tauri::AppHandle, open: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mac::apply(app, open).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        if open {
            Err("刘海番茄只有 Mac 上能用".to_string())
        } else {
            Ok(())
        }
    }
}

/// 页面画好第一帧了，可以显示
#[tauri::command]
pub fn island_ready(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    mac::ready(&app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// 收起时两边伸不伸出来（计时没开始时只剩刘海本身，鼠标要摸到刘海才展开）
#[tauri::command]
pub fn island_wings(app: tauri::AppHandle, shown: bool) {
    #[cfg(target_os = "macos")]
    mac::set_wings(&app, shown);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, shown);
}

/// 刘海和窗口的大小。还没放好时是 null，页面等 island-geometry 事件
#[tauri::command]
pub fn island_geometry(app: tauri::AppHandle) -> Option<Geometry> {
    #[cfg(target_os = "macos")]
    {
        mac::geometry(&app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notch_geometry() {
        // MacBook Air 13 寸的刘海大约 185 × 32 点
        let g = Geometry::new(true, 185.0, 32.0);
        assert_eq!(g.width, 185.0 + 260.0 + 24.0);
        assert_eq!(g.height, 32.0 + 116.0);
        // 计时没开始：只有刘海本身摸得到
        assert_eq!(g.collapsed_zone(false), (92.5, 36.0));
        assert_eq!(g.collapsed_zone(true), (92.5 + WING, 36.0));
        assert_eq!(g.expanded_zone(), (g.width / 2.0 - SHOULDER, g.height));
    }

    #[test]
    fn no_notch_is_a_pill() {
        // 没有刘海：菜单栏正中一颗胶囊，两边一直伸出来，面板不窄于最小宽度
        let g = Geometry::new(false, 0.0, 24.0);
        assert_eq!(g.width, MIN_WIDTH + 24.0);
        assert_eq!(g.collapsed_zone(false), (WING, 28.0));
    }
}
