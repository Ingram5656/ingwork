//! 检查更新：读 GitHub 仓库最新的 Release。
//! 版本号更高、附件里有这个系统的安装包（Windows 是 .exe，Mac 是 .dmg）时，才算有新版本。

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::AppHandle;

/// 仓库建好以后如果名字不一样，改这两行。
const LATEST_URL: &str = "https://api.github.com/repos/Ingram5656/ingwork/releases/latest";
const DOWNLOAD_PREFIX: &str = "https://github.com/Ingram5656/ingwork/releases/download/";

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    body: Option<String>,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    url: String,
    notes: String,
}

fn client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("ingwork/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|_| "连不上更新服务器，请检查网络".to_string())
}

fn parse(version: &str) -> Vec<u64> {
    let mut parts: Vec<u64> = version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .map(|p| {
            p.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse()
                .unwrap_or(0)
        })
        .collect();
    parts.resize(3, 0);
    parts
}

/// 有新版本返回它的信息，没有返回空。连不上和"没有新版本"分开返回。
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let current = app.package_info().version.to_string();
    let resp = client(12)?
        .get(LATEST_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "连不上更新服务器，请检查网络".to_string())?;

    // 还没有发布过任何版本
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err("更新服务器暂时不可用，请稍后再试".to_string());
    }

    let release: Release = resp
        .json()
        .await
        .map_err(|_| "更新信息读不出来，请稍后再试".to_string())?;

    if parse(&release.tag_name) <= parse(&current) {
        return Ok(None);
    }
    let Some(installer) = release
        .assets
        .iter()
        .find(|a| a.name.to_lowercase().ends_with(INSTALLER))
    else {
        return Ok(None);
    };

    Ok(Some(UpdateInfo {
        version: release.tag_name.trim_start_matches('v').to_string(),
        url: installer.browser_download_url.clone(),
        notes: release.body.unwrap_or_default(),
    }))
}

/// 这个系统的安装包后缀
const INSTALLER: &str = if cfg!(target_os = "macos") {
    ".dmg"
} else {
    ".exe"
};

/// 下载安装程序并运行，然后退出自己，让安装程序接手。
/// Mac 上是下载 .dmg 并打开，把新版拖进"应用程序"文件夹盖掉旧的。
#[tauri::command]
pub async fn install_update(app: AppHandle, url: String) -> Result<(), String> {
    // 只下载自己仓库 Release 里的文件
    if !url.starts_with(DOWNLOAD_PREFIX) {
        return Err("更新地址不对，已取消".to_string());
    }
    let failed = || "安装包没下载下来，请检查网络后再试".to_string();
    let bytes = client(600)?
        .get(&url)
        .send()
        .await
        .map_err(|_| failed())?
        .error_for_status()
        .map_err(|_| failed())?
        .bytes()
        .await
        .map_err(|_| failed())?;

    let path = std::env::temp_dir().join(format!("ingwork-setup{INSTALLER}"));
    std::fs::write(&path, &bytes).map_err(|_| "安装包没能保存下来，请检查磁盘空间".to_string())?;
    let mut command = if cfg!(target_os = "macos") {
        let mut open = std::process::Command::new("open");
        open.arg(&path);
        open
    } else {
        std::process::Command::new(&path)
    };
    command
        .spawn()
        .map_err(|_| "安装程序没能启动，请到发布页手动下载".to_string())?;
    app.exit(0);
    Ok(())
}
