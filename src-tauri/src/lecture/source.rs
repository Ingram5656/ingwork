//! 听课的声音从哪来：麦克风，或者电脑正在播放的声音（网课、Teams、课程回放）。
//!
//! 用 cpal 0.17：在"输出设备"上开输入流就是录它正在放的声音——Windows 用 WASAPI 的回环录音，
//! Mac 用系统的音频录制（macOS 14.6 以上，第一次会问要不要允许）。
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

/// 打开声音来源：返回流（得一直拿着，丢了就停）、单声道样本从哪儿来、采样率
pub fn open(source: Source) -> Result<(cpal::Stream, Receiver<Vec<f32>>, u32), String> {
    let host = cpal::default_host();
    let (device, config, fail) = match source {
        Source::Mic => {
            let fail = "麦克风打不开，请检查系统设置里是否允许 ingwork 使用麦克风";
            let device = host.default_input_device().ok_or_else(|| {
                "没找到麦克风，请检查有没有插好、系统设置里有没有关掉".to_string()
            })?;
            let config = device
                .default_input_config()
                .map_err(|_| fail.to_string())?;
            (device, config, fail)
        }
        Source::System => {
            let fail = if cfg!(target_os = "macos") {
                "没能录到电脑的声音。Mac 需要 macOS 14.6 以上，并在系统设置的\u{201c}隐私与安全性\u{201d}里允许 ingwork 录制音频"
            } else {
                "没能录到电脑的声音，请检查有没有在放声音的设备"
            };
            let device = host
                .default_output_device()
                .ok_or_else(|| "没找到正在放声音的设备".to_string())?;
            let config = device
                .default_output_config()
                .map_err(|_| fail.to_string())?;
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
    stream.play().map_err(|_| fail.to_string())?;
    Ok((stream, rx, rate))
}
