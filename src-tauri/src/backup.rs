//! 备份：把待办、课表（课、截止日期、杂念、生词、排进空档的段）、专注记录存成一个文件，
//! 换电脑或者数据出了问题时再导回来。
//!
//! 导回来是"并进来"，不是覆盖：两边都有的条目按修改时间取新的，备份里没有的不会被删掉。

use crate::{planner, stats, tasks};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

/// 备份文件认这个名字，别的 JSON 文件拿来导会被拒
const KIND: &str = "ingwork-backup";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Backup {
    kind: String,
    /// 导出它的版本号，以后格式变了用得上
    version: String,
    /// 导出的时刻（毫秒时间戳）
    exported: u64,
    #[serde(default)]
    tasks: tasks::Store,
    #[serde(default)]
    planner: planner::Store,
    #[serde(default)]
    history: Vec<stats::Record>,
}

/// 导回来以后告诉界面导了多少
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    tasks: usize,
    courses: usize,
    history: usize,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 今天的日期，拼进默认文件名
fn today() -> String {
    let days = now_ms() / 86_400_000;
    // 公历换算（1970-01-01 起的天数 → 年月日）
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// 导出：弹出存文件的窗口，写一个 .json。取消了返回 false
#[tauri::command]
pub async fn backup_export(app: AppHandle) -> Result<bool, String> {
    let backup = Backup {
        kind: KIND.into(),
        version: app.package_info().version.to_string(),
        exported: now_ms(),
        tasks: app.state::<tasks::Tasks>().snapshot(),
        planner: app.state::<planner::Planner>().snapshot(),
        history: stats::export_records(&app),
    };
    let text = serde_json::to_string_pretty(&backup)
        .map_err(|_| "备份没写出来，请再试一次".to_string())?;
    let Some(picked) = app
        .dialog()
        .file()
        .set_file_name(format!("ingwork-{}.json", today()))
        .add_filter("ingwork", &["json"])
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = picked
        .into_path()
        .map_err(|_| "这个位置存不了，换一个文件夹试试".to_string())?;
    std::fs::write(&path, text)
        .map_err(|_| "备份没写出来，请检查那个文件夹能不能写".to_string())?;
    crate::logger::info(&format!(
        "exported backup: {} tasks",
        backup.tasks.tasks.len()
    ));
    Ok(true)
}

/// 导回来：弹出选文件的窗口，把备份并进现在的数据。取消了返回空
#[tauri::command]
pub async fn backup_import(app: AppHandle) -> Result<Option<Restored>, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("ingwork", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| "这个文件打不开".to_string())?;
    let text = std::fs::read_to_string(&path).map_err(|_| "这个文件打不开".to_string())?;
    let backup: Backup =
        serde_json::from_str(&text).map_err(|_| "这不是 ingwork 的备份文件".to_string())?;
    if backup.kind != KIND {
        return Err("这不是 ingwork 的备份文件".into());
    }

    let task_store = app.state::<tasks::Tasks>().absorb(&backup.tasks)?;
    tasks::announce(&app, &task_store);
    let planner_store = app.state::<planner::Planner>().absorb(&backup.planner)?;
    planner::announce(&app, &planner_store);
    let history = stats::import_records(&app, &backup.history)?;
    crate::logger::info(&format!("restored backup from {}", backup.version));
    Ok(Some(Restored {
        tasks: backup.tasks.tasks.len(),
        courses: backup.planner.courses.len(),
        history,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn today_is_a_date() {
        let d = today();
        assert_eq!(d.len(), 10);
        assert!(d.starts_with("20"));
    }
}
