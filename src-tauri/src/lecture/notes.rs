//! 笔记：格式、给模型的提示词、把模型回来的东西整理成笔记、截止日期怎么算。
//!
//! - 听课中每 5 分钟只把新增的听写和上一版笔记一起给模型，让它合并（便宜、快，课再长也不慢）；
//!   下课后用完整的听写稿从头整理一遍
//! - 每条要点记着出自左边哪几句（编号），点一下能跳过去
//! - 截止日期：模型只说老师怎么说的（具体日期 / 周几 / 下节课 / 几天后），具体哪天由这里和界面按日历、课表算，
//!   不让模型自己推算
//! - 提示词里每次都一样的部分（说明 + 术语表）放在最前面，课程名、日期、这次要做什么放在后面：
//!   每次请求开头一样，能吃到 DeepSeek 的缓存

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------- 格式 ----------

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Point {
    pub text: String,
    /// 出自左边哪几句（句子的编号）
    pub refs: Vec<u64>,
}

/// 以前的笔记里要点只是一句话，现在是 { text, refs }：两种都认
#[derive(Deserialize)]
#[serde(untagged)]
enum PointRepr {
    Text(String),
    Full(Point),
}

fn points<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<Point>, D::Error> {
    let raw: Vec<PointRepr> = Vec::deserialize(d)?;
    Ok(raw
        .into_iter()
        .map(|p| match p {
            PointRepr::Text(text) => Point {
                text,
                refs: Vec::new(),
            },
            PointRepr::Full(p) => p,
        })
        .collect())
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Part {
    pub title: String,
    #[serde(deserialize_with = "points")]
    pub points: Vec<Point>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Term {
    pub en: String,
    pub zh: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// 老师是怎么说截止时间的
#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct When {
    /// date（说了具体日期）、weekday（周几）、next_class（下节课）、in_days（几天后）、unknown
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weekday: Option<u8>,
    pub next_week: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub days: Option<u32>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Due {
    pub title: String,
    /// "2026-12-04"。"下节课"要按课表算，这里是 null，界面去算
    pub date: Option<String>,
    pub quote: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when: Option<When>,
    /// 出自左边哪一句
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at_ref: Option<u64>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Notes {
    pub summary: String,
    pub outline: Vec<Part>,
    pub terms: Vec<Term>,
    pub dues: Vec<Due>,
    pub review: Vec<String>,
}

// ---------- 时间 ----------

/// 按上课那台电脑的时区算的"时:分"
pub fn clock(ms: u64, offset_min: i32) -> String {
    let local = ms as i64 + offset_min as i64 * 60_000;
    let mins = local.div_euclid(60_000);
    format!(
        "{:02}:{:02}",
        mins.div_euclid(60).rem_euclid(24),
        mins.rem_euclid(60)
    )
}

/// 从 1970-01-01 起第几天 → "YYYY-MM-DD"
fn civil(days: i64) -> String {
    let z = days + 719_468;
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

/// "YYYY-MM-DD" → 从 1970-01-01 起第几天
fn days_from(date: &str) -> Option<i64> {
    let mut it = date.trim().split('-');
    let y: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    let d: i64 = it.next()?.parse().ok()?;
    if it.next().is_some()
        || !(1..=12).contains(&m)
        || !(1..=31).contains(&d)
        || !(1900..=2200).contains(&y)
    {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    // 2 月 30 日这种：换回去对不上就不认
    (civil(days) == format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d))
        .then_some(days)
}

pub fn date_of(ms: u64) -> String {
    civil((ms / 86_400_000) as i64)
}

/// 按上课那台电脑的时区算的日期
pub fn local_date(ms: u64, offset_min: i32) -> String {
    date_of((ms as i64 + offset_min as i64 * 60_000).max(0) as u64)
}

/// 周一是 1，周日是 7
fn weekday(days: i64) -> i64 {
    (days + 3).rem_euclid(7) + 1
}

/// 按老师的说法算出具体哪天。"下节课"算不了（要看课表），返回 None
pub fn resolve(when: &When, explicit: Option<&str>, lecture_date: &str) -> Option<String> {
    let today = days_from(lecture_date)?;
    match when.kind.as_str() {
        "date" => explicit.and_then(days_from).map(civil),
        "weekday" => {
            let target = i64::from(when.weekday?);
            if !(1..=7).contains(&target) {
                return None;
            }
            let now = weekday(today);
            let day = if when.next_week {
                // "next Friday"：下一周的那个周五
                today - (now - 1) + 7 + (target - 1)
            } else {
                // "on Friday"：最近的那个周五；今天就是周五的话算下周
                let ahead = (target - now).rem_euclid(7);
                today + if ahead == 0 { 7 } else { ahead }
            };
            Some(civil(day))
        }
        "in_days" => when
            .days
            .filter(|&d| d <= 366)
            .map(|d| civil(today + d as i64)),
        _ => explicit.and_then(days_from).map(civil),
    }
}

// ---------- 提示词 ----------

const NOTES_PROMPT: &str = "你在帮一个留学生整理大学课堂笔记。\
听写稿是英文，每行的格式是\u{201c}[编号] 时:分 内容\u{201d}，按时间顺序；听写可能有错字，请结合上下文理解，专业词按正确写法。\
用简体中文整理，只输出一个 JSON 对象，格式是：\
{\"summary\": \"这节课讲了什么，两三句话\", \
\"outline\": [{\"title\": \"主题\", \"points\": [{\"text\": \"要点\", \"refs\": [出自哪几行的编号]}]}], \
\"terms\": [{\"en\": \"英文术语\", \"zh\": \"中文\", \"note\": \"一句话解释，可以省略\"}], \
\"dues\": [{\"title\": \"作业、考试或截止的事\", \"quote\": \"老师原话（英文，简短）\", \"ref\": 编号, \
\"when\": {\"kind\": \"date | weekday | next_class | in_days | unknown\", \"date\": \"YYYY-MM-DD\", \"weekday\": 1, \"next_week\": false, \"days\": 0}}], \
\"review\": [\"值得回去复习的地方\"]}。\
提纲按主题分段，跟着老师讲的顺序，每段三到六个要点；要点写成完整的短句，保留公式、数字和例子；refs 写这条要点出自的一到三行的编号。\
术语挑这节课真正重要的，最多十五个。\
dues 只放老师明确说了的作业、考试、截止时间，没有就是空数组。when 照老师的原话填，不要自己推算日期：\
说了具体日期用 date 并填 date；说\u{201c}周五\u{201d}\u{201c}下周五\u{201d}用 weekday，weekday 填 1 到 7（1 是周一），说 next 或 the following 时 next_week 为 true；\
说\u{201c}下节课\u{201d}\u{201c}下次上课前\u{201d}用 next_class；说\u{201c}两周内\u{201d}\u{201c}10 天后\u{201d}用 in_days 并填 days；说不清用 unknown。用不上的字段可以省略。";

/// 从开始过了多久："12:05"、"1:02:03"
pub fn elapsed(ms: u64) -> String {
    let secs = ms / 1000;
    let (h, m, s) = (secs / 3600, (secs / 60) % 60, secs % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

/// 听写稿：每句一行 "[编号] 时:分 内容"。base 有值（导入的录音）就写从头过了多久
pub fn transcript<'a>(
    lines: impl Iterator<Item = (u64, u64, &'a str)>,
    offset_min: i32,
    base: Option<u64>,
) -> String {
    let mut out = String::new();
    for (id, at, en) in lines {
        let when = match base {
            Some(b) => elapsed(at.saturating_sub(b)),
            None => clock(at, offset_min),
        };
        out.push_str(&format!("[{id}] {when} {}\n", en.trim()));
    }
    out
}

/// (system, user)。system 每次都一样（说明 + 术语表），能吃缓存
pub fn request(
    glossary: &str,
    course: &str,
    date: &str,
    previous: Option<&Notes>,
    lines: &str,
    final_pass: bool,
) -> (String, String) {
    let system = format!("{NOTES_PROMPT}{glossary}");
    let head = format!("课程：{course}\n上课日期：{date}\n\n");
    let user = if final_pass {
        format!("{head}这节课已经结束。下面是完整的听写稿，整理出整节课完整的笔记：\n\n{lines}")
    } else if let Some(prev) = previous {
        let prev_json = serde_json::to_string(&for_model(prev)).unwrap_or_default();
        format!(
            "{head}课还没上完，这是中途的一次更新。已有的笔记是：\n{prev_json}\n\n\
接着上次之后的听写稿是：\n\n{lines}\n\
把新内容合并进已有笔记（新主题加在后面，已有主题可以补充要点），输出合并后的完整 JSON。\
summary 可以先留空；已有要点的 refs 保留。"
        )
    } else {
        format!(
            "{head}课还没上完，下面是到目前为止的听写稿。只整理已经讲到的部分，summary 可以先留空：\n\n{lines}"
        )
    };
    (system, user)
}

/// 给模型看的已有笔记：和要它输出的格式一样
fn for_model(notes: &Notes) -> Value {
    serde_json::json!({
        "summary": notes.summary,
        "outline": notes.outline.iter().map(|p| serde_json::json!({
            "title": p.title,
            "points": p.points.iter().map(|pt| serde_json::json!({"text": pt.text, "refs": pt.refs})).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "terms": notes.terms.iter().map(|t| serde_json::json!({"en": t.en, "zh": t.zh, "note": t.note})).collect::<Vec<_>>(),
        "dues": notes.dues.iter().map(|d| serde_json::json!({
            "title": d.title, "quote": d.quote, "ref": d.at_ref,
            "when": d.when.as_ref().map(|w| serde_json::json!({
                "kind": w.kind, "weekday": w.weekday, "next_week": w.next_week, "days": w.days, "date": d.date,
            })),
        })).collect::<Vec<_>>(),
        "review": notes.review,
    })
}

// ---------- 读模型回来的东西 ----------

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn id_of(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.trim().trim_matches(|c| c == '[' || c == ']').parse().ok(),
        _ => None,
    }
}

fn list<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key)
        .and_then(|x| x.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[])
}

/// 模型回来的 JSON → 笔记。字段缺了、类型不对都尽量认，不认的丢掉；
/// valid 是这节课有哪些句子编号（编出来的不要）
pub fn parse(out: &str, lecture_date: &str, valid: &[u64]) -> Option<Notes> {
    let v: Value = serde_json::from_str(out.trim()).ok()?;
    if !v.is_object() {
        return None;
    }
    let ok_ref = |id: u64| valid.binary_search(&id).is_ok();
    let outline = list(&v, "outline")
        .iter()
        .filter_map(|part| {
            let title = text_of(part.get("title").unwrap_or(&Value::Null));
            let points: Vec<Point> = list(part, "points")
                .iter()
                .filter_map(|p| {
                    let (text, refs) = match p {
                        Value::String(s) => (s.trim().to_string(), Vec::new()),
                        _ => (
                            text_of(p.get("text").unwrap_or(&Value::Null)),
                            list(p, "refs")
                                .iter()
                                .filter_map(id_of)
                                .filter(|&id| ok_ref(id))
                                .take(5)
                                .collect(),
                        ),
                    };
                    (!text.is_empty()).then_some(Point { text, refs })
                })
                .collect();
            (!title.is_empty() || !points.is_empty()).then_some(Part { title, points })
        })
        .collect();
    let terms = list(&v, "terms")
        .iter()
        .filter_map(|t| {
            let en = text_of(t.get("en").unwrap_or(&Value::Null));
            let zh = text_of(t.get("zh").unwrap_or(&Value::Null));
            let note = t.get("note").map(text_of).filter(|n| !n.is_empty());
            (!en.is_empty()).then_some(Term { en, zh, note })
        })
        .collect();
    let dues = list(&v, "dues")
        .iter()
        .filter_map(|d| {
            let title = text_of(d.get("title").unwrap_or(&Value::Null));
            if title.is_empty() {
                return None;
            }
            let w = d.get("when").cloned().unwrap_or(Value::Null);
            let explicit = w
                .get("date")
                .or_else(|| d.get("date"))
                .map(text_of)
                .filter(|s| !s.is_empty());
            let when = When {
                kind: match w.get("kind").map(text_of).as_deref() {
                    Some(k @ ("date" | "weekday" | "next_class" | "in_days")) => k.to_string(),
                    _ if explicit.is_some() => "date".to_string(),
                    _ => "unknown".to_string(),
                },
                weekday: w.get("weekday").and_then(id_of).map(|n| n as u8),
                next_week: w
                    .get("next_week")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false),
                days: w.get("days").and_then(id_of).map(|n| n as u32),
            };
            let date = resolve(&when, explicit.as_deref(), lecture_date);
            let at_ref = d.get("ref").and_then(id_of).filter(|&id| ok_ref(id));
            Some(Due {
                title,
                date,
                quote: text_of(d.get("quote").unwrap_or(&Value::Null)),
                when: Some(when),
                at_ref,
            })
        })
        .collect();
    let review = list(&v, "review")
        .iter()
        .map(text_of)
        .filter(|s| !s.is_empty())
        .collect();
    Some(Notes {
        summary: text_of(v.get("summary").unwrap_or(&Value::Null)),
        outline,
        terms,
        dues,
        review,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert_eq!(date_of(0), "1970-01-01");
        assert_eq!(date_of(1_795_000_000_000), "2026-11-18");
        let seven_am_beijing = 1_795_046_400_000 - 86_400_000 + 23 * 3_600_000;
        assert_eq!(local_date(seven_am_beijing, 480), "2026-11-19");
        assert_eq!(clock(seven_am_beijing, 480), "07:00");
        assert_eq!(clock(seven_am_beijing, 0), "23:00");
        assert_eq!(days_from("1970-01-01"), Some(0));
        assert_eq!(
            days_from("2026-11-18").map(civil).as_deref(),
            Some("2026-11-18")
        );
        assert_eq!(days_from("2026-02-30"), None);
        assert_eq!(days_from("soon"), None);
        // 2026-11-18 是周三
        assert_eq!(weekday(days_from("2026-11-18").unwrap()), 3);
    }

    #[test]
    fn resolves_what_the_teacher_said() {
        let wed = "2026-11-18";
        let w = |kind: &str, weekday: Option<u8>, next_week: bool, days: Option<u32>| When {
            kind: kind.into(),
            weekday,
            next_week,
            days,
        };
        // 周三说"周五交" → 这周五
        assert_eq!(
            resolve(&w("weekday", Some(5), false, None), None, wed).as_deref(),
            Some("2026-11-20")
        );
        // "next Friday" → 下周五
        assert_eq!(
            resolve(&w("weekday", Some(5), true, None), None, wed).as_deref(),
            Some("2026-11-27")
        );
        // 周三说"周一" → 下周一
        assert_eq!(
            resolve(&w("weekday", Some(1), false, None), None, wed).as_deref(),
            Some("2026-11-23")
        );
        // 周三说"周三" → 下周三
        assert_eq!(
            resolve(&w("weekday", Some(3), false, None), None, wed).as_deref(),
            Some("2026-11-25")
        );
        assert_eq!(
            resolve(&w("in_days", None, false, Some(14)), None, wed).as_deref(),
            Some("2026-12-02")
        );
        assert_eq!(
            resolve(&w("date", None, false, None), Some("2026-12-04"), wed).as_deref(),
            Some("2026-12-04")
        );
        assert_eq!(
            resolve(&w("next_class", None, false, None), None, wed),
            None
        );
        assert_eq!(resolve(&w("unknown", None, false, None), None, wed), None);
        // 跨年
        assert_eq!(
            resolve(&w("in_days", None, false, Some(20)), None, "2026-12-20").as_deref(),
            Some("2027-01-09")
        );
    }
}
