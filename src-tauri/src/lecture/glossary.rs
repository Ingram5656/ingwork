//! 这门课的术语表：来自课件、这门课以前笔记里的术语、生词本。
//!
//! - 听写回来先在本地按拼写把听错的专业词改成术语表里的写法（不联网）：
//!   "Shep Logan" → "Shepp-Logan"、"photo grammetry" → "photogrammetry"、"fbp" → "FBP"
//! - 翻译和整理笔记时把术语表放在提示词最前面：译法统一，而且每次都一样的开头能吃到 DeepSeek 的缓存，几乎不花钱

use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct GTerm {
    pub en: String,
    /// 中文译法，可能没有（生词本里的词）
    pub zh: String,
}

/// 小写，只留字母和数字
fn squash(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 两个词差几个字（相邻两个字换位算一处）
fn distance(a: &[char], b: &[char]) -> usize {
    let (n, m) = (a.len(), b.len());
    let mut d = vec![vec![0usize; m + 1]; n + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for j in 0..=m {
        d[0][j] = j;
    }
    for i in 1..=n {
        for j in 1..=m {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1)
                .min(d[i][j - 1] + 1)
                .min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
            }
        }
    }
    d[n][m]
}

struct Entry {
    display: String,
    squashed: Vec<char>,
    words: usize,
}

#[derive(Default)]
pub struct Glossary {
    pub terms: Vec<GTerm>,
    /// 课件的提纲
    pub outline: Vec<String>,
    entries: Vec<Entry>,
}

impl Glossary {
    pub fn new(mut terms: Vec<GTerm>, outline: Vec<String>) -> Self {
        // 同一个词只留一条，有中文的优先；按字母排，每次拼出来的提示词都一样（缓存才命中）
        terms.retain(|t| !squash(&t.en).is_empty());
        terms.sort_by(|a, b| {
            squash(&a.en)
                .cmp(&squash(&b.en))
                .then(b.zh.is_empty().cmp(&a.zh.is_empty()).reverse())
        });
        terms.dedup_by(|b, a| {
            if squash(&a.en) == squash(&b.en) {
                if a.zh.is_empty() {
                    a.zh = std::mem::take(&mut b.zh);
                }
                true
            } else {
                false
            }
        });
        terms.truncate(300);
        let mut entries: Vec<Entry> = terms
            .iter()
            .map(|t| Entry {
                display: t.en.trim().to_string(),
                squashed: squash(&t.en).chars().collect(),
                words: t.en.split_whitespace().count().max(1),
            })
            .collect();
        // 长的先配，免得短词抢先改了长词的一部分
        entries.sort_by(|a, b| b.squashed.len().cmp(&a.squashed.len()));
        Self {
            terms,
            outline,
            entries,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.terms.is_empty() && self.outline.is_empty()
    }

    /// 放进提示词的那一块（没有就是空字符串）
    pub fn prompt_block(&self) -> String {
        let mut out = String::new();
        let with_zh: Vec<&GTerm> = self.terms.iter().filter(|t| !t.zh.is_empty()).collect();
        let plain: Vec<&GTerm> = self.terms.iter().filter(|t| t.zh.is_empty()).collect();
        if !with_zh.is_empty() {
            out.push_str("\n\n这门课的术语和译法（英文 = 中文），翻译和整理时统一用这些：\n");
            for t in with_zh {
                out.push_str(&format!("{} = {}\n", t.en.trim(), t.zh.trim()));
            }
        }
        if !plain.is_empty() {
            out.push_str("\n这门课还会出现这些词（拼写以这里为准）：");
            let words: Vec<&str> = plain.iter().map(|t| t.en.trim()).collect();
            out.push_str(&words.join(", "));
            out.push('\n');
        }
        if !self.outline.is_empty() {
            out.push_str("\n课件的提纲：\n");
            for line in &self.outline {
                out.push_str(&format!("- {}\n", line.trim()));
            }
        }
        out
    }

    /// 把听写里拼错的专业词改成术语表里的写法
    pub fn correct(&self, text: &str) -> String {
        if self.entries.is_empty() {
            return text.to_string();
        }
        let words: Vec<&str> = text.split_whitespace().collect();
        let mut out: Vec<Option<String>> = words.iter().map(|w| Some(w.to_string())).collect();
        let mut used = vec![false; words.len()];
        for entry in &self.entries {
            let len = entry.squashed.len();
            // 太短的词只修大小写（"fbp" → "FBP"），不猜拼写，免得把普通词改错
            let fuzzy = len >= 6;
            let allowed = if len >= 12 { 2 } else { 1 };
            let lo = entry.words.saturating_sub(1).max(1);
            let hi = entry.words + 1;
            for span in (lo..=hi).rev() {
                let mut i = 0;
                while i + span <= words.len() {
                    if used[i..i + span].iter().any(|&u| u) {
                        i += 1;
                        continue;
                    }
                    let joined: String = words[i..i + span].iter().map(|w| squash(w)).collect();
                    let cand: Vec<char> = joined.chars().collect();
                    let same = cand == entry.squashed;
                    let close = fuzzy
                        && !same
                        && cand.first() == entry.squashed.first()
                        && cand.len().abs_diff(len) <= allowed
                        && distance(&cand, &entry.squashed) <= allowed;
                    let original = words[i..i + span].join(" ");
                    let differs = trim_punct(&original) != entry.display;
                    // 字母一样：词被拆开或连在一起了（"photo grammetry"），或者大小写不对（"fbp"）
                    let regroup = same
                        && differs
                        && (span != entry.words || same_case_matters(&entry.display));
                    if regroup || close {
                        let (pre, _) = split_punct(words[i]);
                        let (_, post) = split_punct(words[i + span - 1]);
                        out[i] = Some(format!("{pre}{}{post}", entry.display));
                        for slot in out.iter_mut().skip(i + 1).take(span - 1) {
                            *slot = None;
                        }
                        used[i..i + span].iter_mut().for_each(|u| *u = true);
                        i += span;
                    } else {
                        if same {
                            // 本来就对：占住，别让短词再动它
                            used[i..i + span].iter_mut().for_each(|u| *u = true);
                        }
                        i += 1;
                    }
                }
            }
        }
        out.into_iter().flatten().collect::<Vec<_>>().join(" ")
    }
}

/// 只改大小写的情况：缩写（FBP）、带大写的名字（Shepp-Logan），或者一个大写开头的单词（Fourier、Hann）。
/// "Back projection" 这种只是首字母大写的词组不改，免得句子中间冒出大写
fn same_case_matters(display: &str) -> bool {
    let upper = display.chars().filter(|c| c.is_uppercase()).count();
    let single = display.split_whitespace().count() == 1;
    upper >= 2 || (single && display.chars().next().is_some_and(|c| c.is_uppercase()))
}

fn trim_punct(word: &str) -> &str {
    word.trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '\'')
}

/// 词前后的标点
fn split_punct(word: &str) -> (&str, &str) {
    let start = word
        .char_indices()
        .find(|(_, c)| c.is_alphanumeric())
        .map(|(i, _)| i)
        .unwrap_or(word.len());
    let end = word
        .char_indices()
        .rev()
        .find(|(_, c)| c.is_alphanumeric())
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(start);
    (&word[..start], &word[end.max(start)..])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(terms: &[(&str, &str)]) -> Glossary {
        Glossary::new(
            terms
                .iter()
                .map(|(en, zh)| GTerm {
                    en: en.to_string(),
                    zh: zh.to_string(),
                })
                .collect(),
            vec![],
        )
    }

    #[test]
    fn fixes_spelling() {
        let gl = g(&[
            ("Shepp-Logan", "Shepp-Logan 滤波器"),
            ("photogrammetry", "摄影测量"),
            ("FBP", "滤波反投影"),
            ("sinogram", "正弦图"),
        ]);
        assert_eq!(
            gl.correct("We use a Shep Logan window, then fbp."),
            "We use a Shepp-Logan window, then FBP."
        );
        assert_eq!(
            gl.correct("This is photo grammetry, and here's the sinagram."),
            "This is photogrammetry, and here's the sinogram."
        );
        // 本来就对的不动
        assert_eq!(
            gl.correct("The sinogram looks fine."),
            "The sinogram looks fine."
        );
    }

    #[test]
    fn leaves_common_words_alone() {
        let gl = g(&[
            ("Hann", "汉宁窗"),
            ("ramp filter", "斜坡滤波器"),
            ("Fourier", "傅里叶"),
        ]);
        // 太短的不猜拼写
        assert_eq!(gl.correct("Han dynasty"), "Han dynasty");
        // 差太多不改
        assert_eq!(gl.correct("for four years"), "for four years");
        assert_eq!(gl.correct("a ramp filter"), "a ramp filter");
        assert_eq!(gl.correct("a hann window"), "a Hann window");
        let gl = g(&[("Back projection", "反投影")]);
        assert_eq!(gl.correct("then back projection"), "then back projection");
    }

    #[test]
    fn dedupes_and_sorts() {
        let gl = g(&[
            ("Sinogram", ""),
            ("sinogram", "正弦图"),
            ("Back projection", "反投影"),
        ]);
        assert_eq!(gl.terms.len(), 2);
        assert_eq!(gl.terms[1].zh, "正弦图");
        let block = gl.prompt_block();
        assert!(block.contains("Back projection = 反投影"));
        assert!(block.find("Back").unwrap() < block.find("正弦图").unwrap());
    }

    #[test]
    fn distances() {
        let d = |a: &str, b: &str| {
            distance(
                &a.chars().collect::<Vec<_>>(),
                &b.chars().collect::<Vec<_>>(),
            )
        };
        assert_eq!(d("sinogram", "sinagram"), 1);
        assert_eq!(d("ab", "ba"), 1);
        assert_eq!(d("", "abc"), 3);
    }
}
