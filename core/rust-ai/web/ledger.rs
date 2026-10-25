//! URL-provenance ledger: `web_fetch` may only open URLs that already appeared
//! in the current prompt turn (prompt, document, earlier web results).
//!
//! A prompt-injected page can then only point the model at URLs it already
//! contains; it cannot make the model compose an exfiltration URL.

use regex::Regex;
use reqwest::Url;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/// Prompt turns tracked at once; the oldest is dropped beyond this.
const MAX_CONTEXTS: usize = 64;
/// URLs remembered per prompt turn.
const MAX_URLS_PER_CONTEXT: usize = 500;
/// URLs taken from one source (seed list, search results, one page).
pub const MAX_URLS_PER_SOURCE: usize = 200;
/// A turn that has been quiet this long is forgotten.
const CONTEXT_TTL: Duration = Duration::from_secs(15 * 60);
/// Longest context id accepted from the transport.
const MAX_CONTEXT_ID_LEN: usize = 128;

static LEDGER: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
static URL_PATTERN: OnceLock<Regex> = OnceLock::new();

/// URLs allowed for one prompt turn.
struct Entry {
    urls: HashSet<String>,
    touched: Instant,
}

/// Lock the ledger, recovering from poisoning (entries are always whole).
fn ledger() -> MutexGuard<'static, HashMap<String, Entry>> {
    LEDGER
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Canonical form used for comparison: parsed, fragment dropped.
pub fn normalize(raw: &str) -> Option<String> {
    let mut url = Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    url.set_fragment(None);
    Some(url.to_string())
}

/// Add URLs to a prompt turn, creating it when needed.
pub fn record<'a>(context_id: &str, urls: impl IntoIterator<Item = &'a str>) {
    if context_id.is_empty() || context_id.len() > MAX_CONTEXT_ID_LEN {
        return;
    }
    let mut ledger = ledger();
    ledger.retain(|_, entry| entry.touched.elapsed() <= CONTEXT_TTL);
    if !ledger.contains_key(context_id) && ledger.len() >= MAX_CONTEXTS {
        if let Some(oldest) = ledger.iter().min_by_key(|(_, entry)| entry.touched).map(|(id, _)| id.clone()) {
            ledger.remove(&oldest);
        }
    }
    let entry = ledger
        .entry(context_id.to_string())
        .or_insert_with(|| Entry { urls: HashSet::new(), touched: Instant::now() });
    entry.touched = Instant::now();
    for url in urls.into_iter().take(MAX_URLS_PER_SOURCE).filter_map(normalize) {
        if entry.urls.len() >= MAX_URLS_PER_CONTEXT {
            break;
        }
        entry.urls.insert(url);
    }
}

/// Report whether `url` was seen in this prompt turn.
pub fn allows(context_id: &str, url: &str) -> bool {
    let Some(url) = normalize(url) else {
        return false;
    };
    let mut ledger = ledger();
    match ledger.get_mut(context_id) {
        Some(entry) if entry.touched.elapsed() <= CONTEXT_TTL => {
            entry.touched = Instant::now();
            entry.urls.contains(&url)
        }
        _ => false,
    }
}

/// Find absolute http(s) URLs in free text, trimming trailing punctuation.
pub fn extract_urls(text: &str) -> Vec<String> {
    let pattern = URL_PATTERN.get_or_init(|| {
        Regex::new(r#"https?://[^\s<>"'`\\^{}|\[\]]+"#).expect("URL pattern is valid")
    });
    let mut seen = HashSet::new();
    pattern
        .find_iter(text)
        .map(|found| found.as_str().trim_end_matches(['.', ',', ';', ':', '!', '?', ')', '*', '_']))
        .filter(|url| seen.insert(*url))
        .take(MAX_URLS_PER_SOURCE)
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_recorded_urls_are_allowed_and_fragments_do_not_matter() {
        record("turn-a", ["https://example.com/docs#intro", "not a url", "ftp://example.com/x"]);
        assert!(allows("turn-a", "https://example.com/docs"));
        assert!(allows("turn-a", "https://EXAMPLE.com/docs#other"));
        assert!(!allows("turn-a", "https://example.com/docs?leak=secret"));
        assert!(!allows("turn-a", "ftp://example.com/x"));
        assert!(!allows("turn-b", "https://example.com/docs"));
    }

    #[test]
    fn invalid_context_ids_are_ignored() {
        record("", ["https://example.com/"]);
        record(&"x".repeat(MAX_CONTEXT_ID_LEN + 1), ["https://example.com/"]);
        assert!(!allows("", "https://example.com/"));
    }

    #[test]
    fn extracts_urls_from_prose_without_trailing_punctuation() {
        let urls = extract_urls("See https://a.example/x, (https://b.example/y). Also https://a.example/x again and http://c.example/z?q=1.");
        assert_eq!(urls, ["https://a.example/x", "https://b.example/y", "http://c.example/z?q=1"]);
    }

    #[test]
    fn caps_urls_per_turn() {
        let urls: Vec<String> = (0..MAX_URLS_PER_CONTEXT + 50).map(|n| format!("https://example.com/{n}")).collect();
        for chunk in urls.chunks(MAX_URLS_PER_SOURCE) {
            record("turn-cap", chunk.iter().map(String::as_str));
        }
        let kept = (0..MAX_URLS_PER_CONTEXT + 50)
            .filter(|n| allows("turn-cap", &format!("https://example.com/{n}")))
            .count();
        assert_eq!(kept, MAX_URLS_PER_CONTEXT);
    }
}
