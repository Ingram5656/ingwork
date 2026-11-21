//! 日志：出了错记到本机的一个文本文件里，出问题时把它发过来就能查。
//!
//! 记在本机数据目录（不是网盘里的数据文件夹）下的 logs/ingwork.log。超过 1 MB 就把旧的改名成
//! ingwork.old.log，再从头写，最多占 2 MB。只记出错和几件要紧的事（启动、版本、系统、崩溃），
//! 不记任务名、课程名这些内容。界面上的出错通过 log_write 命令也记进来。
//! 设置 → 通用 → 日志 → 打开 能直接打开这个文件夹。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const FILE: &str = "ingwork.log";
const OLD: &str = "ingwork.old.log";
const MAX_BYTES: u64 = 1024 * 1024;
/// 一行最多这么长，免得一条出错把文件塞满
const MAX_LINE: usize = 2000;

static DIR: OnceLock<PathBuf> = OnceLock::new();
static WRITE: Mutex<()> = Mutex::new(());

/// 启动时调一次：定下日志放哪、记下版本和系统、接住崩溃
pub fn init(local: &Path, version: &str) {
    let dir = local.join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let _ = DIR.set(dir);
    info(&format!(
        "启动 ingwork {version}（{} {}）",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic| {
        let place = panic
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let message = panic
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| panic.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        error(&format!("崩溃 {place} {message}"));
        previous(panic);
    }));
}

pub fn dir() -> Option<&'static PathBuf> {
    DIR.get()
}

/// UTC 时间，格式 2026-11-21 21:53:07Z。不依赖时区库，日志里看个先后就够了
fn stamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rest = secs % 86_400;
    // 从 1970-01-01 起的天数换成年月日（Howard Hinnant 的算法）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}Z",
        rest / 3600,
        rest / 60 % 60,
        rest % 60
    )
}

fn write(level: &str, message: &str) {
    let Some(dir) = DIR.get() else {
        return;
    };
    let mut line: String = message.replace(['\r', '\n'], " ");
    if line.len() > MAX_LINE {
        let mut cut = MAX_LINE;
        while !line.is_char_boundary(cut) {
            cut -= 1;
        }
        line.truncate(cut);
        line.push('…');
    }
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let path = dir.join(FILE);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(&path, dir.join(OLD));
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{} {level} {line}", stamp());
    }
}

pub fn info(message: &str) {
    write("INFO", message);
}

pub fn error(message: &str) {
    write("ERROR", message);
}

/// 界面上出的错也记进来（网页里的报错、命令失败）
#[tauri::command]
pub fn log_write(level: String, message: String) {
    if level == "error" {
        error(&format!("[界面] {message}"));
    } else {
        info(&format!("[界面] {message}"));
    }
}

/// 在资源管理器（Mac 上是访达）里打开日志文件夹
#[tauri::command]
pub fn log_open() -> Result<(), String> {
    let dir = DIR
        .get()
        .ok_or_else(|| "日志文件夹还没准备好".to_string())?;
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "explorer"
    };
    std::process::Command::new(opener)
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|_| "没能打开文件夹".to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn stamp_looks_like_a_date() {
        let s = super::stamp();
        assert_eq!(s.len(), 20);
        assert!(s.starts_with("20"));
        assert!(s.ends_with('Z'));
    }
}
