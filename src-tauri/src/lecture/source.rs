//! 听课的声音从哪来：麦克风，或者电脑正在播放的声音（网课、Teams、课程回放）。
//!
//! 用 cpal 0.17：在"输出设备"上开输入流就是录它正在放的声音——Windows 用 WASAPI 的回环录音，
//! Mac 用系统的"进程声音监听"（macOS 14.2 以上，第一次会问要不要允许），见 systap.rs。
//! 软件里放环境音用的 rodio 还在用旧版 cpal，两个版本并存，互不影响。

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal17 as cpal;
use std::sync::mpsc::{self, Receiver};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Source {
    Mic,
    System,
}

impl Source {
    pub fn parse(s: Option<&str>) -> Self {
        match s {
            Some("system") => Source::System,
            _ => Source::Mic,
        }
    }
}

/// 开着的声音来源：得一直拿着，丢了就停。先停流，再拆 Mac 上的监听
pub struct Input {
    _stream: cpal::Stream,
    #[cfg(target_os = "macos")]
    _tap: Option<super::systap::SystemTap>,
}

/// Mac：建好监听后，在 cpal 的输入设备里按 UID 找到那个聚合设备
#[cfg(target_os = "macos")]
fn tap_device(host: &cpal::Host, fail: &str) -> Result<cpal::Device, String> {
    // 刚建好的聚合设备偶尔要等一下才列得出来
    for _ in 0..10 {
        if let Ok(mut devices) = host.input_devices() {
            if let Some(d) =
                devices.find(|d| d.id().map(|id| id.1 == super::systap::UID).unwrap_or(false))
            {
                return Ok(d);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    crate::logger::error("lecture system audio: aggregate device not listed");
    Err(fail.to_string())
}

/// Mac 上录电脑声音时自己建的那个设备：只有本程序看得见，不算麦克风
#[cfg(target_os = "macos")]
const OWN_DEVICE: &str = "ingwork system audio";
#[cfg(not(target_os = "macos"))]
const OWN_DEVICE: &str = "";

fn name_of(device: &cpal::Device) -> Option<String> {
    let name = device.description().ok()?.name().trim().to_string();
    (!name.is_empty() && name != OWN_DEVICE).then_some(name)
}

/// 这台电脑上的麦克风（名字），设置里选用哪个
pub fn inputs() -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    if let Ok(devices) = cpal::default_host().input_devices() {
        for name in devices.filter_map(|d| name_of(&d)) {
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    names
}

/// 按名字找麦克风。没找到（拔掉了、换了电脑）返回 None，外面退回系统默认的
fn input_named(host: &cpal::Host, name: &str) -> Option<cpal::Device> {
    let found = host
        .input_devices()
        .ok()?
        .find(|d| name_of(d).as_deref() == Some(name));
    if found.is_none() {
        crate::logger::info("lecture input: chosen microphone not found, using the default");
    }
    found
}

/// 打开声音来源：返回来源（得一直拿着）、单声道样本从哪儿来、采样率。
/// device 是设置里选的麦克风的名字，没选就用系统默认的
pub fn open(
    source: Source,
    device: Option<&str>,
) -> Result<(Input, Receiver<Vec<f32>>, u32), String> {
    let host = cpal::default_host();
    #[cfg(target_os = "macos")]
    let mut tap = None;
    let (device, config, fail) = match source {
        Source::Mic => {
            let fail = "麦克风打不开，请检查系统设置里是否允许 ingwork 使用麦克风";
            let device = device
                .and_then(|name| input_named(&host, name.trim()))
                .or_else(|| host.default_input_device())
                .ok_or_else(|| {
                    "没找到麦克风，请检查有没有插好、系统设置里有没有关掉".to_string()
                })?;
            let config = device
                .default_input_config()
                .map_err(|_| fail.to_string())?;
            (device, config, fail)
        }
        #[cfg(target_os = "macos")]
        Source::System => {
            // 不交给 cpal 自己判断：戴着 AirPods、耳机（带麦克风）时它会去开耳机的麦克风
            let fail = MAC_FAIL;
            tap = Some(super::systap::SystemTap::create()?);
            let device = tap_device(&host, fail)?;
            let config = device.default_input_config().map_err(|e| {
                crate::logger::error(&format!("lecture system audio config: {e}"));
                fail.to_string()
            })?;
            (device, config, fail)
        }
        #[cfg(not(target_os = "macos"))]
        Source::System => {
            let fail = "没能录到电脑的声音，请检查有没有在放声音的设备";
            let device = host
                .default_output_device()
                .ok_or_else(|| "没找到正在放声音的设备".to_string())?;
            let config = device.default_output_config().map_err(|e| {
                crate::logger::error(&format!("lecture system audio config: {e}"));
                fail.to_string()
            })?;
            (device, config, fail)
        }
    };
    let channels = config.channels().max(1) as usize;
    let rate = u32::from(config.sample_rate());
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let err = |e: cpal::StreamError| crate::logger::error(&format!("lecture audio input: {e}"));

    fn mono<T: Copy>(data: &[T], channels: usize, conv: impl Fn(T) -> f32) -> Vec<f32> {
        data.chunks(channels)
            .map(|frame| frame.iter().map(|&v| conv(v)).sum::<f32>() / frame.len() as f32)
            .collect()
    }

    let stream_config = config.config();
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => {
            let tx = tx.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let _ = tx.send(mono(data, channels, |v| v));
                },
                err,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let tx = tx.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    let _ = tx.send(mono(data, channels, |v| v as f32 / 32768.0));
                },
                err,
                None,
            )
        }
        cpal::SampleFormat::I32 => {
            let tx = tx.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[i32], _: &cpal::InputCallbackInfo| {
                    let _ = tx.send(mono(data, channels, |v| v as f32 / 2_147_483_648.0));
                },
                err,
                None,
            )
        }
        cpal::SampleFormat::U16 => {
            let tx = tx.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    let _ = tx.send(mono(data, channels, |v| (v as f32 - 32768.0) / 32768.0));
                },
                err,
                None,
            )
        }
        _ => return Err("这个声音设备的格式不认识，换一个设备试试".into()),
    }
    .map_err(|e| {
        crate::logger::error(&format!("lecture audio input build: {e}"));
        fail.to_string()
    })?;
    stream.play().map_err(|e| {
        crate::logger::error(&format!("lecture audio play: {e}"));
        fail.to_string()
    })?;
    let input = Input {
        _stream: stream,
        #[cfg(target_os = "macos")]
        _tap: tap,
    };
    Ok((input, rx, rate))
}

/// Mac 上录不到电脑声音时的提示
#[allow(dead_code)]
pub const MAC_FAIL: &str = "没能录到电脑的声音。Mac 需要 macOS 14.2 以上，并在系统设置的\u{201c}隐私与安全性 → 录屏与系统录音\u{201d}里允许 ingwork 录制系统音频";

/// Mac 上没给权限时不报错、录到的全是 0：录了这么久还全是 0 就提示
#[allow(dead_code)]
pub const MAC_SILENT: &str = "录到的电脑声音一直是静音。请在系统设置的\u{201c}隐私与安全性 → 录屏与系统录音 → 仅系统录音\u{201d}里打开 ingwork，然后重新开始；如果电脑本来就没在放声音，可以不管";
