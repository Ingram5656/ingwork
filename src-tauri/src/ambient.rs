//! 环境音的设置，以及"现在该响哪些"的判断。真正放声音在 sound.rs。

use serde::Deserialize;

/// 界面发过来的环境音设置。
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AmbientConfig {
    /// 专注时播放环境音
    pub on: bool,
    /// 休息时也播放
    pub in_breaks: bool,
    /// 正在设置里试听：不管计时走没走都响
    pub preview: bool,
    /// 选了哪些声音，各自多大声
    pub mix: Vec<AmbientLevel>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct AmbientLevel {
    pub id: String,
    pub volume: f32,
}

impl AmbientConfig {
    /// 现在该响哪些环境音、各自多大声。
    /// 规则：开着，计时在走，而且是专注（或设了休息时也放）才响；试听时不管这些。
    pub fn wanted(&self, running: bool, focus: bool) -> Vec<(String, f32)> {
        let audible = self.preview || (self.on && running && (focus || self.in_breaks));
        if !audible {
            return Vec::new();
        }
        self.mix
            .iter()
            .filter(|level| level.volume > 0.0)
            .map(|level| (level.id.clone(), level.volume.clamp(0.0, 1.0)))
            .collect()
    }
}
