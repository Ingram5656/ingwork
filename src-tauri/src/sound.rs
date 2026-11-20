//! 声音：到点的提示音和专注时的环境音。
//! 在 Rust 里放，窗口关着也能响，也不受网页内核"先点一下才出声"的限制。
//!
//! 声卡的输出流不能跨线程，所以单独开一个线程专门放声音，别处通过通道发命令。
//!
//! 环境音：`sounds/ambient/` 文件夹里放什么文件，软件里就有什么声音（ogg、mp3、wav、flac），
//! 文件名（不带后缀）就是它的名字。加了、换了文件要重新编译才生效。

use include_dir::{include_dir, Dir};
use rodio::Source;
use std::io::Cursor;
use std::path::Path;
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;

static AMBIENT: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/sounds/ambient");

/// 环境音开始时淡入多久，免得突然响起来
const FADE_IN: Duration = Duration::from_millis(900);

enum Command {
    /// 放一个提示音
    Prompt { id: String, volume: f32 },
    /// 现在应该响着的环境音和各自的音量。空的就是全部停掉
    Ambient(Vec<(String, f32)>),
}

pub struct Sound {
    tx: Mutex<Sender<Command>>,
}

/// 内置的提示音。以后换成你给的音频时，改这里和 sounds/ 里的文件。
fn prompt_bytes(id: &str) -> Option<&'static [u8]> {
    match id {
        "bell" => Some(&include_bytes!("../sounds/bell.wav")[..]),
        "drop" => Some(&include_bytes!("../sounds/drop.wav")[..]),
        "chord" => Some(&include_bytes!("../sounds/chord.wav")[..]),
        "marimba" => Some(&include_bytes!("../sounds/marimba.wav")[..]),
        _ => None,
    }
}

fn is_audio(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    matches!(
        extension.as_deref(),
        Some("ogg") | Some("mp3") | Some("wav") | Some("flac")
    )
}

fn stem(path: &Path) -> Option<&str> {
    path.file_stem().and_then(|s| s.to_str())
}

/// 有哪些环境音（文件名去掉后缀），按名字排好。
pub fn ambient_ids() -> Vec<String> {
    let mut ids: Vec<String> = AMBIENT
        .files()
        .filter(|file| is_audio(file.path()))
        .filter_map(|file| stem(file.path()).map(str::to_string))
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

fn ambient_bytes(id: &str) -> Option<&'static [u8]> {
    AMBIENT
        .files()
        .find(|file| is_audio(file.path()) && stem(file.path()) == Some(id))
        .map(|file| file.contents())
}

/// 放声音的线程手里的东西。
struct Engine {
    out: Option<(rodio::OutputStream, rodio::OutputStreamHandle)>,
    prompt: Option<rodio::Sink>,
    /// 正在响的环境音：名字、播放器、音量
    ambient: Vec<(String, rodio::Sink, f32)>,
}

impl Engine {
    /// 拿到输出设备，没开就打开。
    fn handle(&mut self) -> Option<rodio::OutputStreamHandle> {
        if self.out.is_none() {
            self.out = rodio::OutputStream::try_default().ok();
        }
        self.out.as_ref().map(|(_, handle)| handle.clone())
    }

    fn prompt(&mut self, id: &str, volume: f32) {
        // 上一个提示音停掉
        self.prompt = None;
        // 没有环境音在响时，重新打开输出设备，这样中途换了耳机或音箱也能响
        if self.ambient.is_empty() {
            self.out = None;
        }
        let Some(bytes) = prompt_bytes(id) else {
            return;
        };
        let Some(handle) = self.handle() else {
            return;
        };
        let Ok(sink) = rodio::Sink::try_new(&handle) else {
            return;
        };
        let Ok(source) = rodio::Decoder::new(Cursor::new(bytes)) else {
            return;
        };
        sink.set_volume(volume.clamp(0.0, 1.0));
        sink.append(source);
        self.prompt = Some(sink);
    }

    fn ambient(&mut self, wanted: Vec<(String, f32)>) {
        // 不要了的先淡出再停
        let (keep, stop): (Vec<_>, Vec<_>) = std::mem::take(&mut self.ambient)
            .into_iter()
            .partition(|(id, _, _)| wanted.iter().any(|(w, _)| w == id));
        self.ambient = keep;
        fade_out(stop);

        for (id, volume) in wanted {
            let volume = volume.clamp(0.0, 1.0);
            // 已经在响的只调音量
            if let Some(entry) = self.ambient.iter_mut().find(|(have, _, _)| *have == id) {
                entry.1.set_volume(volume);
                entry.2 = volume;
                continue;
            }
            let Some(bytes) = ambient_bytes(&id) else {
                continue;
            };
            let Some(handle) = self.handle() else {
                continue;
            };
            let Ok(sink) = rodio::Sink::try_new(&handle) else {
                continue;
            };
            // 循环播放，开头淡入
            let Ok(source) = rodio::Decoder::new_looped(Cursor::new(bytes)) else {
                continue;
            };
            sink.set_volume(volume);
            sink.append(source.fade_in(FADE_IN));
            self.ambient.push((id, sink, volume));
        }
    }
}

/// 在四分之一秒里把音量降到零，然后停掉。
fn fade_out(sinks: Vec<(String, rodio::Sink, f32)>) {
    if sinks.is_empty() {
        return;
    }
    const STEPS: u32 = 8;
    for step in (0..STEPS).rev() {
        for (_, sink, volume) in &sinks {
            sink.set_volume(volume * step as f32 / STEPS as f32);
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

impl Sound {
    pub fn spawn() -> Self {
        let (tx, rx) = channel::<Command>();
        std::thread::spawn(move || {
            let mut engine = Engine {
                out: None,
                prompt: None,
                ambient: Vec::new(),
            };
            for command in rx {
                match command {
                    Command::Prompt { id, volume } => engine.prompt(&id, volume),
                    Command::Ambient(wanted) => engine.ambient(wanted),
                }
            }
        });
        Self { tx: Mutex::new(tx) }
    }

    fn send(&self, command: Command) {
        let tx = self.tx.lock().unwrap_or_else(|e| e.into_inner());
        let _ = tx.send(command);
    }

    /// 放一个提示音
    pub fn play(&self, id: &str, volume: f32) {
        self.send(Command::Prompt {
            id: id.to_string(),
            volume,
        });
    }

    /// 告诉它现在应该响着哪些环境音。空的就是全部停掉。
    pub fn ambient(&self, wanted: Vec<(String, f32)>) {
        self.send(Command::Ambient(wanted));
    }
}
