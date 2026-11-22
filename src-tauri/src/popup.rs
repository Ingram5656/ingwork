//! 小窗：翻译和杂念箱。按快捷键在鼠标所在的屏幕上方呼出，点到别处就收起。
//!
//! 呼出、收起、大小跟着页面走的做法都来自 ingtranslate（lib.rs 里的 show_window / hide_window / fit_window），
//! 只是从一个窗口变成了两个，宽度不同。尺寸和位置的算法在 logic.rs 里，带测试。
//!
//! 两个窗口在 tauri.conf.json 里写着 "create": false，第一次呼出时才创建；之后收起只是隐藏，下次呼出不用等。
//! 收起后 10 分钟没再用就把窗口关掉，把网页内核占的内存还给系统。
//!
//! Mac 上有两处不一样：
//! - 鼠标位置用 Tauri 自己的接口取（Windows 上沿用 ingtranslate 的 GetCursorPos）
//! - 在别的软件里呼出时，先记下当时在最前面的是哪个软件；用完收起后把前台还给它，焦点才会回去，
//!   不然 ingwork 还是当前软件，只是看不见窗口，用户得再点一下原来的软件才能接着打字。
//!   以前的做法是把整个 ingwork 藏起来（相当于 ⌘H），但藏起来以后再呼出，系统不一定让 ingwork 回到前台，
//!   小窗就出不来了；主窗口也会跟着一起冒出来

use serde::Serialize;
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicI32;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::logic::{clamp_scale, layout, summon_position, Area, SCREEN_MARGIN};

pub const TRANSLATE: &str = "translate";
pub const CAPTURE: &str = "capture";

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Clone, Copy)]
struct Page {
    width: f64,
    height: f64,
    dpr: f64,
    zoom: f64,
}

/// 一个小窗的状态
struct Slot {
    /// 页面最近一次量出来的窗口大小（物理像素）、它的 devicePixelRatio 和界面缩放
    page: Mutex<Page>,
    /// 上次呼出的时间；刚呼出的一瞬间丢掉的焦点不算数
    shown_at: Mutex<Option<Instant>>,
    /// 每次呼出或收起加一，用来作废还在等动画的"隐藏窗口"
    hide_ticket: AtomicU64,
    /// 点了图钉：失去焦点时不收起
    pinned: AtomicBool,
    /// 页面加载完了
    ready: AtomicBool,
    /// 页面还没加载完时就被呼出了，加载完要接着呼出
    pending: AtomicBool,
}

impl Slot {
    fn new(width: f64, height: f64) -> Self {
        Self {
            page: Mutex::new(Page {
                width,
                height,
                dpr: 1.0,
                zoom: 1.0,
            }),
            shown_at: Mutex::new(None),
            hide_ticket: AtomicU64::new(0),
            pinned: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            pending: AtomicBool::new(false),
        }
    }
}

pub struct Popups {
    translate: Slot,
    capture: Slot,
    /// 呼出翻译时填入新复制的文字
    read_clipboard: AtomicBool,
    /// 上次看到的剪贴板内容，没变就不重复填
    last_clip: Mutex<String>,
    /// Mac：呼出时在最前面的那个软件的进程号（是 ingwork 自己时为 0）。收起后把前台还给它
    #[cfg(target_os = "macos")]
    previous: AtomicI32,
}

impl Default for Popups {
    fn default() -> Self {
        Self {
            translate: Slot::new(728.0, 220.0),
            capture: Slot::new(608.0, 160.0),
            read_clipboard: AtomicBool::new(true),
            last_clip: Mutex::new(read_clipboard()),
            #[cfg(target_os = "macos")]
            previous: AtomicI32::new(0),
        }
    }
}

impl Popups {
    fn slot(&self, label: &str) -> &Slot {
        if label == CAPTURE {
            &self.capture
        } else {
            &self.translate
        }
    }
}

fn is_popup(label: &str) -> bool {
    label == TRANSLATE || label == CAPTURE
}

// ---------- 剪贴板 ----------

fn read_clipboard() -> String {
    arboard::Clipboard::new()
        .and_then(|mut c| c.get_text())
        .unwrap_or_default()
        .trim()
        .to_string()
}

// ---------- 屏幕 ----------

/// 鼠标在屏幕上的位置（物理像素）
#[cfg(windows)]
fn cursor_position(_win: &WebviewWindow) -> Option<(i32, i32)> {
    let mut p = windows::Win32::Foundation::POINT::default();
    unsafe { windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut p) }.ok()?;
    Some((p.x, p.y))
}

/// 鼠标在屏幕上的位置（物理像素）。Mac 上用 Tauri 自己的接口，坐标和 available_monitors 是同一套
#[cfg(not(windows))]
fn cursor_position(win: &WebviewWindow) -> Option<(i32, i32)> {
    let p = win.cursor_position().ok()?;
    Some((p.x.round() as i32, p.y.round() as i32))
}

/// 窗口该用哪块屏幕：呼出时用鼠标所在的那块，其余时候用窗口现在所在的那块
fn monitor_area(win: &WebviewWindow, at_cursor: bool) -> Option<Area> {
    let to_area = |p: &PhysicalPosition<i32>, s: &PhysicalSize<u32>, sf: f64| Area {
        x: p.x as f64,
        y: p.y as f64,
        w: s.width as f64,
        h: s.height as f64,
        sf,
    };
    if at_cursor {
        if let (Some((cx, cy)), Ok(monitors)) = (cursor_position(win), win.available_monitors()) {
            for m in monitors.iter() {
                let (p, s) = (m.position(), m.size());
                if cx >= p.x && cx < p.x + s.width as i32 && cy >= p.y && cy < p.y + s.height as i32
                {
                    return Some(to_area(p, s, m.scale_factor()));
                }
            }
        }
    }
    let m = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten())?;
    Some(to_area(m.position(), m.size(), m.scale_factor()))
}

fn set_bounds(win: &WebviewWindow, x: i32, y: i32, w: u32, h: u32) {
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = win.set_size(PhysicalSize::new(w, h));
    // 有的系统上"不可调整大小"的窗口改不了尺寸：临时打开再改一次，改完关回去
    if win
        .outer_size()
        .map_or(false, |s| s.width != w || s.height != h)
    {
        let _ = win.set_resizable(true);
        let _ = win.set_size(PhysicalSize::new(w, h));
        let _ = win.set_resizable(false);
    }
}

fn build(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == label)
        .cloned()
        .ok_or_else(|| "小窗的配置找不到了".to_string())?;
    let window = WebviewWindowBuilder::from_config(app, &config)
        .and_then(|builder| builder.build())
        .map_err(|_| "小窗没能打开，请再试一次".to_string())?;
    #[cfg(target_os = "macos")]
    let _ = window.set_visible_on_all_workspaces(true);
    Ok(window)
}

// ---------- 呼出、收起 ----------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Summoned {
    /// 新复制的文字（只有翻译用）
    clip: String,
    /// 面板最多能有多高（未缩放）
    max_panel: f64,
}

/// 呼出：放到鼠标所在屏幕的上方正中，通知页面播放进场动画。
/// 窗口还没建：先建，等页面加载完（popup_ready）再接着呼出。
fn show(app: &AppHandle, label: &str) -> Result<(), String> {
    let popups = app.state::<Popups>();
    let slot = popups.slot(label);
    slot.hide_ticket.fetch_add(1, Ordering::SeqCst);

    let Some(win) = app.get_webview_window(label) else {
        slot.pending.store(true, Ordering::SeqCst);
        build(app, label)?;
        return Ok(());
    };
    if !slot.ready.load(Ordering::SeqCst) {
        slot.pending.store(true, Ordering::SeqCst);
        return Ok(());
    }

    let page = *lock(&slot.page);
    let mut max_panel = 0.0;
    if let Some(area) = monitor_area(&win, true) {
        // 先用上次量的大小。换到缩放不一样的屏幕时，页面呼出后会马上再量一次（popup_fit）
        let l = layout(page.width, page.height, page.zoom, page.dpr, &area);
        let (x, y) = summon_position(&l, &area);
        max_panel = l.max_panel;
        set_bounds(&win, x as i32, y as i32, l.width as u32, l.height as u32);
    }

    // 翻译：剪贴板里有新复制的文字（和上次看到的不一样）就带过去直接翻译
    let mut clip = String::new();
    if label == TRANSLATE && popups.read_clipboard.load(Ordering::SeqCst) {
        let now = read_clipboard();
        let mut last = lock(&popups.last_clip);
        if !now.is_empty() && now != *last && now.chars().count() <= 5000 {
            clip = now.clone();
        }
        *last = now;
    }

    // Mac：记下现在在最前面的软件，收起时把前台还给它。
    // 被 ⌘H 藏起来的 ingwork 要先显示回来（不抢前台），不然小窗出不来。
    // 这一步排在主线程上，比下面的 show、set_focus 先跑
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || unsafe {
            focus::unhide();
            let pid = focus::frontmost_other();
            handle
                .state::<Popups>()
                .previous
                .store(pid, Ordering::SeqCst);
        });
    }

    *lock(&slot.shown_at) = Some(Instant::now());
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit(&format!("{label}-summoned"), Summoned { clip, max_panel });
    Ok(())
}

/// 收起：先让页面播放退场动画，200 毫秒后再真的隐藏窗口
pub fn hide(app: &AppHandle, label: &str) {
    let Some(win) = app.get_webview_window(label) else {
        return;
    };
    if !win.is_visible().unwrap_or(false) {
        return;
    }
    let _ = app.emit(&format!("{label}-dismiss"), ());
    let ticket = app
        .state::<Popups>()
        .slot(label)
        .hide_ticket
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let app = app.clone();
    let label = label.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        // 这 200 毫秒里又被呼出了：不隐藏
        if app
            .state::<Popups>()
            .slot(&label)
            .hide_ticket
            .load(Ordering::SeqCst)
            != ticket
        {
            return;
        }
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.hide();
        }
        #[cfg(target_os = "macos")]
        give_focus_back(&app);

        // 收起后 10 分钟没再用：把窗口整个关掉，网页内核占的内存还给系统。下次呼出再建，只慢零点几秒
        std::thread::sleep(RELEASE_AFTER);
        let popups = app.state::<Popups>();
        let slot = popups.slot(&label);
        if slot.hide_ticket.load(Ordering::SeqCst) != ticket {
            return;
        }
        if let Some(win) = app.get_webview_window(&label) {
            if !win.is_visible().unwrap_or(true) {
                slot.ready.store(false, Ordering::SeqCst);
                slot.pending.store(false, Ordering::SeqCst);
                let _ = win.destroy();
            }
        }
    });
}

/// 小窗收起多久没用就关掉
const RELEASE_AFTER: Duration = Duration::from_secs(10 * 60);

/// Mac：小窗是从别的软件里呼出的，收起后把前台还给那个软件，可以接着打字。
/// 另一个小窗还开着时不还（焦点在它身上）
#[cfg(target_os = "macos")]
fn give_focus_back(app: &AppHandle) {
    let visible = |label: &str| {
        app.get_webview_window(label)
            .map_or(false, |w| w.is_visible().unwrap_or(false))
    };
    if visible(TRANSLATE) || visible(CAPTURE) {
        return;
    }
    let pid = app.state::<Popups>().previous.swap(0, Ordering::SeqCst);
    if pid == 0 {
        return;
    }
    let _ = app.run_on_main_thread(move || unsafe { focus::activate(pid) });
}

/// Mac 上和前台有关的几个系统调用。都只能在主线程上调
#[cfg(target_os = "macos")]
mod focus {
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};

    /// 现在在最前面的软件的进程号；是 ingwork 自己或者取不到时返回 0
    pub unsafe fn frontmost_other() -> i32 {
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        if workspace.is_null() {
            return 0;
        }
        let front: *mut AnyObject = msg_send![workspace, frontmostApplication];
        if front.is_null() {
            return 0;
        }
        let pid: i32 = msg_send![front, processIdentifier];
        if pid <= 0 || pid as u32 == std::process::id() {
            0
        } else {
            pid
        }
    }

    /// 把前台交给进程号是 pid 的软件。它已经退出了就什么都不做
    pub unsafe fn activate(pid: i32) {
        let other: *mut AnyObject = msg_send![
            class!(NSRunningApplication),
            runningApplicationWithProcessIdentifier: pid
        ];
        if other.is_null() {
            return;
        }
        let _: Bool = msg_send![other, activateWithOptions: 0usize];
    }

    /// ingwork 被 ⌘H 藏起来了：不抢前台地显示回来
    pub unsafe fn unhide() {
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        if ns_app.is_null() {
            return;
        }
        let hidden: Bool = msg_send![ns_app, isHidden];
        if hidden.as_bool() {
            let _: () = msg_send![ns_app, unhideWithoutActivation];
        }
    }
}

/// 窗口事件：点到别的窗口就收起（点了图钉的不收）；Alt+F4 只是收起
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let label = window.label();
    if !is_popup(label) {
        return;
    }
    let app = window.app_handle();
    match event {
        tauri::WindowEvent::Focused(false) => {
            let popups = app.state::<Popups>();
            let slot = popups.slot(label);
            if slot.pinned.load(Ordering::SeqCst) {
                return;
            }
            // 刚呼出的一瞬间系统可能先把焦点给了别人，这种不算
            let shown_at = *lock(&slot.shown_at);
            let just_shown = shown_at.map_or(false, |t| t.elapsed() < Duration::from_millis(250));
            if just_shown {
                return;
            }
            hide(app, label);
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            hide(app, label);
        }
        _ => {}
    }
}

// ---------- 命令 ----------

fn check(label: &str) -> Result<(), String> {
    if is_popup(label) {
        Ok(())
    } else {
        Err("没有这个小窗".to_string())
    }
}

/// 快捷键：开着并且在最前面就收起，否则呼出。
/// 第一次呼出要创建窗口，在 Windows 上同步命令里创建窗口会卡死，所以是 async 的
#[tauri::command]
pub async fn popup_toggle(app: AppHandle, label: String) -> Result<(), String> {
    check(&label)?;
    let front = app.get_webview_window(&label).map_or(false, |w| {
        w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false)
    });
    if front {
        hide(&app, &label);
        Ok(())
    } else {
        show(&app, &label)
    }
}

#[tauri::command]
pub async fn popup_show(app: AppHandle, label: String) -> Result<(), String> {
    check(&label)?;
    show(&app, &label)
}

#[tauri::command]
pub fn popup_hide(app: AppHandle, label: String) {
    if is_popup(&label) {
        hide(&app, &label);
    }
}

/// 小窗的页面加载完了。加载期间被呼出过的话，现在接着呼出
#[tauri::command]
pub fn popup_ready(app: AppHandle, popups: State<Popups>, label: String) -> Result<(), String> {
    check(&label)?;
    let slot = popups.slot(&label);
    slot.ready.store(true, Ordering::SeqCst);
    if slot.pending.swap(false, Ordering::SeqCst) {
        show(&app, &label)?;
    }
    Ok(())
}

/// 页面大小变了（内容、缩放变了，或者换到了缩放不一样的屏幕）：调整窗口大小，返回面板最多能有多高。
/// 宽高是页面按自己实际的 devicePixelRatio（`dpr`）换算好的物理像素，直接用，不再按屏幕缩放算。
/// 水平方向保持中心不动、顶边不动；下边超出屏幕才往上挪
#[tauri::command]
pub fn popup_fit(
    app: AppHandle,
    popups: State<Popups>,
    label: String,
    width: f64,
    height: f64,
    dpr: f64,
    zoom: f64,
) -> f64 {
    let finite = width.is_finite() && height.is_finite() && dpr.is_finite() && dpr > 0.0;
    if !is_popup(&label) || !finite {
        return 0.0;
    }
    let page = Page {
        width: width.max(200.0),
        height: height.max(100.0),
        dpr,
        zoom: clamp_scale(zoom),
    };
    *lock(&popups.slot(&label).page) = page;
    let Some(win) = app.get_webview_window(&label) else {
        return 0.0;
    };
    let Some(area) = monitor_area(&win, false) else {
        return 0.0;
    };
    let l = layout(page.width, page.height, page.zoom, page.dpr, &area);
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
        return l.max_panel;
    };
    let (w, h) = (l.width as i32, l.height as i32);
    if (w - size.width as i32).abs() <= 1 && (h - size.height as i32).abs() <= 1 {
        return l.max_panel;
    }
    let margin = (SCREEN_MARGIN * area.sf) as i32;
    let x = pos.x + (size.width as i32 - w) / 2;
    let lowest = (area.y + area.usable_h()) as i32 - margin - h;
    let y = pos.y.min(lowest).max(area.y as i32 + margin);
    set_bounds(&win, x, y, w as u32, h as u32);
    l.max_panel
}

#[tauri::command]
pub fn popup_pin(popups: State<Popups>, label: String, on: bool) {
    if is_popup(&label) {
        popups.slot(&label).pinned.store(on, Ordering::SeqCst);
    }
}

/// 主窗口把小窗相关的设置发过来：呼出翻译时要不要填入剪贴板（界面缩放由小窗自己量好报上来）
#[tauri::command]
pub fn popup_configure(popups: State<Popups>, read_clipboard: bool) {
    popups
        .read_clipboard
        .store(read_clipboard, Ordering::SeqCst);
}

/// 复制译文。顺便记下来，下次呼出时不会把自己的译文又填回去
#[tauri::command]
pub fn clipboard_write(popups: State<Popups>, text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text.clone()))
        .map_err(|_| "没复制上，请再试一次".to_string())?;
    *lock(&popups.last_clip) = text.trim().to_string();
    Ok(())
}
