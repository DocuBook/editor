//! `web_fetch`: fetch one page through the SSRF guard and extract its main text.

use futures_util::StreamExt;
use reqwest::header::{ACCEPT, CONTENT_TYPE, LOCATION, USER_AGENT};
use reqwest::Url;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::watch;

use super::{cancelled_error, ledger, net_guard, ToolError};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_REDIRECTS: usize = 5;
/// Bytes read from the network; the rest of a larger page is dropped.
const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;
/// Extracted text kept for the model (paged by `read_context_result`).
const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;
/// Links taken from one page into the provenance ledger.
const MAX_PAGE_LINKS: usize = 100;
const MAX_TITLE_CHARS: usize = 300;
const ACCEPTED_TYPES: [&str; 4] = ["text/html", "application/xhtml+xml", "text/plain", "text/markdown"];
const ACCEPT_HEADER: &str = "text/html,application/xhtml+xml,text/plain;q=0.9,text/markdown;q=0.9";

/// Extracted page returned to the model.
#[derive(Debug, Clone, PartialEq)]
pub struct FetchedPage {
    pub url: String,
    pub final_url: String,
    pub title: String,
    pub text: String,
    pub truncated: bool,
}

impl FetchedPage {
    /// Render as a CallToolResult-shaped value so large pages are paged as prose.
    pub fn to_value(&self) -> Value {
        let header = format!("Title: {}\nURL: {}\n\n", self.title, self.final_url);
        json!({
            "content": [{"type": "text", "text": format!("{header}{}", self.text)}],
            "url": self.url,
            "final_url": self.final_url,
            "truncated": self.truncated,
        })
    }
}

/// Fetch `raw_url` for the prompt turn `context_id`.
pub async fn fetch(
    context_id: &str,
    raw_url: &str,
    cancelled: &mut watch::Receiver<bool>,
) -> Result<FetchedPage, ToolError> {
    let mut url = net_guard::validate_url(raw_url)?;
    if !ledger::allows(context_id, url.as_str()) {
        return Err(ToolError::url_not_in_context());
    }
    let requested = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        let response = tokio::select! {
            response = send(&url) => response?,
            _ = cancelled.changed() => return Err(cancelled_error()),
        };
        let status = response.status();
        if status.is_redirection() {
            url = redirect_target(&url, &response)?;
            continue;
        }
        if !status.is_success() {
            return Err(ToolError::url_not_accessible(format!("the page answered HTTP {}", status.as_u16())));
        }
        let content_type = media_type(&response);
        if !ACCEPTED_TYPES.contains(&content_type.as_str()) {
            return Err(ToolError::unsupported_content_type(format!(
                "{} is not supported; only HTML and plain text pages can be read",
                if content_type.is_empty() { "an unlabelled body" } else { content_type.as_str() }
            )));
        }
        let (body, body_truncated) = tokio::select! {
            body = read_capped(response) => body?,
            _ = cancelled.changed() => return Err(cancelled_error()),
        };
        // HTML parsing is CPU-bound (up to MAX_BODY_BYTES): keep it off the async workers.
        let final_url = url.clone();
        let (page, links) = tokio::task::spawn_blocking(move || {
            let page = extract(&requested, &final_url, &content_type, &body, body_truncated);
            let links = page_links(&final_url, &content_type, &body, &page.text);
            (page, links)
        })
        .await
        .map_err(|_| ToolError::unavailable("the page could not be processed"))?;
        ledger::record(context_id, std::iter::once(page.final_url.as_str()));
        ledger::record(context_id, links.iter().map(String::as_str));
        return Ok(page);
    }
    Err(ToolError::url_not_accessible(format!("more than {MAX_REDIRECTS} redirects")))
}

/// Resolve, pin and send one GET for a single hop.
async fn send(url: &Url) -> Result<reqwest::Response, ToolError> {
    let (host, addrs) = net_guard::resolve_public(url).await?;
    let client = net_guard::pinned_client(&host, &addrs, CONNECT_TIMEOUT, FETCH_TIMEOUT)?;
    client
        .get(url.clone())
        .header(ACCEPT, ACCEPT_HEADER)
        .header(USER_AGENT, concat!("DocuBook-Editor/", env!("CARGO_PKG_VERSION"), " (+https://github.com/DocuBook/editor)"))
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                ToolError::url_not_accessible("the page timed out")
            } else {
                ToolError::url_not_accessible("the page could not be reached")
            }
        })
}

/// Validate a redirect's `Location` with the same rules as the first URL.
fn redirect_target(current: &Url, response: &reqwest::Response) -> Result<Url, ToolError> {
    let location = response
        .headers()
        .get(LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ToolError::url_not_accessible("redirect without a Location header"))?;
    let next = current
        .join(location)
        .map_err(|_| ToolError::url_not_accessible("redirect to an invalid URL"))?;
    if next.as_str().len() > net_guard::MAX_URL_LEN {
        return Err(ToolError::url_not_allowed("redirect URL is too long"));
    }
    net_guard::check_url(&next)?;
    Ok(next)
}

/// Lower-case media type without parameters.
fn media_type(response: &reqwest::Response) -> String {
    response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Stream the body, keeping at most `MAX_BODY_BYTES`.
async fn read_capped(response: reqwest::Response) -> Result<(Vec<u8>, bool), ToolError> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ToolError::url_not_accessible("the page body could not be read"))?;
        let room = MAX_BODY_BYTES - body.len();
        if chunk.len() >= room {
            body.extend_from_slice(&chunk[..room]);
            return Ok((body, true));
        }
        body.extend_from_slice(&chunk);
    }
    Ok((body, false))
}

/// Turn the body into readable text; HTML goes through Readability, with a
/// whole-body text fallback for pages it cannot score.
fn extract(requested: &str, url: &Url, content_type: &str, body: &[u8], body_truncated: bool) -> FetchedPage {
    let raw = String::from_utf8_lossy(body);
    let (title, text) = if content_type.contains("html") {
        html_text(&raw, url)
    } else {
        (String::new(), raw.into_owned())
    };
    let text = collapse_blank_lines(&text);
    let (text, text_truncated) = cap_bytes(text, MAX_TEXT_BYTES);
    let title = if title.trim().is_empty() { url.as_str().to_string() } else { title.trim().chars().take(MAX_TITLE_CHARS).collect() };
    FetchedPage {
        url: requested.to_string(),
        final_url: url.to_string(),
        title,
        text,
        truncated: body_truncated || text_truncated,
    }
}

/// Main text and title of an HTML document.
fn html_text(html: &str, url: &Url) -> (String, String) {
    let article = dom_smoothie::Readability::new(html, Some(url.as_str()), None).and_then(|mut readability| readability.parse());
    match article {
        Ok(article) if !article.text_content.trim().is_empty() => (article.title, article.text_content.to_string()),
        _ => {
            let document = dom_query::Document::from(html);
            document.select("script, style, noscript, template, svg").remove();
            let title = document.select("title").text().to_string();
            (title, document.select("body").text().to_string())
        }
    }
}

/// Absolute http(s) links of the page (anchors and URLs in the text).
fn page_links(base: &Url, content_type: &str, body: &[u8], text: &str) -> Vec<String> {
    let mut links = Vec::new();
    if content_type.contains("html") {
        let document = dom_query::Document::from(String::from_utf8_lossy(body).as_ref());
        for anchor in document.select("a[href]").iter() {
            if links.len() >= MAX_PAGE_LINKS {
                break;
            }
            if let Some(href) = anchor.attr("href") {
                if let Ok(link) = base.join(href.trim()) {
                    if matches!(link.scheme(), "http" | "https") {
                        links.push(link.to_string());
                    }
                }
            }
        }
    }
    links.extend(ledger::extract_urls(text));
    links.truncate(MAX_PAGE_LINKS * 2);
    links
}

/// Squeeze runs of blank lines and trailing spaces left by extraction.
fn collapse_blank_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank_run = 0;
    for line in text.lines().map(str::trim_end) {
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim().to_string()
}

/// Cut `text` to at most `limit` bytes on a character boundary.
fn cap_bytes(mut text: String, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text, false);
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    (text, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }

    #[test]
    fn html_is_reduced_to_its_main_text() {
        let html = "<html><head><title>Guide</title><script>steal()</script></head><body><nav>menu</nav><article><h1>Guide</h1><p>Rust pins resolved addresses before connecting, which defeats DNS rebinding in most setups.</p><p>Redirects are validated hop by hop so a public page cannot bounce the request inward.</p></article></body></html>";
        let page = extract("https://e.example/a", &url("https://e.example/a"), "text/html", html.as_bytes(), false);
        assert_eq!(page.title, "Guide");
        assert!(page.text.contains("defeats DNS rebinding"));
        assert!(!page.text.contains("steal()"));
        assert!(!page.truncated);
    }

    #[test]
    fn plain_text_is_kept_and_blank_runs_collapse() {
        let page = extract("https://e.example/t", &url("https://e.example/t"), "text/plain", b"line one\n\n\n\nline two  \n", true);
        assert_eq!(page.text, "line one\n\nline two");
        assert_eq!(page.title, "https://e.example/t");
        assert!(page.truncated);
    }

    #[test]
    fn links_are_absolutised_and_non_http_dropped() {
        let html = br#"<body><a href="/docs">d</a><a href="https://other.example/x">o</a><a href="mailto:a@b.c">m</a><a href="javascript:x()">j</a></body>"#;
        let links = page_links(&url("https://e.example/start"), "text/html", html, "see https://text.example/y.");
        assert_eq!(links, ["https://e.example/docs", "https://other.example/x", "https://text.example/y"]);
    }

    #[test]
    fn text_is_capped_on_a_character_boundary() {
        let (text, truncated) = cap_bytes("aé".repeat(4), 4);
        assert_eq!(text, "aéa");
        assert!(truncated);
    }

    #[tokio::test]
    async fn urls_outside_the_turn_are_refused_before_any_network_access() {
        let (_cancel, mut cancelled) = watch::channel(false);
        let error = fetch("fetch-test-turn", "https://example.com/never-seen", &mut cancelled).await.unwrap_err();
        assert_eq!(error.code, "url_not_in_context");
        ledger::record("fetch-test-turn", ["http://127.0.0.1/admin"]);
        let error = fetch("fetch-test-turn", "http://127.0.0.1/admin", &mut cancelled).await.unwrap_err();
        assert_eq!(error.code, "url_not_allowed");
    }
}
