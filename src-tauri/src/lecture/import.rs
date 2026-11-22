//! 导入录音或视频出笔记（参考 Meetily 的导入）：课后补听学校的课程回放、自己用手机录的课。
//!
//! 边读边解码（symphonia：mp3、m4a、aac、mp4、mov、wav、flac、ogg……），换成 16 kHz，
//! 按长段（20～60 秒、切在停顿处）听写，拼成整句，每凑够十句成批翻译一次就显示出来；读完再完整整理笔记。
//! 时刻按录音里的位置算（界面上显示成"第几分几秒"）。

use super::glossary::Glossary;
use super::{
    audio, audio_path, busy, lock, now_ms, publish, record, redo, save_current, spawn_summary,
    stitch, update, Inner, Lecture, Segment, Session, Status, Usage,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as DecodeError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// 凑够几句翻一次
const BATCH: usize = 10;

struct Decoded {
    format: Box<dyn symphonia::core::formats::FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track: u32,
    rate: u32,
    /// 一共多少帧（有的文件不知道）
    frames: Option<u64>,
}

fn open_file(path: &Path) -> Result<Decoded, String> {
    let unreadable = "这个文件读不出声音，换成 mp3、m4a、mp4 或 wav 试试";
    let file = std::fs::File::open(path).map_err(|_| "文件打不开".to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|_| unreadable.to_string())?;
    let format = probed.format;
    let (track, rate, frames, params) = {
        let t = format
            .tracks()
            .iter()
            .find(|t| {
                t.codec_params.codec != CODEC_TYPE_NULL && t.codec_params.sample_rate.is_some()
            })
            .ok_or_else(|| unreadable.to_string())?;
        (
            t.id,
            t.codec_params.sample_rate.unwrap_or(44_100),
            t.codec_params.n_frames,
            t.codec_params.clone(),
        )
    };
    let decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .map_err(|_| unreadable.to_string())?;
    Ok(Decoded {
        format,
        decoder,
        track,
        rate,
        frames,
    })
}

/// 读下一块，换成单声道。读完返回 None
fn next_block(d: &mut Decoded) -> Option<Vec<f32>> {
    loop {
        let packet = match d.format.next_packet() {
            Ok(p) => p,
            Err(DecodeError::ResetRequired) => return None,
            Err(_) => return None,
        };
        if packet.track_id() != d.track {
            continue;
        }
        match d.decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                let channels = spec.channels.count().max(1);
                let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
                buf.copy_interleaved_ref(decoded);
                return Some(
                    buf.samples()
                        .chunks(channels)
                        .map(|f| f.iter().sum::<f32>() / f.len() as f32)
                        .collect(),
                );
            }
            // 坏了一小块：跳过
            Err(DecodeError::DecodeError(_)) => continue,
            Err(_) => return None,
        }
    }
}

/// 把拼好的整句成批翻译，加到左边
fn emit(
    app: &AppHandle,
    generation: u64,
    key: &str,
    block: &str,
    queue: &mut Vec<(u64, String)>,
    next_id: &mut u64,
    usage: &mut Usage,
) -> bool {
    if queue.is_empty() {
        return true;
    }
    let items: Vec<(u64, String)> = std::mem::take(queue);
    let context: Vec<String> = {
        let inner = lock(&app.state::<Lecture>().inner().0);
        let n = inner.s.segments.len();
        inner.s.segments[n.saturating_sub(3)..]
            .iter()
            .map(|s| s.en.clone())
            .collect()
    };
    let zh = redo::translate_all(key, block, &context, &items, usage);
    update(app, generation, |inner| {
        for ((at, en), zh) in items.into_iter().zip(zh) {
            inner.s.segments.push(Segment {
                id: *next_id,
                at,
                en,
                zh: Some(zh),
            });
            *next_id += 1;
        }
    })
}

fn run(
    app: &AppHandle,
    generation: u64,
    path: PathBuf,
    stop: Arc<AtomicBool>,
    save: bool,
) -> Result<(), String> {
    let mut d = open_file(&path)?;
    let (key, glossary, started) = {
        let inner = lock(&app.state::<Lecture>().inner().0);
        if inner.generation != generation {
            return Err(String::new());
        }
        (
            inner.key.clone(),
            inner.glossary.clone(),
            inner.s.started_at.unwrap_or_else(now_ms),
        )
    };
    let block = glossary.prompt_block();
    let mut resampler = audio::Resampler::new(d.rate, audio::RATE);
    let mut cutter = audio::Cutter::with_limits(audio::detector(), audio::REDO);
    let mut writer = if save {
        let id = format!("{started}");
        match record::Writer::create(&audio_path(app, &id)) {
            Ok(w) => {
                update(app, generation, |inner| {
                    inner.s.audio_marks.push(record::Mark {
                        at: started,
                        sample: 0,
                    });
                    inner.audio_here = true;
                });
                Some(w)
            }
            Err(_) => None,
        }
    } else {
        None
    };
    let mut assembler = stitch::Assembler::default();
    let mut last_text = String::new();
    let mut queue: Vec<(u64, String)> = Vec::new();
    let mut next_id = 1u64;
    let mut usage = Usage::default();
    let mut read_frames = 0u64;
    let mut done16 = 0u64;
    let mut out = Vec::new();
    let mut last_pct = 0u64;

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let Some(samples) = next_block(&mut d) else {
            break;
        };
        read_frames += samples.len() as u64;
        out.clear();
        resampler.push(&samples, &mut out);
        if let Some(w) = writer.as_mut() {
            let _ = w.push(&out);
        }
        done16 += out.len() as u64;
        let now = started + done16 * 1000 / audio::RATE as u64;
        let mut ready = Vec::new();
        cutter.push(&out, now, &mut |_| {}, &mut |c| ready.push(c));
        for chunk in ready {
            if !hear_one(
                app,
                generation,
                &key,
                &glossary,
                &chunk,
                &mut last_text,
                &mut assembler,
                &mut queue,
                &mut usage,
            )? {
                return Err(String::new());
            }
            if queue.len() >= BATCH
                && !emit(
                    app,
                    generation,
                    &key,
                    &block,
                    &mut queue,
                    &mut next_id,
                    &mut usage,
                )
            {
                return Err(String::new());
            }
        }
        // 进度
        let pct = d
            .frames
            .map(|n| read_frames * 100 / n.max(1))
            .unwrap_or(0)
            .min(99);
        if pct != last_pct {
            last_pct = pct;
            let listened = done16 * 1000 / audio::RATE as u64;
            if !update(app, generation, |inner| {
                inner.progress = Some(pct as u8);
                inner.s.listened_ms = listened;
            }) {
                return Err(String::new());
            }
        }
    }
    // 收尾：最后一段、没说完的半句、没翻的几句
    let mut ready = Vec::new();
    cutter.cut(&mut |c| ready.push(c));
    for chunk in ready {
        hear_one(
            app,
            generation,
            &key,
            &glossary,
            &chunk,
            &mut last_text,
            &mut assembler,
            &mut queue,
            &mut usage,
        )?;
    }
    if let Some((at, rest)) = assembler.flush() {
        let until = started + done16 * 1000 / audio::RATE as u64;
        redo::place(at, until, &rest, &mut queue);
    }
    emit(
        app,
        generation,
        &key,
        &block,
        &mut queue,
        &mut next_id,
        &mut usage,
    );
    if let Some(w) = writer {
        let _ = w.finish();
    }
    let listened = done16 * 1000 / audio::RATE as u64;
    update(app, generation, |inner| {
        inner.s.usage.add(usage);
        inner.s.listened_ms = listened;
        inner.progress = None;
    });
    Ok(())
}

/// 听写一段、拼句子。DeepSeek 一直连不上返回 Err
#[allow(clippy::too_many_arguments)]
fn hear_one(
    app: &AppHandle,
    generation: u64,
    key: &str,
    glossary: &Glossary,
    chunk: &audio::Chunk,
    last_text: &mut String,
    assembler: &mut stitch::Assembler,
    queue: &mut Vec<(u64, String)>,
    usage: &mut Usage,
) -> Result<bool, String> {
    let Some((mut text, ms)) = redo::hear(key, chunk)? else {
        return Ok(true);
    };
    usage.asr_ms += ms;
    if chunk.overlap > 0 {
        text = stitch::dedupe(last_text, &text);
    }
    text = glossary.correct(&text);
    if stitch::is_noise(&text, last_text) {
        return Ok(true);
    }
    *last_text = text.clone();
    let until = chunk.at + (chunk.samples.len() - chunk.overlap) as u64 * 1000 / audio::RATE as u64;
    if let Some((at, done)) = assembler.push(&text, chunk.at, now_ms()) {
        redo::place(at, until, &done, queue);
    }
    let pending = assembler
        .pending()
        .map(|(at, en)| super::Pending { at, en });
    Ok(update(app, generation, |inner| inner.pending = pending))
}

/// 选一个录音或视频文件导入。取消了返回 false
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn lecture_import(
    app: AppHandle,
    lecture: State<'_, Lecture>,
    course: String,
    course_id: Option<String>,
    key: String,
    utc_offset_min: Option<i32>,
    words: Option<Vec<String>>,
    save_audio: Option<bool>,
) -> Result<bool, String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("先在设置的\u{201c}听课\u{201d}里填 DeepSeek 密钥".into());
    }
    let course = course.trim().chars().take(80).collect::<String>();
    if course.is_empty() {
        return Err("写一个课名".into());
    }
    if busy(&lock(&lecture.0)) {
        return Err("正在听一节课，先结束它".into());
    }
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter(
            "录音或视频",
            &[
                "mp3", "m4a", "aac", "mp4", "mov", "m4v", "wav", "flac", "ogg", "oga", "mkv",
                "webm", "aiff", "aif", "caf",
            ],
        )
        .blocking_pick_file()
    else {
        return Ok(false);
    };
    let path = picked
        .into_path()
        .map_err(|_| "这个文件打不开".to_string())?;
    // 先试一下能不能读，读不了就别开始
    open_file(&path)?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let words: Vec<String> = words.unwrap_or_default().into_iter().take(500).collect();
    let glossary = Arc::new(super::course::glossary_for(
        &app,
        &course,
        course_id.as_deref(),
        &words,
    ));
    let stop = Arc::new(AtomicBool::new(false));
    let generation = {
        let mut inner = lock(&lecture.0);
        if busy(&inner) {
            return Err("正在听一节课，先结束它".into());
        }
        let generation = inner.generation + 1;
        let now = now_ms();
        *inner = Inner {
            status: Status::Importing,
            s: Session {
                id: Some(format!("{now}")),
                course,
                course_id,
                started_at: Some(now),
                utc_offset_min: utc_offset_min.unwrap_or(0).clamp(-14 * 60, 14 * 60),
                imported: Some(name),
                ..Session::default()
            },
            key,
            generation,
            glossary,
            words,
            progress: Some(0),
            stop: Some(stop.clone()),
            ..Inner::default()
        };
        generation
    };
    crate::awake::lecture(true);
    crate::logger::info("lecture import started");
    publish(&app);
    let save = save_audio.unwrap_or(false);
    let app2 = app.clone();
    std::thread::spawn(move || {
        let result = run(&app2, generation, path, stop, save);
        save_current(&app2, generation);
        let empty = lock(&app2.state::<Lecture>().inner().0)
            .s
            .segments
            .is_empty();
        let ok = update(&app2, generation, |inner| {
            inner.progress = None;
            inner.pending = None;
            inner.stop = None;
            match &result {
                Err(msg) if !msg.is_empty() => inner.error = Some(msg.clone()),
                _ if empty => inner.error = Some("这个文件里没听到说话，没有可整理的".into()),
                _ => {}
            }
            inner.status = if empty {
                Status::Done
            } else {
                Status::Finishing
            };
        });
        if ok && !empty {
            // 完整整理笔记（整理完会把状态改成 Done）
            spawn_summary(app2.clone(), generation, true);
        } else {
            crate::awake::lecture(false);
        }
    });
    Ok(true)
}
