//! 检查更新。两种方式：
//!
//! - **自动更新**（填好下面的 PUBKEY 以后）：用 Tauri 的更新插件，在后台下好新版、核对签名，
//!   装好后自动重启，不用自己下安装包。打包时 GitHub 会顺便传一个 latest.json 和签过名的更新包。
//! - **以前的方式**（PUBKEY 为空时）：读 GitHub 仓库最新的 Release，下载这个系统的安装包
//!   （Windows 是 .exe，Mac 是 .dmg）交给用户装。
//!
//! 怎么开启自动更新见 README 的"自动更新"一节：生成一对签名密钥，私钥放进 GitHub 的仓库密钥，
//! 公钥填在 PUBKEY 和 tauri.conf.json 里；GitHub 打包时用 tauri.updater.conf.json 打开 createUpdaterArtifacts。

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 仓库建好以后如果名字不一样，改这几行。
const LATEST_URL: &str = "https://api.github.com/repos/Ingram5656/ingwork/releases/latest";
const DOWNLOAD_PREFIX: &str = "https://github.com/Ingram5656/ingwork/releases/download/";
/// 自动更新读的清单：打包时 GitHub 传到最新 Release 里的 latest.json
const MANIFEST_URL: &str =
    "https://github.com/Ingram5656/ingwork/releases/latest/download/latest.json";

/// 自动更新用的签名公钥（`pnpm tauri signer generate` 生成的 .pub 文件的内容）。
/// 为空时用以前的方式更新。公钥本来就是公开的，可以写在代码里；私钥绝不能
const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDA0REZGNzgxNEU3OEQ3OUIKUldTYjEzaE9nZmZmQkRZSEM1WWxjeGxwVTFjSEYxUlhIalVZMWhRYXVWVG1mZWJVQUQ0YVloUVUK";

/// 查到的自动更新，等用户点"立即更新"时用
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

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
    /// 以前的方式下载安装包的地址；自动更新时为空
    url: String,
    notes: String,
    /// 自动更新：装好后自己重启，不用手动装
    seamless: bool,
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

/// 自动更新：查 latest.json，有新版就记下来
async fn check_seamless(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    let offline = || "连不上更新服务器，请检查网络".to_string();
    let url = tauri::Url::parse(MANIFEST_URL).map_err(|_| offline())?;
    let updater = app
        .updater_builder()
        .pubkey(PUBKEY)
        .endpoints(vec![url])
        .and_then(|builder| builder.build())
        .map_err(|_| offline())?;
    let found = updater.check().await.map_err(|error| {
        crate::logger::error(&format!("检查更新：{error}"));
        offline()
    })?;
    let info = found.as_ref().map(|update| UpdateInfo {
        version: update.version.clone(),
        url: String::new(),
        notes: update.body.clone().unwrap_or_default(),
        seamless: true,
    });
    if let Some(pending) = app.try_state::<Pending>() {
        *pending.0.lock().unwrap_or_else(|e| e.into_inner()) = found;
    }
    Ok(info)
}

/// 有新版本返回它的信息，没有返回空。连不上和"没有新版本"分开返回。
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    if !PUBKEY.is_empty() {
        // 最新的 Release 没带 latest.json（比如是没签名时打的包）就退回以前的方式
        if let Ok(found) = check_seamless(&app).await {
            return Ok(found);
        }
    }
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
        seamless: false,
    }))
}

/// 这个系统的安装包后缀
const INSTALLER: &str = if cfg!(target_os = "macos") {
    ".dmg"
} else {
    ".exe"
};

/// 自动更新：下载、核对签名、装好，然后重启。
/// Windows 上装的时候安装程序会自己把旧的 ingwork 关掉，所以装之前先把没走完的专注记下来
async fn install_seamless(app: &AppHandle, pending: &Pending) -> Result<(), String> {
    // 不从 Pending 里拿走：下载、安装没成的话，再点一次"立即更新"就能重试
    let update = pending
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "先检查一次更新".to_string())?;
    // 下了百分之几，告诉界面（每变 1% 说一次）
    let mut got: u64 = 0;
    let mut shown: u64 = u64::MAX;
    let progress = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                got += chunk as u64;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let percent = (got * 100 / total).min(100);
                    if percent != shown {
                        shown = percent;
                        let _ = progress.emit("update-progress", percent);
                    }
                }
            },
            || {},
        )
        .await
        .map_err(|error| {
            crate::logger::error(&format!("下载更新：{error}"));
            "新版本没下载下来，请检查网络后再试".to_string()
        })?;
    crate::before_exit(app);
    update.install(bytes).map_err(|error| {
        crate::logger::error(&format!("安装更新：{error}"));
        "新版本没装上，请到发布页手动下载".to_string()
    })?;
    app.restart();
}

/// 下载安装程序并运行，然后退出自己，让安装程序接手。
/// Mac 上是下载 .dmg 并打开，把新版拖进"应用程序"文件夹盖掉旧的。
/// 自动更新开着时，下载、装好、重启一气呵成
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    pending: State<'_, Pending>,
    url: String,
) -> Result<(), String> {
    // 按这次查到的是哪一种来装，不是按"自动更新开没开"：自动更新没查成（比如 latest.json 读不到）
    // 时 check_update 会退回以前的方式、带一个安装包地址，这时也得走以前的方式。
    // 以前这里只看 PUBKEY，结果点"立即更新"马上报"先检查一次更新"，怎么点都装不了
    if url.is_empty() {
        return install_seamless(&app, &pending).await;
    }
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
    // 和平常退出一样：先把没走完的专注记下来、告诉 ingfy，再退出
    crate::exit_app(&app);
    Ok(())
}
