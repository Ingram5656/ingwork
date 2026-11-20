//! 翻译：从 ingtranslate 搬过来的三个引擎。
//! 默认用 Google 翻译的公开接口，连不上换 MyMemory；填了自己的 OpenAI 兼容接口就用大模型。
//! 请求都由这里发出，不经过页面。
//!
//! 设置（用哪个引擎、接口地址和 Key）存在界面的设置里，主窗口启动时和每次改动后发过来（translate_configure）。

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

use crate::logic::{guess_source, lang_name, smart_target};

/// 大模型引擎用的 OpenAI 兼容接口
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Llm {
    base_url: String,
    api_key: String,
    model: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TranslateConfig {
    /// "google"（免费接口）或 "llm"（大模型）
    engine: String,
    llm: Llm,
}

#[derive(Default)]
pub struct TranslateState(Mutex<TranslateConfig>);

#[derive(Serialize)]
pub struct DictEntry {
    /// 词性
    pos: String,
    terms: Vec<String>,
}

#[derive(Serialize)]
pub struct Translation {
    text: String,
    /// 原文语言
    src: String,
    /// 译成了哪种语言
    tgt: String,
    engine: String,
    /// 查单词时的词性和常见释义，其他时候是空的
    dict: Vec<DictEntry>,
}

async fn via_google(client: &reqwest::Client, text: &str, tl: &str) -> Result<Translation, String> {
    let resp = client
        .get("https://translate.googleapis.com/translate_a/single")
        .query(&[
            ("client", "gtx"),
            ("sl", "auto"),
            ("tl", tl),
            ("dt", "t"),
            ("dt", "bd"),
            ("q", text),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    // 结果是嵌套数组：[0] 是一段段译文，[1] 是词典（可能没有），[2] 是识别出的原文语言
    let mut out = String::new();
    if let Some(segments) = v.get(0).and_then(|a| a.as_array()) {
        for seg in segments {
            if let Some(piece) = seg.get(0).and_then(|t| t.as_str()) {
                out.push_str(piece);
            }
        }
    }
    if out.is_empty() {
        return Err("没有拿到译文".to_string());
    }
    let mut dict = Vec::new();
    if let Some(entries) = v.get(1).and_then(|d| d.as_array()) {
        for entry in entries.iter().take(3) {
            let Some(pos) = entry.get(0).and_then(|p| p.as_str()) else {
                continue;
            };
            let Some(terms) = entry.get(1).and_then(|t| t.as_array()) else {
                continue;
            };
            let terms: Vec<String> = terms
                .iter()
                .take(6)
                .filter_map(|t| t.as_str().map(str::to_string))
                .collect();
            dict.push(DictEntry {
                pos: pos.to_string(),
                terms,
            });
        }
    }
    let src = v
        .get(2)
        .and_then(|s| s.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| guess_source(text).to_string());
    Ok(Translation {
        text: out,
        src,
        tgt: tl.to_string(),
        engine: "google".to_string(),
        dict,
    })
}

async fn via_mymemory(
    client: &reqwest::Client,
    text: &str,
    tl: &str,
) -> Result<Translation, String> {
    let sl = guess_source(text);
    let pair = format!("{sl}|{tl}");
    let resp = client
        .get("https://api.mymemory.translated.net/get")
        .query(&[("q", text), ("langpair", pair.as_str())])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let out = v
        .pointer("/responseData/translatedText")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    if out.is_empty() {
        return Err("没有拿到译文".to_string());
    }
    Ok(Translation {
        text: out,
        src: sl.to_string(),
        tgt: tl.to_string(),
        engine: "mymemory".to_string(),
        dict: Vec::new(),
    })
}

async fn via_llm(
    client: &reqwest::Client,
    llm: &Llm,
    text: &str,
    tl: &str,
) -> Result<Translation, String> {
    let base = if llm.base_url.trim().is_empty() {
        "https://api.openai.com/v1"
    } else {
        llm.base_url.trim()
    };
    let model = if llm.model.trim().is_empty() {
        "gpt-4o-mini"
    } else {
        llm.model.trim()
    };
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let system = format!(
        "You are a translation engine. Translate the user's text into {}. Keep the meaning, tone and line breaks. Output only the translation, with no notes or quotes.",
        lang_name(tl)
    );
    let body = serde_json::json!({
        "model": model,
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": text }
        ]
    });
    let resp = client
        .post(url)
        .bearer_auth(llm.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let out = v
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if out.is_empty() {
        return Err("模型没有返回内容".to_string());
    }
    Ok(Translation {
        text: out,
        src: guess_source(text).to_string(),
        tgt: tl.to_string(),
        engine: "llm".to_string(),
        dict: Vec::new(),
    })
}

/// 翻译一段文字。`target` 是 "auto" 时：中文译成英语，其他语言译成中文。
/// 连不上和没结果分开说，界面才能分别提示
#[tauri::command]
pub async fn translate(
    state: State<'_, TranslateState>,
    text: String,
    target: String,
) -> Result<Translation, String> {
    let config = state.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("没有要翻译的文字".to_string());
    }
    let tl = if target == "auto" {
        smart_target(&text).to_string()
    } else {
        target
    };
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) ingwork")
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    if config.engine == "llm" && !config.llm.api_key.trim().is_empty() {
        return via_llm(&client, &config.llm, &text, &tl)
            .await
            .map_err(|_| "大模型接口没有回应，检查接口地址和 Key".to_string());
    }
    match via_google(&client, &text, &tl).await {
        Ok(t) => Ok(t),
        Err(_) => via_mymemory(&client, &text, &tl)
            .await
            .map_err(|_| "连不上翻译服务，检查网络后按 Enter 重试".to_string()),
    }
}

#[tauri::command]
pub fn translate_configure(state: State<TranslateState>, config: TranslateConfig) {
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = config;
}
