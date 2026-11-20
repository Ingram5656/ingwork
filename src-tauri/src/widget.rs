//! 桌面小组件：一个透明、无边框、不进任务栏的小窗口。
//!
//! 窗口的样子写在 tauri.conf.json 里（"create": false），第一次用到时才创建，省内存。
//! 开不开、多大、放哪、锁不锁都由界面的设置决定，界面每次改了就调 `widget_apply`。

use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow,
    WebviewWindowBuilder,
};

pub const WIDGET: &str = "widget";

/// 小组件现在是不是放在默认位置（主屏幕右下角）。
/// 是的话，界面量好真实大小后要按新大小重新贴到右下角。
#[derive(Default)]
pub struct Placement(AtomicBool);

/// 界面发过来的小组件状态。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetSpec {
    pub open: bool,
    /// 窗口大小的估计值（逻辑像素）。真正的大小由小组件量好内容后用 widget_fit 定
    pub width: f64,
    pub height: f64,
    /// 上次的位置（物理像素）。没有就放到默认位置
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// 真：置顶悬浮；假：贴在桌面（在所有窗口下面）
    pub on_top: bool,
    /// 锁定：鼠标穿透
    pub locked: bool,
}

fn build(app: &AppHandle) -> Result<WebviewWindow, String> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == WIDGET)
        .cloned()
        .ok_or_else(|| "小组件窗口的配置找不到了".to_string())?;
    let window = WebviewWindowBuilder::from_config(app, &config)
        .and_then(|builder| builder.build())
        .map_err(|_| "小组件没能打开，请再试一次".to_string())?;
    // Mac：切换桌面空间（Spaces）时小组件跟着过去，不然一切换就不见了
    #[cfg(target_os = "macos")]
    let _ = window.set_visible_on_all_workspaces(true);
    Ok(window)
}

/// 主屏幕右下角：窗口（物理像素大小）的左上角该放在哪
fn default_position(window: &WebviewWindow, width: i32, height: i32) -> Option<(i32, i32)> {
    let monitor = window.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let origin = monitor.position();
    let size = monitor.size();
    let margin = (28.0 * scale) as i32;
    // 下面多留一点，让开任务栏（Mac 是程序坞，更高一些）
    let taskbar = if cfg!(target_os = "macos") {
        90.0
    } else {
        56.0
    };
    let taskbar = (taskbar * scale) as i32;
    Some((
        origin.x + size.width as i32 - width - margin,
        origin.y + size.height as i32 - height - margin - taskbar,
    ))
}

/// 把小组件放到上次的位置。上次的位置已经不在任何屏幕上（比如拔了显示器），
/// 或者还没有位置时，放到主屏幕右下角。返回是不是放在了默认位置。
fn place(window: &WebviewWindow, spec: &WidgetSpec) -> bool {
    let monitors = window.available_monitors().unwrap_or_default();
    let saved = match (spec.x, spec.y) {
        (Some(x), Some(y)) => Some((x, y)),
        _ => None,
    };
    let on_screen = saved.filter(|(x, y)| {
        monitors.iter().any(|monitor| {
            let origin = monitor.position();
            let size = monitor.size();
            let right = origin.x + size.width as i32;
            let bottom = origin.y + size.height as i32;
            // 至少露出一小块，拖得回来
            *x > origin.x - 120 && *x < right - 60 && *y > origin.y - 20 && *y < bottom - 40
        })
    });
    let by_default = on_screen.is_none();
    let target = on_screen.or_else(|| {
        let size = window.outer_size().ok()?;
        default_position(window, size.width as i32, size.height as i32)
    });
    if let Some((x, y)) = target {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    by_default
}

/// 按设置打开、关闭或调整小组件。
/// 在 Windows 上，同步命令里创建窗口会卡死，所以这个命令必须是 async 的。
#[tauri::command]
pub async fn widget_apply(
    app: AppHandle,
    placement: State<'_, Placement>,
    spec: WidgetSpec,
) -> Result<(), String> {
    let existing = app.get_webview_window(WIDGET);

    if !spec.open {
        if let Some(window) = existing {
            let _ = window.close();
        }
        crate::widget_changed(&app, false, false);
        return Ok(());
    }

    let (window, created) = match existing {
        Some(window) => (window, false),
        None => (build(&app)?, true),
    };

    // 新建时先按估计的大小开，小组件画出来后会量好真实大小再调（widget_fit）。
    // 已经开着的不在这里改大小，免得和 widget_fit 打架
    if created {
        let _ = window.set_size(LogicalSize::new(spec.width, spec.height));
    }
    if created || spec.x.is_none() || spec.y.is_none() {
        let by_default = place(&window, &spec);
        placement.0.store(by_default, Ordering::SeqCst);
    }
    // 置顶和贴在桌面只能二选一，先关掉另一个再开
    if spec.on_top {
        let _ = window.set_always_on_bottom(false);
        let _ = window.set_always_on_top(true);
    } else {
        let _ = window.set_always_on_top(false);
        let _ = window.set_always_on_bottom(true);
    }
    let _ = window.set_ignore_cursor_events(spec.locked);
    // 新建的窗口等界面画好第一帧（widget_ready）再显示，免得闪一下
    if !created {
        let _ = window.show();
    }

    crate::widget_changed(&app, true, spec.locked);
    Ok(())
}

/// 小组件量好了内容需要多大（物理像素，已经算上四周留给投影的边），按这个大小改窗口。
/// 字体、系统的"文本大小"设置不同，内容的宽度就不同，所以不能写死窗口大小。
#[tauri::command]
pub fn widget_fit(app: AppHandle, placement: State<Placement>, width: u32, height: u32) {
    let Some(window) = app.get_webview_window(WIDGET) else {
        return;
    };
    let width = width.clamp(120, 1200);
    let height = height.clamp(60, 600);
    if let Ok(size) = window.inner_size() {
        if size.width == width && size.height == height {
            return;
        }
    }
    let _ = window.set_size(PhysicalSize::new(width, height));
    // 放在默认位置的，按新大小重新贴到右下角
    if placement.0.load(Ordering::SeqCst) {
        if let Some((x, y)) = default_position(&window, width as i32, height as i32) {
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
    }
}

/// 用户拖动过小组件，它就不在默认位置了。
#[tauri::command]
pub fn widget_moved(placement: State<Placement>) {
    placement.0.store(false, Ordering::SeqCst);
}

/// 小组件的界面画好第一帧后调用。
#[tauri::command]
pub fn widget_ready(app: AppHandle) {
    if let Some(window) = app.get_webview_window(WIDGET) {
        let _ = window.show();
    }
}
