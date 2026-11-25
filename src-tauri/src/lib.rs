//! 接线：命令、托盘、窗口、提醒。具体功能各在自己的文件里。
//! ingwork 从 ingclock 长出来：计时、任务、统计、小组件和 ingclock 一样；课表、截止日期、杂念箱、生词本在 planner.rs，
//! 翻译和杂念箱两个小窗在 popup.rs 和 translate.rs（从 ingtranslate 搬过来）。

mod ambient;
mod awake;
mod backup;
mod haptics;
mod island;
mod lecture;
mod legacy;
mod link;
mod location;
mod logger;
mod logic;
mod planner;
mod popup;
mod reminders;
mod sound;
mod stats;
mod tasks;
mod timer;
mod translate;
mod update;
mod widget;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent, Wry};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_notification::NotificationExt;

use ambient::AmbientConfig;
use sound::Sound;
use timer::{Config, Finished, Phase, Snapshot, Tick, Timer};

const TRAY_ID: &str = "ingwork";
const MAIN: &str = "main";

/// 托盘和系统通知上的文字。界面按当前语言发过来，这里的默认值是中文。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Texts {
    start: String,
    pause: String,
    skip: String,
    open: String,
    quit: String,
    focus: String,
    short_break: String,
    long_break: String,
    /// 托盘提示，带 {phase} 和 {time}
    running: String,
    paused: String,
    focus_done_title: String,
    focus_done_short: String,
    focus_done_long: String,
    break_done_title: String,
    break_done_body: String,
    widget_show: String,
    widget_hide: String,
    widget_lock: String,
    widget_unlock: String,
    sleep: String,
}

impl Default for Texts {
    fn default() -> Self {
        Self {
            start: "开始".into(),
            pause: "暂停".into(),
            skip: "跳过这一段".into(),
            open: "打开主窗口".into(),
            quit: "退出".into(),
            focus: "专注".into(),
            short_break: "短休息".into(),
            long_break: "长休息".into(),
            running: "{phase} · 还剩 {time}".into(),
            paused: "{phase} · 已暂停，还剩 {time}".into(),
            focus_done_title: "专注结束".into(),
            focus_done_short: "休息 5 分钟".into(),
            focus_done_long: "这一组完成了，休息 15 分钟".into(),
            break_done_title: "休息结束".into(),
            break_done_body: "开始下一段专注，25 分钟".into(),
            widget_show: "显示小组件".into(),
            widget_hide: "隐藏小组件".into(),
            widget_lock: "锁定小组件".into(),
            widget_unlock: "解锁小组件".into(),
            sleep: "睡眠模式".into(),
        }
    }
}

/// 托盘菜单里要改字的几项，和上一次显示的状态。
struct TrayState {
    toggle: MenuItem<Wry>,
    skip: MenuItem<Wry>,
    open: MenuItem<Wry>,
    quit: MenuItem<Wry>,
    widget: MenuItem<Wry>,
    lock: MenuItem<Wry>,
    sleep: MenuItem<Wry>,
    shown: Mutex<(Option<bool>, Option<Phase>)>,
}

/// 环境音的设置，和上一次告诉声音线程的内容（一样就不重复发）。
struct AmbientState {
    config: Mutex<AmbientConfig>,
    sent: Mutex<Option<Vec<(String, f32)>>>,
}

/// 按设置和计时状态决定现在该响哪些环境音：计时在走、而且是专注（或设了休息时也放）才响。
fn apply_ambient(app: &AppHandle, snap: &Snapshot) {
    let Some(state) = app.try_state::<AmbientState>() else {
        return;
    };
    let config = state
        .config
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let wanted = config.wanted(snap.running, snap.phase == Phase::Focus);
    {
        let mut sent = state.sent.lock().unwrap_or_else(|e| e.into_inner());
        if sent.as_ref() == Some(&wanted) {
            return;
        }
        *sent = Some(wanted.clone());
    }
    app.state::<Sound>().ambient(wanted);
}

/// 小组件现在的状态：(开着, 锁着)。托盘菜单上的字跟着它变。
struct WidgetFlags(Mutex<(bool, bool)>);

/// 小组件现在显示在 Mac 的刘海上。刘海番茄不能锁定，托盘菜单里的"锁定"一直置灰
static ON_NOTCH: AtomicBool = AtomicBool::new(false);

/// 这次是怎么启动的。
struct Launch {
    /// 开机自启带 --autostart，这时不弹主窗口
    autostart: bool,
    handled: AtomicBool,
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 按小组件的状态改托盘菜单上那两项的字。
fn refresh_widget_menu(app: &AppHandle) {
    let texts = current_texts(app);
    let (open, locked) = *app
        .state::<WidgetFlags>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(tray_state) = app.try_state::<TrayState>() else {
        return;
    };
    let widget_label = if open {
        texts.widget_hide.as_str()
    } else {
        texts.widget_show.as_str()
    };
    let lock_label = if locked {
        texts.widget_unlock.as_str()
    } else {
        texts.widget_lock.as_str()
    };
    let _ = tray_state.widget.set_text(widget_label);
    let _ = tray_state.lock.set_text(lock_label);
    // 小组件没开时，"锁定"点了也没用，置灰；刘海上的也不能锁
    let _ = tray_state
        .lock
        .set_enabled(open && !ON_NOTCH.load(Ordering::SeqCst));
}

/// 小组件开关或锁定状态变了（widget.rs 调用）。
pub(crate) fn widget_changed(app: &AppHandle, open: bool, locked: bool) {
    *app.state::<WidgetFlags>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = (open, locked);
    refresh_widget_menu(app);
}

/// 刘海番茄开了、关了（island.rs 调用）。托盘菜单上"显示 / 隐藏小组件"跟着它
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn island_changed(app: &AppHandle, open: bool) {
    ON_NOTCH.store(open, Ordering::SeqCst);
    widget_changed(app, open, false);
}

/// 离开了一段没走完的专注（跳过、重置、切阶段）：走过的时间记进统计，不算番茄。
fn left_focus(app: &AppHandle, focused_ms: Option<u64>) {
    if let Some(ms) = focused_ms {
        stats::record(app, ms, false);
    }
}

/// 退出软件。正在进行的专注先记下来，免得这段时间丢了。
/// Mac：只在菜单栏显示，不占 Dock 和 ⌘Tab。别的系统上什么都不做
#[tauri::command]
fn set_dock_hidden(app: AppHandle, hidden: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if hidden {
            tauri::ActivationPolicy::Accessory
        } else {
            tauri::ActivationPolicy::Regular
        };
        let _ = app.set_activation_policy(policy);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, hidden);
}

pub(crate) fn exit_app(app: &AppHandle) {
    before_exit(app);
    app.exit(0);
}

/// 退出或重启之前：把没走完的专注记下来，告诉 ingfy 下线了
pub(crate) fn before_exit(app: &AppHandle) {
    left_focus(app, app.state::<Timer>().focused_so_far());
    app.state::<link::Link>().goodbye();
}

/// 执行 ingfy 灵动岛上点的按钮
fn run_link_command(app: &AppHandle, command: &link::Command) {
    let timer = app.state::<Timer>();
    let snap = match command.cmd.as_str() {
        "toggle" => timer.toggle(),
        "start" => timer.start(),
        "extend" => timer.extend(command.minutes.unwrap_or(5)),
        "skip" => {
            let (snap, left) = timer.skip();
            left_focus(app, left);
            snap
        }
        _ => return,
    };
    publish(app, &snap);
}

/// 托盘图标。Windows 用黑底方块（和应用图标一样）；
/// Mac 菜单栏的习惯是单色"模板图标"，深色、浅色菜单栏系统会自动给它换颜色
#[cfg(not(target_os = "macos"))]
fn tray_icon_bytes(phase: Phase) -> &'static [u8] {
    match phase {
        Phase::Focus => &include_bytes!("../icons/tray-focus.png")[..],
        Phase::ShortBreak => &include_bytes!("../icons/tray-short.png")[..],
        Phase::LongBreak => &include_bytes!("../icons/tray-long.png")[..],
    }
}

#[cfg(target_os = "macos")]
fn tray_icon_bytes(phase: Phase) -> &'static [u8] {
    match phase {
        Phase::Focus => &include_bytes!("../icons/tray-mac-focus.png")[..],
        Phase::ShortBreak => &include_bytes!("../icons/tray-mac-short.png")[..],
        Phase::LongBreak => &include_bytes!("../icons/tray-mac-long.png")[..],
    }
}

fn current_texts(app: &AppHandle) -> Texts {
    app.state::<Mutex<Texts>>()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// 剩余时间写成 24:34
fn clock_text(snap: &Snapshot) -> String {
    let secs = (snap.remaining_ms + 999) / 1000;
    format!("{:02}:{:02}", secs / 60, secs % 60)
}

fn tooltip(snap: &Snapshot, texts: &Texts) -> String {
    let time = clock_text(snap);
    let phase = match snap.phase {
        Phase::Focus => &texts.focus,
        Phase::ShortBreak => &texts.short_break,
        Phase::LongBreak => &texts.long_break,
    };
    let template = if snap.running {
        &texts.running
    } else {
        &texts.paused
    };
    template.replace("{phase}", phase).replace("{time}", &time)
}

/// 把当前状态告诉界面，并更新托盘。每次状态有变化都走这里。
/// 调用时不能拿着任何锁：改托盘要回到主线程去做。
fn publish(app: &AppHandle, snap: &Snapshot) {
    let _ = app.emit("timer-state", snap);
    // Mac：计时在走时别让系统拖慢 ingwork
    awake::keep(snap.running);
    apply_ambient(app, snap);
    // 告诉 ingfy（灵动岛）现在的状态
    if let Some(link) = app.try_state::<link::Link>() {
        link.write(snap, || tasks::current_name(app));
    }

    let texts = current_texts(app);
    let Some(tray_state) = app.try_state::<TrayState>() else {
        return;
    };
    let (running_changed, phase_changed) = {
        let mut shown = tray_state.shown.lock().unwrap_or_else(|e| e.into_inner());
        let changed = (shown.0 != Some(snap.running), shown.1 != Some(snap.phase));
        *shown = (Some(snap.running), Some(snap.phase));
        changed
    };
    if running_changed {
        let label = if snap.running {
            texts.pause.as_str()
        } else {
            texts.start.as_str()
        };
        let _ = tray_state.toggle.set_text(label);
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if phase_changed {
            if let Ok(icon) = Image::from_bytes(tray_icon_bytes(snap.phase)) {
                let _ = tray.set_icon(Some(icon));
                // 换了图标要重新说一次它是模板图标（只有 Mac 有用）
                let _ = tray.set_icon_as_template(cfg!(target_os = "macos"));
            }
        }
        let _ = tray.set_tooltip(Some(tooltip(snap, &texts)));
        // Mac 的菜单栏图标旁边可以直接显示文字：剩余时间一直挂在那里，不用把鼠标移上去
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(Some(clock_text(snap)));
    }
}

/// 一段自然走完：提示音、系统通知、叫出窗口。
/// 提醒不只靠声音，通知和窗口至少有一个能提醒到人。
fn phase_finished(app: &AppHandle, finished: &Finished, config: &Config, snap: &Snapshot) {
    let texts = current_texts(app);
    let task = tasks::current_name(app);

    // 走完的是专注：记进统计，再给当前任务记一个番茄。加时只记时长
    if finished.finished == Phase::Focus {
        stats::record(app, finished.focused_ms, !finished.bonus);
        if !finished.bonus {
            tasks::pomodoro_done(app);
        }
    }

    // ingfy 的灵动岛开着：由它展开提醒，这边就不再弹通知、不叫出主窗口了（提示音照响）
    let link = app.state::<link::Link>();
    link.note_finished(finished, snap, task);
    let island = link.island();

    if config.sound != "none" && !config.sound.is_empty() {
        app.state::<Sound>().play(&config.sound, config.volume);
    }
    if config.notify && !island {
        let (title, body) = match (finished.finished, finished.next) {
            (Phase::Focus, Phase::LongBreak) => (
                texts.focus_done_title.clone(),
                texts.focus_done_long.clone(),
            ),
            (Phase::Focus, _) => (
                texts.focus_done_title.clone(),
                texts.focus_done_short.clone(),
            ),
            _ => (
                texts.break_done_title.clone(),
                texts.break_done_body.clone(),
            ),
        };
        let _ = app.notification().builder().title(title).body(body).show();
    }
    if config.raise_window && !island {
        show_main(app);
    }
    let _ = app.emit("phase-finished", finished);
}

/// 看任务和专注记录有没有被别人改过：AI 的接口、别的电脑（数据文件夹在网盘里时）。
/// 单独一个线程：网盘的文件有时要现下载，读一下要等几秒，不能卡住计时。
fn spawn_data_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut beat: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            beat = beat.wrapping_add(1);
            // 待办 2 秒、课表 4 秒、统计 6 秒看一次。数据文件夹多半在网盘里，看得太勤，
            // 网盘的后台进程（尤其 Mac 上的 OneDrive）会一直忙；隔几秒同步过来也不耽误事
            if beat % 2 == 0 {
                tasks::poll_external(&app);
            }
            if beat % 4 == 1 {
                planner::poll_external(&app);
            }
            if beat % 6 == 3 {
                stats::poll_external(&app);
            }
        }
    });
}

fn spawn_ticker(app: AppHandle, timer: Timer) {
    let mut beat: u32 = 0;
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(200));
        beat = beat.wrapping_add(1);
        if beat % 5 == 0 {
            // 上课提醒到点了没有
            reminders::check(&app);
            // ingfy 的灵动岛开没开变了：告诉界面（小组件要不要让位）
            if let Some(island) = app.state::<link::Link>().poll_island() {
                let _ = app.emit("ingfy-island", island);
            }
        }
        // 灵动岛上点的按钮
        if let Some(command) = app.state::<link::Link>().take_command() {
            run_link_command(&app, &command);
        }
        match timer.tick() {
            Tick::Idle => {
                if app.state::<link::Link>().needs_heartbeat() {
                    publish(&app, &timer.snapshot());
                }
            }
            Tick::Second(snap) => publish(&app, &snap),
            Tick::Finished(finished, config, snap) => {
                phase_finished(&app, &finished, &config, &snap);
                publish(&app, &snap);
            }
        }
    });
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let texts = Texts::default();
    let toggle = MenuItem::with_id(app, "toggle", &texts.start, true, None::<&str>)?;
    let skip = MenuItem::with_id(app, "skip", &texts.skip, true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", &texts.open, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", &texts.quit, true, None::<&str>)?;
    let widget = MenuItem::with_id(app, "widget", &texts.widget_show, true, None::<&str>)?;
    let lock = MenuItem::with_id(app, "lock", &texts.widget_lock, false, None::<&str>)?;
    let sleep = MenuItem::with_id(app, "sleep", &texts.sleep, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &toggle,
            &skip,
            &separator,
            &widget,
            &lock,
            &sleep,
            &separator2,
            &open,
            &quit,
        ],
    )?;

    #[allow(deprecated)]
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("ingwork")
        .icon_as_template(cfg!(target_os = "macos"))
        .menu(&menu)
        // Windows：左键打开主窗口，右键才出菜单。Mac：点一下就出菜单，这是菜单栏图标的习惯
        .menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => {
                let snap = app.state::<Timer>().toggle();
                publish(app, &snap);
            }
            "skip" => {
                let (snap, left) = app.state::<Timer>().skip();
                left_focus(app, left);
                publish(app, &snap);
            }
            // 小组件开不开、锁不锁记在界面的设置里，这里只是告诉界面"点了这一项"
            "widget" => {
                let _ = app.emit("tray-command", "widget-toggle");
            }
            "lock" => {
                let _ = app.emit("tray-command", "widget-lock");
            }
            // 睡眠模式在主窗口里：先把主窗口叫出来，再告诉界面
            "sleep" => {
                show_main(app);
                let _ = app.emit("tray-command", "sleep-toggle");
            }
            "open" => show_main(app),
            "quit" => exit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if cfg!(target_os = "macos") {
                return;
            }
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    let icon = Image::from_bytes(tray_icon_bytes(Phase::Focus))
        .ok()
        .or_else(|| app.default_window_icon().cloned());
    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }
    builder.build(app)?;

    app.manage(TrayState {
        toggle,
        skip,
        open,
        quit,
        widget,
        lock,
        sleep,
        shown: Mutex::new((None, None)),
    });
    Ok(())
}

// ---------- 命令 ----------

/// 界面画好第一帧后调用。正常启动这时才显示主窗口，免得闪一下白；
/// 开机自启时不显示，留在托盘。
#[tauri::command]
fn frontend_ready(app: AppHandle, launch: State<Launch>) {
    if launch.handled.swap(true, Ordering::SeqCst) {
        return;
    }
    if !launch.autostart {
        show_main(&app);
    }
}

#[tauri::command]
fn timer_get(timer: State<Timer>) -> Snapshot {
    timer.snapshot()
}

#[tauri::command]
fn timer_toggle(app: AppHandle, timer: State<Timer>) -> Snapshot {
    let snap = timer.toggle();
    publish(&app, &snap);
    snap
}

#[tauri::command]
fn timer_skip(app: AppHandle, timer: State<Timer>) -> Snapshot {
    let (snap, left) = timer.skip();
    left_focus(&app, left);
    publish(&app, &snap);
    snap
}

#[tauri::command]
fn timer_reset(app: AppHandle, timer: State<Timer>) -> Snapshot {
    let (snap, left) = timer.reset();
    left_focus(&app, left);
    publish(&app, &snap);
    snap
}

#[tauri::command]
fn timer_set_phase(app: AppHandle, timer: State<Timer>, phase: Phase) -> Snapshot {
    let (snap, left) = timer.set_phase(phase);
    left_focus(&app, left);
    publish(&app, &snap);
    snap
}

/// 只改这一段的长度（离下节课不够一个完整番茄时），不动设置
#[tauri::command]
fn timer_set_length(app: AppHandle, timer: State<Timer>, minutes: u32) -> Snapshot {
    let snap = timer.set_length(minutes);
    publish(&app, &snap);
    snap
}

/// 发一条系统通知（上课提醒用）
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) {
    let _ = app.notification().builder().title(title).body(body).show();
}

#[tauri::command]
fn timer_configure(app: AppHandle, timer: State<Timer>, config: Config) -> Snapshot {
    let snap = timer.configure(config);
    publish(&app, &snap);
    snap
}

/// 界面换了语言或改了时长后，把托盘和通知上的文字发过来。
#[tauri::command]
fn set_tray_texts(app: AppHandle, timer: State<Timer>, texts: Texts) {
    if let Some(tray_state) = app.try_state::<TrayState>() {
        let _ = tray_state.skip.set_text(texts.skip.as_str());
        let _ = tray_state.open.set_text(texts.open.as_str());
        let _ = tray_state.quit.set_text(texts.quit.as_str());
        let _ = tray_state.sleep.set_text(texts.sleep.as_str());
        // 清掉记录，下面 publish 时把"开始 / 暂停"也按新文字重写一遍
        *tray_state.shown.lock().unwrap_or_else(|e| e.into_inner()) = (None, None);
    }
    *app.state::<Mutex<Texts>>()
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = texts;
    refresh_widget_menu(&app);
    publish(&app, &timer.snapshot());
}

/// 有哪些环境音可以选
#[tauri::command]
fn ambient_list() -> Vec<String> {
    sound::ambient_ids()
}

/// 界面改了环境音的设置
#[tauri::command]
fn ambient_configure(app: AppHandle, timer: State<Timer>, config: AmbientConfig) {
    if let Some(state) = app.try_state::<AmbientState>() {
        *state.config.lock().unwrap_or_else(|e| e.into_inner()) = config;
    }
    apply_ambient(&app, &timer.snapshot());
}

/// 试听提示音
#[tauri::command]
fn play_sound(sound: State<Sound>, id: String, volume: f32) {
    sound.play(&id, volume);
}

/// 显示 / 隐藏主窗口（全局快捷键用）
#[tauri::command]
fn toggle_main(app: AppHandle) {
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    if visible && !minimized {
        let _ = window.hide();
    } else {
        show_main(&app);
    }
}

/// 打开主窗口（小组件上的按钮用）
#[tauri::command]
fn open_main(app: AppHandle) {
    show_main(&app);
}

/// 进入 / 退出全屏，返回现在是不是全屏
#[tauri::command]
fn toggle_fullscreen(app: AppHandle) -> bool {
    let Some(window) = app.get_webview_window(MAIN) else {
        return false;
    };
    let next = !window.is_fullscreen().unwrap_or(false);
    let _ = window.set_fullscreen(next);
    next
}

/// 主窗口总在最前
#[tauri::command]
fn set_main_on_top(app: AppHandle, on: bool) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.set_always_on_top(on);
    }
}

/// ingfy 的灵动岛现在开没开（界面启动时问一次，之后听 ingfy-island 事件）
#[tauri::command]
fn ingfy_island(app: AppHandle) -> bool {
    app.state::<link::Link>().island()
}

/// 收到托盘里去
#[tauri::command]
fn hide_main(app: AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.hide();
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    exit_app(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let autostart = std::env::args().any(|arg| arg == "--autostart");

    tauri::Builder::default()
        // 只开一个：再开一次时把已有的窗口叫出来。这个插件要最先注册
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // 自动更新：公钥和地址在 update.rs 里，用到时才设，这里只装上插件
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(lecture::Lecture::default())
        .manage(Timer::new())
        .manage(Mutex::new(Texts::default()))
        .manage(Sound::spawn())
        .manage(WidgetFlags(Mutex::new((false, false))))
        .manage(widget::Placement::default())
        .manage(island::Island::default())
        .manage(reminders::Reminders::default())
        .manage(update::Pending::default())
        .manage(link::Link::default())
        .manage(popup::Popups::default())
        .manage(translate::TranslateState::default())
        .manage(AmbientState {
            config: Mutex::new(AmbientConfig::default()),
            sent: Mutex::new(None),
        })
        .manage(Launch {
            autostart,
            handled: AtomicBool::new(false),
        })
        .setup(|app| {
            // 本机的数据文件夹。极少数情况下拿不到，就先放临时文件夹
            let local = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("ingwork"));
            // 日志：出错时记到本机的 logs/ingwork.log
            logger::init(&local, &app.package_info().version.to_string());
            // 第一次打开：把 ingclock 的任务和专注记录接过来
            legacy::import_ingclock(&local);
            // 任务、专注记录、课表放在哪：默认本机，设置里可以换到网盘的同步文件夹
            let data = location::DataDir::resolve(local.clone());
            let data_dir = data.current();
            app.manage(data);
            app.manage(stats::Stats::load(data_dir.clone()));
            app.manage(planner::Planner::load(data_dir.clone(), local.clone()));
            app.manage(tasks::Tasks::load(data_dir, local));

            build_tray(app)?;
            // 上次留下的灵动岛命令不执行；先看一眼灵动岛开没开
            let link = app.state::<link::Link>();
            link.skip_old_command();
            let _ = link.poll_island();
            let handle = app.handle().clone();
            let timer = app.state::<Timer>().inner().clone();
            publish(&handle, &timer.snapshot());
            spawn_data_watcher(handle.clone());
            spawn_ticker(handle, timer);

            // 兜底：界面 5 秒还没准备好，也把窗口显示出来，免得什么都看不到
            let fallback = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(5));
                let launch = fallback.state::<Launch>();
                if !launch.autostart && !launch.handled.swap(true, Ordering::SeqCst) {
                    show_main(&fallback);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // 翻译和杂念箱：点到别处就收起
            popup::on_window_event(window, event);
            // 关主窗口不直接退出：交给界面，按设置决定留在托盘还是退出
            if window.label() == MAIN {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.emit("close-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            timer_get,
            timer_toggle,
            timer_skip,
            timer_reset,
            timer_set_phase,
            timer_configure,
            timer_set_length,
            notify,
            set_tray_texts,
            play_sound,
            ambient_list,
            ambient_configure,
            toggle_main,
            open_main,
            ingfy_island,
            hide_main,
            toggle_fullscreen,
            set_main_on_top,
            quit_app,
            set_dock_hidden,
            widget::widget_apply,
            widget::widget_ready,
            widget::widget_fit,
            widget::widget_moved,
            reminders::reminders_set,
            island::island_apply,
            island::island_ready,
            island::island_wings,
            haptics::haptic,
            lecture::lecture_get,
            lecture::lecture_start,
            lecture::lecture_pause,
            lecture::lecture_resume,
            lecture::lecture_stop,
            lecture::lecture_close,
            lecture::lecture_summarize,
            lecture::lecture_set_key,
            lecture::lecture_set_asr,
            lecture::lecture_delete_audio,
            lecture::lecture_inputs,
            lecture::lecture_check_groq_key,
            lecture::lecture_open,
            lecture::lecture_remove,
            lecture::lecture_list,
            lecture::lecture_export,
            lecture::lecture_check_key,
            lecture::lecture_open_platform,
            lecture::lecture_redo,
            lecture::lecture_clip,
            lecture::import::lecture_import,
            lecture::course::lecture_material,
            lecture::course::lecture_add_slides,
            lecture::course::lecture_remove_slides,
            haptics::haptics_enable,
            island::island_geometry,
            tasks::tasks_get,
            tasks::task_add,
            tasks::task_edit,
            tasks::task_set_finished,
            tasks::task_set_current,
            tasks::task_remove,
            tasks::tasks_reorder,
            tasks::tasks_clear_finished,
            stats::stats_get,
            stats::stats_clear,
            planner::planner_get,
            planner::course_add,
            planner::course_edit,
            planner::courses_import,
            planner::courses_clear,
            planner::deadline_add,
            planner::deadline_set_done,
            planner::note_add,
            planner::note_to_task,
            planner::word_add,
            planner::word_review,
            planner::planner_remove,
            planner::blocks_add,
            popup::popup_toggle,
            popup::popup_show,
            popup::popup_hide,
            popup::popup_ready,
            popup::popup_fit,
            popup::popup_pin,
            popup::popup_configure,
            popup::clipboard_write,
            translate::translate,
            translate::translate_configure,
            legacy::legacy_translate,
            location::data_dir_get,
            location::data_dir_pick,
            location::data_dir_inspect,
            location::data_dir_set,
            location::data_dir_open,
            backup::backup_export,
            backup::backup_import,
            logger::log_write,
            logger::log_open,
            update::check_update,
            update::install_update,
        ])
        .build(tauri::generate_context!())
        .expect("ingwork 启动失败")
        .run(|app, event| match event {
            // Mac：点 Dock 上的图标时把主窗口叫出来
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main(app),
            // 不是自己调的退出（比如 Mac 上按 ⌘Q）：先把没走完的专注记下来、告诉 ingfy，再退出
            tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } => {
                api.prevent_exit();
                exit_app(app);
            }
            _ => {}
        });
}
