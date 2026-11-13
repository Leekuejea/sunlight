//! Translation harness: prompts, the `<|i|>` marker protocol and the layout length budget.
//!
//! Every translated sentence is typeset back into the box its source sentence occupied on the PDF
//! page, so length is constrained as tightly as accuracy.

use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

#[derive(Serialize, Clone)]
pub struct Message {
    pub role: &'static str,
    pub content: String,
}

fn msg(role: &'static str, content: impl Into<String>) -> Message {
    Message { role, content: content.into() }
}

fn language_name(target: &str) -> &str {
    match target {
        "ko" => "Korean",
        "en" => "English",
        other => other,
    }
}

// Moonlight's own Korean output (which fits its layout) runs at 0.61x the English character count
// at the median and 0.74x at p90; English from Korean is the inverse. Budgets sit near that p75.
fn length_ratio(target: &str) -> f64 {
    match target {
        "ko" => 0.7,
        "en" => 1.6,
        _ => 1.0,
    }
}
const OVER_BUDGET: f64 = 1.25; // beyond this a segment is sent back once to be condensed
const UNDER_BUDGET: f64 = 0.35; // below this content was likely dropped: keep the source
const MIN_BUDGET: usize = 12;

static MATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$\$?([^$]+)\$\$?").unwrap());
static COMMAND: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\[a-zA-Z]+").unwrap());
static MARKUP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[{}^_\\\s]").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
/// Models sometimes write "<|4>", "<|4|" or a bare "<|4" for "<|4|>": all of them start segment 4.
static MARKER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<\|#?(\d+)(\|>|>|\|)?").unwrap());
static THINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<think>.*?</think>").unwrap());
static NOISE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<\|(?:end|stopped)\|>|<\|#?\d+\|?>?|```\w*").unwrap());
static LIMITS_ECHO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)\n\s*Character limits:.*$").unwrap());

/// Rendered width of math is far below its LaTeX source length.
pub fn visible_length(text: &str) -> usize {
    MATH.replace_all(text, |c: &regex::Captures| MARKUP.replace_all(&COMMAND.replace_all(&c[1], "x"), "").into_owned())
        .chars()
        .count()
}

pub fn budget_for(source: &str, target: &str) -> usize {
    MIN_BUDGET.max((source.chars().count() as f64 * length_ratio(target)).ceil() as usize)
}

static CONTACT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\w.+}-]@[\w-]+\.[\w.-]+|https?://").unwrap());

/// Author/affiliation blocks and link lines are never sent to the model: small models tend to
/// drop the e-mail addresses, and nothing in them should be translated anyway.
pub fn keep_verbatim(source: &str) -> bool {
    CONTACT.is_match(source) && source.split_whitespace().count() <= 40
}

pub enum Fit {
    Keep,
    /// Far under budget: the model dropped content (e.g. an author block reduced to names).
    UseSource,
    /// Far over budget: ask once for a shorter version of at most this many characters.
    Condense(usize),
}

pub fn check_fit(source: &str, translation: &str, target: &str) -> Fit {
    if translation == source {
        return Fit::Keep;
    }
    let budget = budget_for(source, target) as f64;
    let len = visible_length(translation) as f64;
    if source.chars().count() > 40 && len < budget * UNDER_BUDGET {
        Fit::UseSource
    } else if len > budget * OVER_BUDGET {
        Fit::Condense(budget as usize)
    } else {
        Fit::Keep
    }
}

fn system_prompt(target: &str) -> String {
    let lang = language_name(target);
    let ko = target == "ko";
    [
        format!("You translate research papers (academic PDF pages) into {lang} for a reader who reads the translation in place of the original."),
        "Each translated segment is typeset back into the exact box the source sentence occupied on the PDF page, at a similar font size. Text that is longer than the box becomes unreadably small, so length matters as much as accuracy.".into(),
        String::new(),
        "Input: the segments of one page, each starting with a marker such as <|0|>, followed by a list of character limits.".into(),
        "Output: for EVERY input segment, in the same order, one line made of its marker followed by the translation, e.g. <|0|>translated text".into(),
        String::new(),
        "Rules:".into(),
        "- Output only marker lines. No explanations, notes, headings or code fences.".into(),
        "- Exactly one output segment per input segment. Never merge, split, skip or reorder segments; a segment may be a sentence fragment cut at a page or column break, so translate the fragment as it is.".into(),
        "- Stay within each segment's character limit (LaTeX counts as its rendered length). Translate faithfully but concisely: no added explanations, no repeated subjects, no filler.".into(),
        format!("- Use the formal register of academic writing{}.", if ko { " (합니다체), with established Korean terminology" } else { "" }),
        format!(
            "- Keep well-known technical terms, method and model names, datasets and acronyms in their original form when that is how researchers write them{}.",
            if ko { " (e.g. flow-matching, CS-Pi, Transformer); at most once per page you may gloss a term as 번역어(original term)" } else { "" }
        ),
        r"- Write mathematical symbols and expressions as inline LaTeX between $ signs, e.g. πθ -> $\pi_\theta$, a₀ ∼ N(0, I) -> $a_0 \sim \mathcal{N}(0, I)$.".into(),
        "- Keep citation markers ([1, 2], [3–5]), references such as Fig. 2, Table 1, Sec. 4.4, Eq. (3), numbers with units, URLs, e-mail addresses and code exactly as written.".into(),
        "- Never transliterate person names, institutions or venues.".into(),
        format!("- Copy a segment verbatim when it needs no translation: author lists, affiliations, venue or copyright lines, bibliography entries, code, or text already in {lang}."),
    ]
    .join("\n")
}

pub fn build_messages(texts: &[&str], target: &str) -> Vec<Message> {
    let segments: Vec<String> = texts.iter().enumerate().map(|(i, t)| format!("<|{i}|>{}", SPACES.replace_all(t, " "))).collect();
    let limits: Vec<String> = texts.iter().enumerate().map(|(i, t)| format!("{i}:{}", budget_for(t, target))).collect();
    // One worked example anchors the format and the verbatim rules (helps small local models most).
    let (example_in, example_out) = if target == "ko" {
        (
            "<|0|>Jane Doe† John Smith MIT CSAIL {jdoe}@mit.edu\n<|1|>We propose FlowNet, a diffusion policy πθ that improves sampling efficiency [3, 4] (Fig. 2).\n\nCharacter limits: 0:41, 1:72",
            "<|0|>Jane Doe† John Smith MIT CSAIL {jdoe}@mit.edu\n<|1|>우리는 샘플링 효율을 높이는 확산 정책 $\\pi_\\theta$인 FlowNet을 제안합니다 [3, 4] (Fig. 2).",
        )
    } else {
        (
            "<|0|>홍길동, 김철수 서울대학교 {hong}@snu.ac.kr\n<|1|>우리는 샘플링 효율을 높이는 확산 정책 πθ인 FlowNet을 제안한다 [3, 4] (그림 2).\n\nCharacter limits: 0:30, 1:88",
            "<|0|>홍길동, 김철수 서울대학교 {hong}@snu.ac.kr\n<|1|>We propose FlowNet, a diffusion policy $\\pi_\\theta$ that improves sampling efficiency [3, 4] (Fig. 2).",
        )
    };
    vec![
        msg("system", system_prompt(target)),
        msg("user", example_in),
        msg("assistant", example_out),
        msg("user", format!("{}\n\nCharacter limits: {}", segments.join("\n"), limits.join(", "))),
    ]
}

pub fn condense_messages(text: &str, budget: usize, target: &str) -> Vec<Message> {
    vec![
        msg(
            "system",
            format!(
                "You shorten one translated sentence from a research paper ({}) so it fits its box on the page. Keep the meaning, terminology, LaTeX math, citations and references. Reply with the shortened sentence only.",
                language_name(target)
            ),
        ),
        msg("user", format!("At most {budget} characters:\n{text}")),
    ]
}

pub fn clean_segment(text: &str) -> String {
    let text = THINK.replace_all(text, "");
    let text = NOISE.replace_all(&text, "");
    LIMITS_ECHO.replace(&text, "").trim().to_string()
}

/// Incremental parser for "<|i|>translation" output. A segment is complete once the next marker
/// shows up; segments are released strictly in index order.
pub struct SegmentParser {
    buffer: String,
    found: Vec<Option<String>>,
    next: usize,
}

/// `text` is `None` when the model skipped or emptied the segment (the caller keeps the source).
pub struct Segment {
    pub index: usize,
    pub text: Option<String>,
}

impl SegmentParser {
    pub fn new(count: usize) -> Self {
        Self { buffer: String::new(), found: vec![None; count], next: 0 }
    }

    fn collect(&mut self, is_final: bool) -> Option<usize> {
        let len = self.buffer.len();
        let markers: Vec<(usize, usize, usize)> = MARKER
            .captures_iter(&self.buffer)
            // "<|1" at the end of a partial buffer may still grow into "<|12|>": wait for more text.
            .filter(|c| is_final || c.get(2).is_some_and(|m| m.as_str() == "|>") || c.get(0).is_some_and(|m| m.end() < len))
            .filter_map(|c| Some((c.get(0)?.start(), c.get(0)?.end(), c[1].parse().ok()?)))
            .collect();
        for (k, &(_, end, index)) in markers.iter().enumerate() {
            let after = markers.get(k + 1).map(|m| m.0);
            if (after.is_none() && !is_final) || index >= self.found.len() || self.found[index].is_some() {
                continue;
            }
            let text = clean_segment(&self.buffer[end..after.unwrap_or(self.buffer.len())]);
            if !text.is_empty() {
                self.found[index] = Some(text);
            }
        }
        markers.iter().map(|m| m.2).max()
    }

    /// Feeds a chunk; returns the segments that became final.
    pub fn push(&mut self, chunk: &str) -> Vec<Segment> {
        self.buffer.push_str(chunk);
        let highest = self.collect(false);
        let mut out = Vec::new();
        while self.next < self.found.len() && (self.found[self.next].is_some() || highest.is_some_and(|h| h > self.next)) {
            out.push(Segment { index: self.next, text: self.found[self.next].take() });
            self.next += 1;
        }
        out
    }

    /// End of stream: releases everything left.
    pub fn finish(&mut self) -> Vec<Segment> {
        self.collect(true);
        let out = (self.next..self.found.len()).map(|i| Segment { index: i, text: self.found[i].take() }).collect();
        self.next = self.found.len();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(segments: Vec<Segment>) -> Vec<(usize, Option<String>)> {
        segments.into_iter().map(|s| (s.index, s.text)).collect()
    }

    #[test]
    fn segments_release_in_order_when_the_next_marker_arrives() {
        let mut p = SegmentParser::new(3);
        assert_eq!(texts(p.push("```\n<|0|>가.\n<|1")), vec![]);
        assert_eq!(texts(p.push("|>나.\n<|2|>다.<|end|>\n```")), vec![(0, Some("가.".into())), (1, Some("나.".into()))]);
        assert_eq!(texts(p.finish()), vec![(2, Some("다.".into()))]);
    }

    #[test]
    fn skipped_and_empty_segments_are_reported_as_missing() {
        let mut p = SegmentParser::new(3);
        let mut all = texts(p.push("<|0|>가.\n<|2|>다.\n<|1|>\n"));
        all.extend(texts(p.finish()));
        assert_eq!(all, vec![(0, Some("가.".into())), (1, None), (2, Some("다.".into()))]);
    }

    #[test]
    fn a_truncated_reply_still_yields_every_index() {
        let mut p = SegmentParser::new(2);
        let mut all = texts(p.push("<|0|>가."));
        all.extend(texts(p.finish()));
        assert_eq!(all, vec![(0, Some("가.".into())), (1, None)]);
    }

    #[test]
    fn length_budget_flags_only_far_off_translations() {
        let source = "A".repeat(100);
        assert_eq!(budget_for(&source, "ko"), 70);
        assert!(matches!(check_fit(&source, &"가".repeat(80), "ko"), Fit::Keep)); // 80 <= 70 * 1.25
        assert!(matches!(check_fit(&source, &"나".repeat(120), "ko"), Fit::Condense(70)));
        assert!(matches!(check_fit(&source, &"다".repeat(20), "ko"), Fit::UseSource)); // 20 < 70 * 0.35
        assert!(matches!(check_fit(&source, &source, "ko"), Fit::Keep)); // verbatim copy
        assert_eq!(visible_length(r"정책 $\pi_\theta$"), "정책 xx".chars().count()); // LaTeX counts as rendered width
    }

    #[test]
    fn author_blocks_stay_verbatim() {
        assert!(keep_verbatim("Jane Doe† Robotics Institute, CMU {jdoe, okroemer}@andrew.cmu.edu †Equal advising"));
        assert!(keep_verbatim("Code: https://github.com/x/y"));
        assert!(!keep_verbatim("We propose a sampler that projects each draw to the nearest safe action."));
    }

    #[test]
    fn malformed_markers_still_split_segments() {
        let mut p = SegmentParser::new(4);
        let mut all = texts(p.push("<|0|>가.\n<|1>나.\n<|2\n<|2|>다.\n<|3"));
        all.extend(texts(p.push("|>라.")));
        all.extend(texts(p.finish()));
        assert_eq!(all, vec![(0, Some("가.".into())), (1, Some("나.".into())), (2, Some("다.".into())), (3, Some("라.".into()))]);
    }

    #[test]
    fn stray_marker_fragments_are_stripped() {
        assert_eq!(clean_segment("옵니다.\n<|4"), "옵니다.");
    }

    #[test]
    fn model_noise_is_stripped() {
        assert_eq!(clean_segment("<think>hm</think> 번역.\n\nCharacter limits: 0:10"), "번역.");
    }
}
