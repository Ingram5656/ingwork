//! 每门课的资料：上传的课件（只存文字）和从课件整理出来的术语、提纲。
//! 存在数据文件夹的 lectures/courses/ 里，几台电脑同步。课件是可选的，什么时候传都行，
//! 听课中传了马上就用上。

use super::glossary::{GTerm, Glossary};
use super::{chat, folder, lock, now_ms, Fail, Lecture, Session, Status, Usage};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

/// 一份课件最多存多少字（够整理术语和提纲了）
const MAX_TEXT: usize = 60_000;
/// 送去整理时最多给多少字
const EXTRACT_TEXT: usize = 40_000;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Slide {
    name: String,
    added_at: u64,
    text: String,
    terms: Vec<GTerm>,
    outline: Vec<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Material {
    course: String,
    slides: Vec<Slide>,
}

/// 界面上看到的
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialView {
    slides: Vec<SlideView>,
    terms: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SlideView {
    name: String,
    added_at: u64,
    terms: usize,
}

fn fnv(text: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// 文件名：课表里的课按编号，自己写的课名按名字
fn course_key(course: &str, course_id: Option<&str>) -> String {
    if let Some(id) = course_id {
        let clean: String = id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .take(64)
            .collect();
        if clean.chars().any(|c| c.is_ascii_alphanumeric()) {
            return format!("c-{clean}");
        }
    }
    format!("n-{:016x}", fnv(&course.trim().to_lowercase()))
}

fn path(app: &AppHandle, course: &str, course_id: Option<&str>) -> PathBuf {
    folder(app)
        .join("courses")
        .join(format!("{}.json", course_key(course, course_id)))
}

fn load(app: &AppHandle, course: &str, course_id: Option<&str>) -> Material {
    std::fs::read_to_string(path(app, course, course_id))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn store(
    app: &AppHandle,
    course: &str,
    course_id: Option<&str>,
    m: &Material,
) -> Result<(), String> {
    let file = path(app, course, course_id);
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let text = serde_json::to_string(m).map_err(|_| "课件没存上".to_string())?;
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, text)
        .and_then(|_| std::fs::rename(&tmp, &file))
        .map_err(|_| "课件没存上，请检查数据文件夹能不能写".to_string())
}

fn view(m: &Material) -> MaterialView {
    let terms: usize = m.slides.iter().map(|s| s.terms.len()).sum();
    MaterialView {
        slides: m
            .slides
            .iter()
            .map(|s| SlideView {
                name: s.name.clone(),
                added_at: s.added_at,
                terms: s.terms.len(),
            })
            .collect(),
        terms,
    }
}

const EXTRACT_PROMPT: &str = "下面是一门大学课程的课件文字（英文为主，从 PDF 或 PPT 里抽出来的，顺序和换行可能有点乱）。\
整理出这门课的术语表和提纲，用来帮助听写和翻译老师讲课。只输出一个 JSON 对象：\
{\"terms\": [{\"en\": \"英文术语\", \"zh\": \"中文译法\"}, ...], \"outline\": [\"主题\", ...]}。\
terms 挑专业术语、方法名、人名、缩写、容易听错拼错的词，最多 80 个；en 按课件里的写法，普通名词用小写，缩写和人名保留大写；\
zh 用这个领域通行的中文译法，人名、缩写没有通行译法就照抄英文。outline 是课件讲了哪些主题，按顺序，最多 20 条，每条不超过 20 个字，用中文。";

#[derive(Deserialize, Default)]
#[serde(default)]
struct Extracted {
    terms: Vec<GTerm>,
    outline: Vec<String>,
}

fn extract(key: &str, text: &str) -> Result<(Extracted, Usage), Fail> {
    let excerpt: String = text.chars().take(EXTRACT_TEXT).collect();
    let (out, usage) = chat(key, EXTRACT_PROMPT, &excerpt, true, 120)?;
    let mut got: Extracted =
        serde_json::from_str(&out).map_err(|_| Fail::Later("课件没整理出来，稍后再试".into()))?;
    got.terms
        .retain(|t| !t.en.trim().is_empty() && t.en.chars().count() <= 60);
    got.terms.truncate(80);
    got.outline.retain(|o| !o.trim().is_empty());
    got.outline.truncate(20);
    Ok((got, usage))
}

/// 这门课以前笔记里整理出来的术语
fn past_terms(app: &AppHandle, course: &str, course_id: Option<&str>) -> Vec<GTerm> {
    let mut out = Vec::new();
    let Ok(dir) = std::fs::read_dir(folder(app)) else {
        return out;
    };
    let name = course.trim().to_lowercase();
    for entry in dir.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(s) = std::fs::read_to_string(&p)
            .ok()
            .and_then(|t| serde_json::from_str::<Session>(&t).ok())
        else {
            continue;
        };
        let same = match (course_id, s.course_id.as_deref()) {
            (Some(a), Some(b)) => a == b,
            _ => s.course.trim().to_lowercase() == name,
        };
        if !same {
            continue;
        }
        if let Some(notes) = &s.notes {
            out.extend(notes.terms.iter().map(|t| GTerm {
                en: t.en.clone(),
                zh: t.zh.clone(),
            }));
        }
    }
    out
}

/// 这门课的术语表：课件 + 以前笔记 + 生词本
pub fn glossary_for(
    app: &AppHandle,
    course: &str,
    course_id: Option<&str>,
    words: &[String],
) -> Glossary {
    let m = load(app, course, course_id);
    let mut terms: Vec<GTerm> = m.slides.iter().flat_map(|s| s.terms.clone()).collect();
    let outline: Vec<String> = m
        .slides
        .iter()
        .flat_map(|s| s.outline.clone())
        .take(40)
        .collect();
    terms.extend(past_terms(app, course, course_id));
    terms.extend(
        words
            .iter()
            .filter(|w| !w.trim().is_empty())
            .map(|w| GTerm {
                en: w.trim().to_string(),
                zh: String::new(),
            }),
    );
    Glossary::new(terms, outline)
}

/// 正在听的就是这门课：术语表换成新的
fn refresh_current(app: &AppHandle, course: &str, course_id: Option<&str>) {
    let (same, words) = {
        let inner = lock(&app.state::<Lecture>().inner().0);
        let same = matches!(
            inner.status,
            Status::Listening | Status::Paused | Status::Finishing
        ) && match (course_id, inner.s.course_id.as_deref()) {
            (Some(a), Some(b)) => a == b,
            _ => inner.s.course.trim().eq_ignore_ascii_case(course.trim()),
        };
        (same, inner.words.clone())
    };
    if same {
        let fresh = Arc::new(glossary_for(app, course, course_id, &words));
        lock(&app.state::<Lecture>().inner().0).glossary = fresh;
    }
}

#[tauri::command(async)]
pub fn lecture_material(app: AppHandle, course: String, course_id: Option<String>) -> MaterialView {
    view(&load(&app, &course, course_id.as_deref()))
}

/// 传一份课件（界面已经把 PDF / PPT 里的字读出来了）：整理出术语和提纲存起来
#[tauri::command(async)]
pub fn lecture_add_slides(
    app: AppHandle,
    lecture: State<'_, Lecture>,
    course: String,
    course_id: Option<String>,
    name: String,
    text: String,
    key: String,
) -> Result<MaterialView, String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("先在设置的\u{201c}听课\u{201d}里填 DeepSeek 密钥".into());
    }
    let text: String = text.chars().take(MAX_TEXT).collect();
    if text.split_whitespace().count() < 20 {
        return Err("这份课件里读不出字，可能是扫描的图片。换一份带文字的试试".into());
    }
    let name: String = name.trim().chars().take(80).collect();
    // 阻塞的网络请求不能直接在异步命令里跑，另开一个线程
    let (got, usage) =
        std::thread::spawn(move || extract(&key, &text).map(|(got, usage)| ((got, text), usage)))
            .join()
            .unwrap_or_else(|_| Err(Fail::Later("课件没整理出来，稍后再试".into())))
            .map_err(|e| match e {
                Fail::Later(msg) | Fail::Skip(msg) => msg,
            })?;
    let (got, text) = got;
    let id = course_id.as_deref();
    let mut m = load(&app, &course, id);
    m.course = course.clone();
    m.slides.retain(|s| s.name != name);
    m.slides.push(Slide {
        name,
        added_at: now_ms(),
        text,
        terms: got.terms,
        outline: got.outline,
    });
    store(&app, &course, id, &m)?;
    {
        let mut inner = lock(&lecture.0);
        if matches!(
            inner.status,
            Status::Listening | Status::Paused | Status::Finishing
        ) {
            inner.s.usage.add(usage);
        }
    }
    refresh_current(&app, &course, id);
    crate::logger::info("lecture slides added");
    Ok(view(&m))
}

#[tauri::command(async)]
pub fn lecture_remove_slides(
    app: AppHandle,
    course: String,
    course_id: Option<String>,
    name: String,
) -> Result<MaterialView, String> {
    let id = course_id.as_deref();
    let mut m = load(&app, &course, id);
    m.slides.retain(|s| s.name != name);
    store(&app, &course, id, &m)?;
    refresh_current(&app, &course, id);
    Ok(view(&m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys() {
        assert_eq!(course_key("Signals", Some("abc_123")), "c-abc-123");
        assert_eq!(
            course_key("Signals", Some("")),
            course_key("signals ", None)
        );
        assert!(course_key("信号与系统", None).starts_with("n-"));
    }
}
