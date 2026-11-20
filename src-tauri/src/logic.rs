//! 不依赖 Tauri 和任何第三方库的纯逻辑：小窗的尺寸和位置、语言判断、按条目合并两份清单。
//! 单独放一个文件，方便直接用 `rustc --edition 2021 --test src/logic.rs` 跑测试。
//! 小窗和语言这部分来自 ingtranslate 的 logic.rs，规则没变，只是把宽度改成了参数（翻译和杂念箱宽度不一样）。

use std::collections::BTreeMap;

// ---------- 小窗（翻译、杂念箱）的尺寸和位置 ----------

/// 面板上下的留白（20 + 44），投影要用
pub const GUTTER_V: f64 = 64.0;
/// 窗口离屏幕边缘至少留这么多
pub const SCREEN_MARGIN: f64 = 8.0;
/// 给任务栏留的高度（拿不到准确的工作区时用）
pub const TASKBAR: f64 = 48.0;
pub const SCALE_MIN: f64 = 0.7;
pub const SCALE_MAX: f64 = 1.6;

/// 界面缩放限制在 70%~160%，保留两位小数
pub fn clamp_scale(v: f64) -> f64 {
    if !v.is_finite() {
        return 1.0;
    }
    (v.clamp(SCALE_MIN, SCALE_MAX) * 100.0).round() / 100.0
}

/// 一块屏幕：位置和大小是物理像素，sf 是系统缩放（125% 就是 1.25）
#[derive(Clone, Copy, Debug)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub sf: f64,
}

impl Area {
    /// 去掉任务栏后能用的高度（物理像素）
    pub fn usable_h(&self) -> f64 {
        self.h - TASKBAR * self.sf
    }
}

/// 按当前缩放算出的窗口大小（物理像素）和面板最多能有多高（未缩放的 CSS 像素）
#[derive(Clone, Copy, Debug)]
pub struct Layout {
    pub width: f64,
    pub height: f64,
    pub max_panel: f64,
}

/// `page_w`、`page_h` 是页面自己量出来的窗口大小，已经是物理像素（页面按自己实际的
/// devicePixelRatio 换算过）；`dpr` 就是那个值，`zoom` 是界面缩放。
/// 不用屏幕的缩放来换算：窗口从一块屏幕挪到缩放不同的另一块时，WebView 有时还按原来的缩放在画，
/// 按屏幕算出来的窗口就会比页面小，面板被裁掉一截。页面自己量的才准
pub fn layout(page_w: f64, page_h: f64, zoom: f64, dpr: f64, area: &Area) -> Layout {
    let max_h = area.usable_h() - SCREEN_MARGIN * 2.0 * area.sf;
    Layout {
        width: page_w.round(),
        height: page_h.min(max_h).round(),
        max_panel: (max_h / dpr / zoom).floor() - GUTTER_V,
    }
}

/// 呼出时窗口左上角的位置：水平居中，顶边在屏幕 20% 处；太高放不下就往上挪
pub fn summon_position(l: &Layout, area: &Area) -> (f64, f64) {
    let margin = SCREEN_MARGIN * area.sf;
    let x = area.x + (area.w - l.width) / 2.0;
    let lowest = area.y + area.usable_h() - margin - l.height;
    let y = (area.y + area.usable_h() * 0.2)
        .min(lowest)
        .max(area.y + margin);
    (x.round(), y.round())
}

// ---------- 语言 ----------

/// 粗略判断原文语言：有假名是日语，有谚文是韩语，有汉字是中文，其余当英语
pub fn guess_source(text: &str) -> &'static str {
    let has = |lo: u32, hi: u32| text.chars().any(|c| (lo..=hi).contains(&(c as u32)));
    if has(0x3040, 0x30ff) {
        "ja"
    } else if has(0xac00, 0xd7af) {
        "ko"
    } else if has(0x4e00, 0x9fff) {
        "zh-CN"
    } else {
        "en"
    }
}

/// 智能模式：中文译成英语，其他语言都译成中文
pub fn smart_target(text: &str) -> &'static str {
    if guess_source(text) == "zh-CN" {
        "en"
    } else {
        "zh-CN"
    }
}

/// 给大模型看的语言名
pub fn lang_name(code: &str) -> &str {
    match code {
        "zh-CN" => "Simplified Chinese",
        "en" => "English",
        "ja" => "Japanese",
        "ko" => "Korean",
        "fr" => "French",
        "de" => "German",
        "es" => "Spanish",
        "ru" => "Russian",
        other => other,
    }
}

// ---------- 按条目合并 ----------
//
// 数据文件夹在网盘里、几台电脑共用时，同一份清单两边都改过，要合成一份：
// - 同一个 id 两边都有：用修改时刻晚的；一样晚就比内容（`fingerprint`），保证两边算出来一样
// - 只有一边有：留下
// - 删除记号比条目最后一次修改还晚：算删掉了
// 合并结果和两边的先后无关，几台电脑反复读写最后会停在同一份内容上。

/// 能按条目合并的东西
pub trait Entry: Clone {
    fn id(&self) -> &str;
    fn updated_at(&self) -> u64;
    /// 内容的一个指纹，两份修改时刻一样时用它定输赢
    fn fingerprint(&self) -> String;
}

/// 合并两份清单。`removed` 是删除记号（id → 删除时刻）。结果按 id 排好，调用的地方再按需要排序
pub fn merge_entries<T: Entry>(a: &[T], b: &[T], removed: &BTreeMap<String, u64>) -> Vec<T> {
    let mut by_id: BTreeMap<String, T> = BTreeMap::new();
    for item in a.iter().chain(b.iter()) {
        let keep = match by_id.get(item.id()) {
            None => true,
            Some(old) => {
                (item.updated_at(), item.fingerprint()) > (old.updated_at(), old.fingerprint())
            }
        };
        if keep {
            by_id.insert(item.id().to_string(), item.clone());
        }
    }
    by_id
        .into_values()
        .filter(|item| {
            removed
                .get(item.id())
                .map_or(true, |at| *at < item.updated_at())
        })
        .collect()
}

/// 合并两边的删除记号：同一个 id 留较晚的；太旧的（`now - keep_ms` 之前）丢掉
pub fn merge_removed(
    a: &BTreeMap<String, u64>,
    b: &BTreeMap<String, u64>,
    now: u64,
    keep_ms: u64,
) -> BTreeMap<String, u64> {
    let mut out = a.clone();
    for (id, at) in b {
        let slot = out.entry(id.clone()).or_insert(*at);
        if *at > *slot {
            *slot = *at;
        }
    }
    out.retain(|_, at| now.saturating_sub(*at) <= keep_ms);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_is_clamped_and_rounded() {
        assert_eq!(clamp_scale(1.0), 1.0);
        assert_eq!(clamp_scale(0.2), 0.7);
        assert_eq!(clamp_scale(9.0), 1.6);
        assert_eq!(clamp_scale(1.2349), 1.23);
        assert_eq!(clamp_scale(f64::NAN), 1.0);
    }

    #[test]
    fn languages_are_guessed() {
        assert_eq!(guess_source("hello"), "en");
        assert_eq!(guess_source("你好"), "zh-CN");
        assert_eq!(guess_source("こんにちは世界"), "ja");
        assert_eq!(guess_source("안녕하세요"), "ko");
        assert_eq!(smart_target("你好"), "en");
        assert_eq!(smart_target("bonjour"), "zh-CN");
    }

    #[test]
    fn translate_window_matches_ingtranslate() {
        // ingtranslate 的面板 680 宽，加上左右留白是 728；1920×1080 的屏幕，系统缩放 125%
        let area = Area {
            x: 0.0,
            y: 0.0,
            w: 1920.0,
            h: 1080.0,
            sf: 1.25,
        };
        let l = layout(910.0, 293.0 * 1.25, 1.0, 1.25, &area);
        assert_eq!(l.width, 910.0);
        assert_eq!(l.height, 366.0);
        assert_eq!(l.max_panel, 736.0);

        let big = layout(1456.0, 293.0 * 1.6 * 1.25, 1.6, 1.25, &area);
        assert_eq!(big.width, 1456.0);
        assert_eq!(big.max_panel, 436.0);

        let tall = layout(910.0, 5000.0, 1.0, 1.25, &area);
        assert_eq!(tall.height, 1000.0);

        let (x, y) = summon_position(&l, &area);
        assert_eq!(x, 505.0);
        assert_eq!(y, 204.0);
        let (_, y_tall) = summon_position(&tall, &area);
        assert_eq!(y_tall, 10.0);

        // 页面量出来多大就是多大，不按屏幕的缩放再换算一遍
        let stale = layout(728.0, 293.0, 1.0, 1.0, &area);
        assert_eq!(stale.width, 728.0);
        assert_eq!(stale.height, 293.0);
        assert_eq!(stale.max_panel, 936.0);
    }

    #[test]
    fn capture_window_is_narrower() {
        let area = Area {
            x: 1920.0,
            y: 0.0,
            w: 2560.0,
            h: 1440.0,
            sf: 1.0,
        };
        let l = layout(608.0, 160.0, 1.0, 1.0, &area);
        assert_eq!(l.width, 608.0);
        let (x, _) = summon_position(&l, &area);
        assert_eq!(x, 1920.0 + 976.0);
    }

    #[derive(Clone, Debug, PartialEq)]
    struct Item {
        id: &'static str,
        at: u64,
        text: &'static str,
    }

    impl Entry for Item {
        fn id(&self) -> &str {
            self.id
        }
        fn updated_at(&self) -> u64 {
            self.at
        }
        fn fingerprint(&self) -> String {
            self.text.to_string()
        }
    }

    fn item(id: &'static str, at: u64, text: &'static str) -> Item {
        Item { id, at, text }
    }

    #[test]
    fn newer_edit_wins_and_order_does_not_matter() {
        let a = vec![item("x", 5, "old"), item("y", 1, "only a")];
        let b = vec![item("x", 9, "new"), item("z", 2, "only b")];
        let none = BTreeMap::new();
        let ab = merge_entries(&a, &b, &none);
        let ba = merge_entries(&b, &a, &none);
        assert_eq!(ab, ba);
        assert_eq!(
            ab,
            vec![
                item("x", 9, "new"),
                item("y", 1, "only a"),
                item("z", 2, "only b")
            ]
        );
    }

    #[test]
    fn same_time_is_decided_by_content() {
        let a = vec![item("x", 5, "apple")];
        let b = vec![item("x", 5, "banana")];
        let none = BTreeMap::new();
        assert_eq!(merge_entries(&a, &b, &none), merge_entries(&b, &a, &none));
    }

    #[test]
    fn removal_sticks_unless_edited_later() {
        let a = vec![item("x", 5, "x"), item("y", 8, "edited after removal")];
        let mut removed = BTreeMap::new();
        removed.insert("x".to_string(), 6);
        removed.insert("y".to_string(), 7);
        let out = merge_entries(&a, &[], &removed);
        assert_eq!(out, vec![item("y", 8, "edited after removal")]);
    }

    #[test]
    fn old_removal_marks_expire() {
        let mut a = BTreeMap::new();
        a.insert("old".to_string(), 1);
        a.insert("x".to_string(), 50);
        let mut b = BTreeMap::new();
        b.insert("x".to_string(), 90);
        let out = merge_removed(&a, &b, 100, 60);
        assert_eq!(out.len(), 1);
        assert_eq!(out.get("x"), Some(&90));
    }
}
