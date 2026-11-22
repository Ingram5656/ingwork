//! 课后用录音重新整理（参考 Meetily 的 Enhance）：下课后把整节课的录音按更长的段（20～60 秒、切在停顿处）
//! 重新听写一遍，听写的上下文多、切口少，比边听边写的准；再成批翻译、完整整理笔记。
//! 全部做完才替换左边的原文和右边的笔记，中途失败就保留原来的。

use super::{
    audio, audio_path, chat, lock, now_ms, record, stitch, summarize, transcribe, translate,
    update, Fail, Lecture, Segment, Usage,
};
use tauri::{AppHandle, Manager};

/// 一次读多少录音
const STEP: u64 = audio::RATE as u64 * 5;
/// 一次翻几句
const BATCH: usize = 10;

const BATCH_PROMPT: &str = "你是大学课堂的翻译。把 sentences 里老师说的每一句英文翻成自然、准确的简体中文，像中文老师在讲课。\
专业术语第一次出现时在中文后面用括号保留英文原词。context 是前面几句，只帮你理解上下文，不要翻译。\
只输出一个 JSON 对象：{\"zh\": [\"第一句的译文\", ...]}，条数和 sentences 一样、顺序一样。";

/// 成批翻译。条数对不上算失败（外面会一句一句再翻）
fn translate_batch(
    key: &str,
    glossary: &str,
    context: &[String],
    items: &[String],
) -> Result<(Vec<String>, Usage), Fail> {
    let system = format!("{BATCH_PROMPT}{glossary}");
    let user = serde_json::json!({ "context": context, "sentences": items }).to_string();
    let (out, usage) = chat(key, &system, &user, true, 120)?;
    let v: serde_json::Value =
        serde_json::from_str(&out).map_err(|_| Fail::Skip("翻译回来的内容读不懂".into()))?;
    let zh: Vec<String> = v
        .get("zh")
        .and_then(|z| z.as_array())
        .map(|a| {
            a.iter()
                .map(|x| x.as_str().unwrap_or("").trim().to_string())
                .collect()
        })
        .unwrap_or_default();
    if zh.len() != items.len() {
        return Err(Fail::Skip("翻译的条数对不上".into()));
    }
    Ok((zh, usage))
}

/// 翻一批句子：先成批翻，不行就一句一句翻，再不行留空
pub(super) fn translate_all(
    key: &str,
    glossary: &str,
    context: &[String],
    items: &[(u64, String)],
    usage: &mut Usage,
) -> Vec<String> {
    let texts: Vec<String> = items.iter().map(|(_, en)| en.clone()).collect();
    if let Ok((got, u)) = translate_batch(key, glossary, context, &texts) {
        usage.add(u);
        return got;
    }
    texts
        .iter()
        .map(|en| match translate(key, glossary, &[], en) {
            Ok((one, u)) => {
                usage.add(u);
                one
            }
            Err(_) => String::new(),
        })
        .collect()
}

/// 听写一段，断网、DeepSeek 忙就多试几次
pub(super) fn hear(key: &str, chunk: &audio::Chunk) -> Result<Option<(String, u64)>, String> {
    let wav = audio::wav(&chunk.samples);
    let mut wait = 2;
    for _ in 0..6 {
        match transcribe(key, &wav) {
            Ok(got) => return Ok(Some(got)),
            Err(Fail::Skip(_)) => return Ok(None),
            Err(Fail::Later(msg)) => {
                if msg.contains("密钥") || msg.contains("余额") {
                    return Err(msg);
                }
                std::thread::sleep(std::time::Duration::from_secs(wait));
                wait = (wait * 2).min(30);
            }
        }
    }
    Err("DeepSeek 一直连不上，重新整理先停下了，原来的笔记没动".into())
}

/// 把整句拆开，按在这一段里的位置估一个开始时刻
pub(super) fn place(at: u64, until: u64, text: &str, out: &mut Vec<(u64, String)>) {
    let parts = stitch::split(text);
    let words: usize = parts
        .iter()
        .map(|p| p.split_whitespace().count())
        .sum::<usize>()
        .max(1);
    let span = until.saturating_sub(at);
    let mut seen = 0usize;
    for p in parts {
        out.push((at + span * seen as u64 / words as u64, p.clone()));
        seen += p.split_whitespace().count();
    }
}

fn progress(app: &AppHandle, generation: u64, pct: u64) -> Result<(), String> {
    if update(app, generation, |inner| {
        inner.redo = Some(pct.min(99) as u8)
    }) {
        Ok(())
    } else {
        Err(String::new())
    }
}

fn run(app: &AppHandle, generation: u64) -> Result<(), String> {
    let (key, glossary, mut session) = {
        let inner = lock(&app.state::<Lecture>().inner().0);
        if inner.generation != generation {
            return Err(String::new());
        }
        (inner.key.clone(), inner.glossary.clone(), inner.s.clone())
    };
    let id = session.id.clone().unwrap_or_default();
    let path = audio_path(app, &id);
    let total = record::length(&path).ok_or("这台电脑上没有这节课的录音")?;
    let marks = session.audio_marks.clone();
    if total == 0 || marks.is_empty() {
        return Err("这台电脑上没有这节课的录音".into());
    }
    let block = glossary.prompt_block();
    let mut usage = Usage::default();
    let mut cutter = audio::Cutter::with_limits(audio::detector(), audio::REDO);
    let mut assembler = stitch::Assembler::default();
    let mut last_text = String::new();
    let mut sentences: Vec<(u64, String)> = Vec::new();

    // 1. 按段重新听写（占进度的 80%）
    let mut pos = 0;
    while pos < total {
        let end = (pos + STEP).min(total);
        let samples = record::read(&path, pos, end).map_err(|_| "录音读不出来，文件可能坏了")?;
        let mut ready = Vec::new();
        cutter.push(
            &samples,
            record::time_at(&marks, end),
            &mut |_| {},
            &mut |c| ready.push(c),
        );
        if end >= total {
            cutter.cut(&mut |c| ready.push(c));
        }
        for chunk in ready {
            let until =
                chunk.at + (chunk.samples.len() - chunk.overlap) as u64 * 1000 / audio::RATE as u64;
            let Some((mut text, ms)) = hear(&key, &chunk)? else {
                continue;
            };
            usage.asr_ms += ms;
            if chunk.overlap > 0 {
                text = stitch::dedupe(&last_text, &text);
            }
            text = glossary.correct(&text);
            if stitch::is_noise(&text, &last_text) {
                continue;
            }
            last_text = text.clone();
            if let Some((at, done)) = assembler.push(&text, chunk.at, now_ms()) {
                place(at, until, &done, &mut sentences);
            }
        }
        pos = end;
        progress(app, generation, pos * 80 / total)?;
    }
    if let Some((at, rest)) = assembler.flush() {
        place(at, record::time_at(&marks, total), &rest, &mut sentences);
    }
    if sentences.is_empty() {
        return Err("录音里没听出说话，原来的笔记没动".into());
    }

    // 2. 成批翻译（80～95%）
    let mut zh: Vec<String> = Vec::with_capacity(sentences.len());
    for (n, batch) in sentences.chunks(BATCH).enumerate() {
        let context: Vec<String> = sentences[..n * BATCH]
            .iter()
            .rev()
            .take(3)
            .rev()
            .map(|(_, en)| en.clone())
            .collect();
        zh.extend(translate_all(&key, &block, &context, batch, &mut usage));
        progress(
            app,
            generation,
            80 + (zh.len() * 15 / sentences.len()) as u64,
        )?;
    }

    // 3. 完整整理笔记，全部成功才换掉原来的
    session.segments = sentences
        .into_iter()
        .zip(zh)
        .enumerate()
        .map(|(i, ((at, en), zh))| Segment {
            id: i as u64 + 1,
            at,
            en,
            zh: Some(zh),
        })
        .collect();
    let (fresh, u) = summarize(&key, &block, &session, None, true).map_err(|e| match e {
        Fail::Later(msg) | Fail::Skip(msg) => msg,
    })?;
    usage.add(u);
    let ok = update(app, generation, |inner| {
        inner.s.segments = session.segments;
        inner.s.notes = Some(fresh);
        inner.s.notes_at = Some(now_ms());
        inner.notes_upto = inner.s.segments.len();
        inner.s.usage.add(usage);
    });
    if ok {
        Ok(())
    } else {
        Err(String::new())
    }
}

pub(super) fn spawn(app: AppHandle, generation: u64) {
    std::thread::spawn(move || {
        let result = run(&app, generation);
        if let Err(msg) = &result {
            if !msg.is_empty() {
                crate::logger::error(&format!("lecture redo: {msg}"));
            }
        }
        let ok = update(&app, generation, |inner| {
            inner.redo = None;
            match result {
                Ok(()) => inner.error = None,
                Err(msg) if !msg.is_empty() => inner.error = Some(msg),
                Err(_) => {}
            }
        });
        if ok {
            super::save_current(&app, generation);
        }
    });
}
