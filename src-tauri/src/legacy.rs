//! 从 ingclock 和 ingtranslate 接过来的东西。
//!
//! - ingclock：第一次打开 ingwork 时，把 ingclock 的任务表和专注记录复制过来（原来的不动）。
//!   之后两边各管各的，不再同步。
//! - ingtranslate：翻译的设置（引擎、大模型接口、目标语言、呼出快捷键）交给界面，界面只接一次。

use std::path::{Path, PathBuf};

/// 记号文件：有它就说明已经接过了（或者不需要接）
const MARK: &str = "imported-ingclock";

/// ingclock 的数据在哪：选过别的文件夹（OneDrive 之类）就用那个，否则是它自己的本机文件夹
fn ingclock_data(ingclock_local: &Path) -> PathBuf {
    let chosen = std::fs::read_to_string(ingclock_local.join("location.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| v.get("dataDir").and_then(|d| d.as_str()).map(PathBuf::from));
    match chosen {
        Some(dir) if dir.is_dir() => dir,
        _ => ingclock_local.to_path_buf(),
    }
}

fn is_history(name: &str) -> bool {
    name == "history.jsonl" || (name.starts_with("history-") && name.ends_with(".jsonl"))
}

/// 这个文件夹里已经有任务或专注记录了
fn has_data(dir: &Path) -> bool {
    if dir.join("tasks.json").exists() {
        return true;
    }
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_str().is_some_and(is_history))
    })
}

/// 第一次启动时调用（在决定数据文件夹之前）。`local` 是 ingwork 的本机文件夹。
/// ingwork 已经有自己的数据、或者这台电脑上没装过 ingclock，就什么都不做。返回接过来了几个文件
pub fn import_ingclock(local: &Path) -> usize {
    let mark = local.join(MARK);
    if mark.exists() {
        return 0;
    }
    let _ = std::fs::create_dir_all(local);
    // 在 ingwork 里换过数据文件夹，说明已经用了一阵子了，不接
    let moved = local.join("location.json").exists();
    let mut copied = 0;
    if !moved && !has_data(local) {
        if let Some(parent) = local.parent() {
            let from = ingclock_data(&parent.join("com.ingram.ingclock"));
            if let Ok(entries) = std::fs::read_dir(&from) {
                for entry in entries.filter_map(|e| e.ok()) {
                    let name = entry.file_name();
                    let Some(text) = name.to_str() else {
                        continue;
                    };
                    if (text == "tasks.json" || is_history(text))
                        && std::fs::copy(entry.path(), local.join(text)).is_ok()
                    {
                        copied += 1;
                    }
                }
            }
        }
    }
    let _ = std::fs::write(mark, b"");
    copied
}

/// ingtranslate 存的设置（`%APPDATA%\com.nige.translate\settings.json`）。没装过就是空
#[tauri::command]
pub fn legacy_translate(app: tauri::AppHandle) -> Option<serde_json::Value> {
    use tauri::Manager;
    let local = app.path().app_data_dir().ok()?;
    let path = local
        .parent()?
        .join("com.nige.translate")
        .join("settings.json");
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}
