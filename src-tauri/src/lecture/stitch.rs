//! 把一段段听写拼成通顺的句子（纯文字处理，不联网）：
//! - 去重叠：硬切的段开头带着上一段最后约 1 秒，听写出来开头几个词会和上一段结尾重复，按词对齐后删掉
//! - 过滤听写幻觉：安静或嘈杂时听写偶尔凭空冒出 "Thank you." 之类，或者把上一句原样再写一遍
//! - 整句再翻：最后一个句号后面没说完的半句先留着，等下一段补完；8 秒没等到就直接放出去

/// 一句话最多等多久（毫秒）
const WAIT_MS: u64 = 8_000;
/// 没说完的半句超过这么多词也直接放出去，免得一大段都不翻
const MAX_WORDS: usize = 45;

/// 小写、去掉首尾标点
fn norm(word: &str) -> String {
    word.trim_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase()
}

/// 整句比较用：小写、只留字母数字和空格
fn norm_text(text: &str) -> String {
    text.split_whitespace()
        .map(norm)
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// 去掉 `new` 开头和 `prev` 结尾重复的词。`new` 的开头可能还多一两个被切坏的词，一起去掉
pub fn dedupe(prev: &str, new: &str) -> String {
    let p: Vec<String> = prev.split_whitespace().map(norm).collect();
    let words: Vec<&str> = new.split_whitespace().collect();
    let n: Vec<String> = words.iter().map(|w| norm(w)).collect();
    let longest = p.len().min(n.len()).min(15);
    for k in (1..=longest).rev() {
        let tail = &p[p.len() - k..];
        if tail.iter().all(|w| w.is_empty()) {
            continue;
        }
        // 只重复一个词的话，这个词得够长，"the" "a" 这种不算
        if k == 1 && tail[0].chars().count() < 5 {
            continue;
        }
        for start in 0..=2usize {
            if start + k > n.len() {
                break;
            }
            if n[start..start + k] == *tail {
                return words[start + k..].join(" ");
            }
        }
    }
    new.to_string()
}

/// 听写凭空冒出来的话
const NOISE: &[&str] = &[
    "thank you",
    "thank you very much",
    "thanks for watching",
    "thank you for watching",
    "thanks",
    "bye",
    "bye bye",
    "you",
    "uh",
    "um",
    "hmm",
    "mm",
    "please subscribe",
    "subtitles by the amaraorg community",
];

/// 是不是听写幻觉：空的、标点、上面那几句、和上一段一模一样的短句
pub fn is_noise(text: &str, prev: &str) -> bool {
    let t = norm_text(text);
    if t.is_empty() {
        return true;
    }
    if NOISE.contains(&t.as_str()) {
        return true;
    }
    t.split(' ').count() <= 8 && t == norm_text(prev)
}

const ABBREVIATIONS: &[&str] = &[
    "dr", "mr", "mrs", "ms", "prof", "eg", "ie", "etc", "vs", "fig", "eq", "no", "st", "approx",
];

/// 最后一个句子结尾在哪（字节位置，含那个标点）
fn last_sentence_end(text: &str) -> Option<usize> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    for i in (0..chars.len()).rev() {
        let (pos, c) = chars[i];
        if !matches!(c, '.' | '?' | '!') {
            continue;
        }
        // 后面得是结尾、空格，或者引号括号再接空格
        let mut j = i + 1;
        while j < chars.len() && matches!(chars[j].1, '"' | '\'' | ')' | '\u{201d}' | '\u{2019}') {
            j += 1;
        }
        if j < chars.len() && !chars[j].1.is_whitespace() {
            continue;
        }
        if c == '.' {
            // "Dr." "e.g." 这种不算句号
            let before: String = chars[..i]
                .iter()
                .rev()
                .take_while(|(_, ch)| !ch.is_whitespace())
                .map(|(_, ch)| *ch)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            if ABBREVIATIONS.contains(&norm(&before).replace('.', "").as_str()) {
                continue;
            }
        }
        let end = if j > i + 1 {
            chars[j - 1].0 + chars[j - 1].1.len_utf8()
        } else {
            pos + c.len_utf8()
        };
        return Some(end);
    }
    None
}

/// 把一大段拆成一句一句；太短的句子（比如 "Okay."）并到下一句里
pub fn split(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = text.trim();
    while !rest.is_empty() {
        // 找第一个句子结尾
        let end = (1..=rest.len())
            .filter(|&i| rest.is_char_boundary(i))
            .find(|&i| {
                last_sentence_end(&rest[..i]) == Some(i)
                    && (i == rest.len() || rest[i..].starts_with(char::is_whitespace))
            });
        let (one, next) = match end {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, ""),
        };
        match out.last_mut() {
            Some(last) if last.split_whitespace().count() < 6 => {
                last.push(' ');
                last.push_str(one.trim());
            }
            _ => out.push(one.trim().to_string()),
        }
        rest = next.trim_start();
    }
    out
}

/// 把听写一段段拼成整句
#[derive(Default)]
pub struct Assembler {
    pending: String,
    /// 没说完的那半句是什么时候开始说的
    pending_at: u64,
    /// 什么时候开始等的
    since: u64,
}

impl Assembler {
    /// 加一段听写（`at` 是这段开始的时刻）。凑成了整句就返回（开始时刻, 句子）
    pub fn push(&mut self, text: &str, at: u64, now: u64) -> Option<(u64, String)> {
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        if self.pending.is_empty() {
            self.pending_at = at;
            self.since = now;
            self.pending = text.to_string();
        } else {
            self.pending.push(' ');
            self.pending.push_str(text);
        }
        match last_sentence_end(&self.pending) {
            Some(end) => {
                let done = self.pending[..end].trim().to_string();
                let rest = self.pending[end..].trim().to_string();
                let started = self.pending_at;
                self.pending = rest;
                // 剩下的半句是这一段里说的
                self.pending_at = at;
                self.since = now;
                Some((started, done))
            }
            None if self.pending.split_whitespace().count() > MAX_WORDS => self.flush(),
            None => None,
        }
    }

    /// 等太久了
    pub fn stale(&self, now: u64) -> bool {
        !self.pending.is_empty() && now.saturating_sub(self.since) >= WAIT_MS
    }

    /// 不等了，没说完的也放出去
    pub fn flush(&mut self) -> Option<(u64, String)> {
        if self.pending.is_empty() {
            return None;
        }
        Some((self.pending_at, std::mem::take(&mut self.pending)))
    }

    /// 还在等的半句
    pub fn pending(&self) -> Option<(u64, String)> {
        (!self.pending.is_empty()).then(|| (self.pending_at, self.pending.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_overlap() {
        assert_eq!(
            dedupe(
                "we filter each projection with a ramp filter",
                "a ramp filter. That's filtered back projection."
            ),
            "That's filtered back projection."
        );
        // 开头多了一个切坏的词
        assert_eq!(
            dedupe(
                "the reconstruction is blurry",
                "ry. The reconstruction is blurry because"
            ),
            "because"
        );
        assert_eq!(dedupe("ramp filter,", "Filter. So now"), "So now");
        // 只重复一个短词不算
        assert_eq!(dedupe("look at the", "the image"), "the image");
        // 不重复就原样
        assert_eq!(dedupe("hello there", "General Kenobi"), "General Kenobi");
        assert_eq!(dedupe("", "Something"), "Something");
    }

    #[test]
    fn noise() {
        assert!(is_noise("Thank you.", "the projection"));
        assert!(is_noise("  ...  ", ""));
        assert!(is_noise("So the filter.", "so the filter"));
        assert!(!is_noise("Thank you for the question about Fourier.", ""));
        assert!(!is_noise(
            "The ramp filter boosts high frequencies.",
            "Thank you."
        ));
    }

    #[test]
    fn sentence_ends() {
        assert_eq!(last_sentence_end("Hello there. How are"), Some(12));
        assert_eq!(last_sentence_end("It is 3.5 mm wide"), None);
        assert_eq!(last_sentence_end("Ask Dr. Smith"), None);
        assert_eq!(last_sentence_end("For example, e.g. this"), None);
        assert_eq!(last_sentence_end("Really? Yes"), Some(7));
        assert_eq!(last_sentence_end("He said \"stop.\" Then"), Some(15));
        assert_eq!(last_sentence_end("All done."), Some(9));
    }

    #[test]
    fn assembles_sentences() {
        let mut a = Assembler::default();
        assert_eq!(
            a.push("So before back projecting, we filter", 1000, 1000),
            None
        );
        assert_eq!(
            a.push("each projection. That's filtered back", 5000, 5000),
            Some((
                1000,
                "So before back projecting, we filter each projection.".into()
            ))
        );
        assert_eq!(a.pending(), Some((5000, "That's filtered back".into())));
        assert!(!a.stale(12_000));
        assert!(a.stale(13_000));
        assert_eq!(a.flush(), Some((5000, "That's filtered back".into())));
        assert_eq!(a.pending(), None);
        assert_eq!(
            a.push("Done.", 20_000, 20_000),
            Some((20_000, "Done.".into()))
        );
        assert_eq!(a.pending(), None);
    }

    #[test]
    fn splits_sentences() {
        assert_eq!(
            split("Okay. So today we look at CT. The scanner rotates around the patient! Dr. Smith built it."),
            vec![
                "Okay. So today we look at CT.",
                "The scanner rotates around the patient!",
                "Dr. Smith built it.",
            ]
        );
        assert_eq!(split("no ending here"), vec!["no ending here"]);
        assert!(split("   ").is_empty());
    }

    #[test]
    fn long_run_on_is_released() {
        let mut a = Assembler::default();
        let long = "word ".repeat(50);
        assert!(a.push(&long, 0, 0).is_some());
        assert_eq!(a.pending(), None);
    }
}
