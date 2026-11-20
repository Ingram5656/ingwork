//! 数据文件夹：任务表、专注记录、课表和截止日期（planner.json）放在哪。
//!
//! 默认是本机的 `%APPDATA%\com.ingram.ingwork\`（Mac 上是 `~/Library/Application Support/com.ingram.ingwork/`）。设置里可以换成别的文件夹，比如 OneDrive 里的一个文件夹，
//! 几台电脑都指向它，网盘负责在电脑之间搬文件，任务和记录就同步了。怎么合并见 tasks.rs 和 stats.rs。
//!
//! 选了哪个文件夹记在本机文件夹的 `location.json` 里（不放进网盘，每台电脑的路径可能不一样）。
//! AI 的接口（mcp/ingwork-mcp.mjs）也读这个文件，找到同一份任务表。改格式要两边一起改。
//!
//! 主题、小组件位置这些设置不跟着走：每台电脑屏幕不一样，各管各的。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::{planner, stats, tasks};

const CONFIG: &str = "location.json";

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    /// 选的数据文件夹。没有就是用本机的
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data_dir: Option<PathBuf>,
}

fn read_config(local: &Path) -> Config {
    std::fs::read_to_string(local.join(CONFIG))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_config(local: &Path, dir: Option<&Path>) -> Result<(), String> {
    let config = Config {
        data_dir: dir.map(Path::to_path_buf),
    };
    let text = serde_json::to_string_pretty(&config).map_err(|_| SAVE_FAILED.to_string())?;
    std::fs::create_dir_all(local).map_err(|_| SAVE_FAILED.to_string())?;
    tasks::write_atomic(&local.join(CONFIG), &text).map_err(|_| SAVE_FAILED.to_string())
}

const SAVE_FAILED: &str = "没能记下新的数据文件夹，请再试一次";

/// 这个文件夹能不能用：在、是文件夹、能写
fn usable(dir: &Path) -> Result<(), String> {
    if !dir.is_absolute() {
        return Err("请选一个完整的文件夹路径".to_string());
    }
    std::fs::create_dir_all(dir).map_err(|_| "这个文件夹打不开".to_string())?;
    if !dir.is_dir() {
        return Err("这不是一个文件夹".to_string());
    }
    let probe = dir.join(".ingwork-probe");
    std::fs::write(&probe, b"ok").map_err(|_| "这个文件夹没有写入权限，换一个吧".to_string())?;
    let _ = std::fs::remove_file(probe);
    Ok(())
}

/// 两个路径是不是同一个文件夹（Windows 和 Mac 默认都不分大小写）
fn same_dir(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase(),
    }
}

pub struct DataDir {
    /// 本机的文件夹：放 location.json 和锁，也是默认的数据文件夹
    pub local: PathBuf,
    /// 正在用的数据文件夹
    current: Mutex<PathBuf>,
    /// 选了别的文件夹，但启动时打不开（OneDrive 没登录、移动硬盘没插），只好先用本机的
    unavailable: Mutex<Option<PathBuf>>,
    /// 正在换文件夹，别的请求先等等
    moving: AtomicBool,
}

impl DataDir {
    /// 启动时决定用哪个文件夹
    pub fn resolve(local: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&local);
        let chosen = read_config(&local).data_dir;
        let (current, unavailable) = match chosen {
            Some(dir) if usable(&dir).is_ok() => (dir, None),
            Some(dir) => (local.clone(), Some(dir)),
            None => (local.clone(), None),
        };
        Self {
            local,
            current: Mutex::new(current),
            unavailable: Mutex::new(unavailable),
            moving: AtomicBool::new(false),
        }
    }

    pub fn current(&self) -> PathBuf {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn view(&self) -> DataDirView {
        let current = self.current();
        DataDirView {
            is_default: same_dir(&current, &self.local),
            path: current.to_string_lossy().into_owned(),
            default_path: self.local.to_string_lossy().into_owned(),
            unavailable: self
                .unavailable
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirView {
    pub path: String,
    pub is_default: bool,
    pub default_path: String,
    /// 选了但打不开的文件夹（这时正在用本机的）
    pub unavailable: Option<String>,
}

/// 换文件夹之前看一眼那边
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub path: String,
    /// 就是现在用的这个
    pub same: bool,
    /// 那边的任务数。读不出来（网盘还没下载完）是空
    pub tasks: Option<usize>,
    pub records: usize,
    /// 能不能用；不能用时是原因
    pub problem: Option<String>,
}

#[tauri::command]
pub fn data_dir_get(dir: State<DataDir>) -> DataDirView {
    dir.view()
}

/// 弹出选文件夹的窗口。取消了返回空
#[tauri::command]
pub async fn data_dir_pick(app: AppHandle) -> Option<String> {
    let start = app.state::<DataDir>().current();
    app.dialog()
        .file()
        .set_directory(start)
        .blocking_pick_folder()
        .and_then(|picked| picked.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}

/// 换之前看看那个文件夹：能不能用、里面已经有多少任务和记录
#[tauri::command]
pub fn data_dir_inspect(dir: State<DataDir>, path: String) -> Inspection {
    let target = PathBuf::from(&path);
    let problem = usable(&target).err();
    Inspection {
        same: same_dir(&target, &dir.current()),
        tasks: if problem.is_none() {
            tasks::count_in(&target)
        } else {
            Some(0)
        },
        records: if problem.is_none() {
            stats::count_in(&target)
        } else {
            0
        },
        problem,
        path,
    }
}

/// 换数据文件夹。`path` 为空是换回本机的。
/// `keep` 为真：把现在的任务和记录带过去，和那边已有的合并；为假：直接用那边的（这边的留在原处，不删）。
#[tauri::command]
pub async fn data_dir_set(
    app: AppHandle,
    path: Option<String>,
    keep: bool,
) -> Result<DataDirView, String> {
    let dir = app.state::<DataDir>();
    let target = match path {
        Some(p) => PathBuf::from(p),
        None => dir.local.clone(),
    };
    usable(&target)?;
    if dir.moving.swap(true, Ordering::SeqCst) {
        return Err("正在换文件夹，请稍等".to_string());
    }
    let result = (|| {
        // 先搬记录再搬任务：任务那边失败了，记录多拷了一份也不要紧，重复的会去掉
        app.state::<stats::Stats>().relocate(target.clone(), keep)?;
        let store = app.state::<tasks::Tasks>().relocate(target.clone(), keep)?;
        let plan = app
            .state::<planner::Planner>()
            .relocate(target.clone(), keep)?;
        let custom = (!same_dir(&target, &dir.local)).then_some(target.as_path());
        write_config(&dir.local, custom)?;
        *dir.current.lock().unwrap_or_else(|e| e.into_inner()) = target.clone();
        *dir.unavailable.lock().unwrap_or_else(|e| e.into_inner()) = None;
        Ok::<_, String>((store, plan))
    })();
    dir.moving.store(false, Ordering::SeqCst);
    let (store, plan) = result?;
    tasks::announce(&app, &store);
    planner::announce(&app, &plan);
    stats::announce(&app);
    let view = dir.view();
    let _ = app.emit("data-dir-changed", view.clone());
    Ok(view)
}

/// 在资源管理器（Mac 上是访达）里打开数据文件夹
#[tauri::command]
pub fn data_dir_open(dir: State<DataDir>) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "explorer"
    };
    std::process::Command::new(opener)
        .arg(dir.current())
        .spawn()
        .map(|_| ())
        .map_err(|_| "没能打开文件夹".to_string())
}
