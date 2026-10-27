//! `web_fetch`: fetch one page through the SSRF guard and extract its main
//! content as Markdown.

use futures_util::StreamExt;
use reqwest::header::{HeaderValue, ACCEPT, CONTENT_TYPE, LOCATION, RETRY_AFTER, USER_AGENT};
use reqwest::Url;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::future::Future;
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
/// Raw-page anchors offered to the provenance ledger after the links the text shows.
const MAX_PAGE_LINKS: usize = 100;
const MAX_TITLE_CHARS: usize = 300;
const ACCEPTED_TYPES: [&str; 4] = ["text/html", "application/xhtml+xml", "text/plain", "text/markdown"];
const ACCEPT_HEADER: &str = "text/html,application/xhtml+xml,text/plain;q=0.9,text/markdown;q=0.9";
/// Statuses that mean "not now" rather than "no": worth one more try.
const RETRY_STATUSES: [u16; 5] = [408, 429, 502, 503, 504];
/// Wait before the retry when the server does not say how long.
const RETRY_DELAY: Duration = Duration::from_secs(1);
/// Longest `Retry-After` honoured; a longer one fails at once instead of
/// holding the model's turn.
const MAX_RETRY_WAIT: Duration = Duration::from_secs(5);
/// Bytes of an unlabelled body inspected to decide whether it is HTML or text.
const SNIFF_BYTES: usize = 512;

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
    // One retry for the whole fetch, not one per redirect hop.
    let mut retry_left = true;
    for _ in 0..=MAX_REDIRECTS {
        let response = send_retrying(|| send(&url), &mut retry_left, cancelled).await?;
        let status = response.status();
        if status.is_redirection() {
            url = redirect_target(&url, &response)?;
            continue;
        }
        if !status.is_success() {
            return Err(ToolError::url_not_accessible(format!("the page answered HTTP {}", status.as_u16())));
        }
        let labelled = media_type(&response);
        if !labelled.is_empty() && !ACCEPTED_TYPES.contains(&labelled.as_str()) {
            return Err(ToolError::unsupported_content_type(format!(
                "{labelled} is not supported; only HTML and plain text pages can be read"
            )));
        }
        let (body, body_truncated) = tokio::select! {
            body = read_capped(response) => body?,
            _ = cancelled.changed() => return Err(cancelled_error()),
        };
        // Some servers send pages without a Content-Type: judge them by their first bytes.
        let content_type = if labelled.is_empty() {
            sniff_media_type(&body)
                .ok_or_else(|| ToolError::unsupported_content_type("an unlabelled body that is neither HTML nor text is not supported"))?
                .to_string()
        } else {
            labelled
        };
        // HTML parsing is CPU-bound (up to MAX_BODY_BYTES): keep it off the async workers.
        let final_url = url.clone();
        let (page, links) = tokio::task::spawn_blocking(move || {
            let (page, shown) = extract(&requested, &final_url, &content_type, &body, body_truncated);
            let links = page_links(&final_url, &content_type, &body, shown);
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

/// One send attempt: the outer error is the guard refusing the host (never
/// retried); the inner one is the transport failing, which `send_retrying` may
/// try again.
type Sent = Result<Result<reqwest::Response, reqwest::Error>, ToolError>;

/// Resolve, pin and send one GET for a single hop.
async fn send(url: &Url) -> Sent {
    let (host, addrs) = net_guard::resolve_public(url).await?;
    let client = net_guard::pinned_client(&host, &addrs, CONNECT_TIMEOUT, FETCH_TIMEOUT)?;
    Ok(client
        .get(url.clone())
        .header(ACCEPT, ACCEPT_HEADER)
        .header(USER_AGENT, concat!("DocuBook-Editor/", env!("CARGO_PKG_VERSION"), " (+https://github.com/DocuBook/editor)"))
        .send()
        .await)
}

/// Run `send`, and run it once more while `retry_left` holds when the server
/// answers "not now" (`RETRY_STATUSES`) or the connection fails before a reply.
///
/// A timeout is not retried: it has already used the whole request budget.
/// A `Retry-After` longer than `MAX_RETRY_WAIT`, or given as a date, is not
/// waited out; the status goes back to the model instead.
async fn send_retrying<F, Fut>(
    mut send: F,
    retry_left: &mut bool,
    cancelled: &mut watch::Receiver<bool>,
) -> Result<reqwest::Response, ToolError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Sent>,
{
    loop {
        let sent = tokio::select! {
            sent = send() => sent?,
            _ = cancelled.changed() => return Err(cancelled_error()),
        };
        let wait = match &sent {
            Ok(response) => retry_wait(response.status().as_u16(), response.headers().get(RETRY_AFTER)),
            Err(error) => (!error.is_timeout()).then_some(RETRY_DELAY),
        };
        match wait {
            Some(wait) if *retry_left => {
                *retry_left = false;
                drop(sent);
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = cancelled.changed() => return Err(cancelled_error()),
                }
            }
            _ => {
                return sent.map_err(|error| {
                    if error.is_timeout() {
                        ToolError::url_not_accessible("the page timed out")
                    } else {
                        ToolError::url_not_accessible("the page could not be reached")
                    }
                })
            }
        }
    }
}

/// How long to wait before retrying a response with `status`, or `None` when
/// it should not be retried.
fn retry_wait(status: u16, retry_after: Option<&HeaderValue>) -> Option<Duration> {
    if !RETRY_STATUSES.contains(&status) {
        return None;
    }
    let Some(retry_after) = retry_after else {
        return Some(RETRY_DELAY);
    };
    retry_after
        .to_str()
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .filter(|wait| *wait <= MAX_RETRY_WAIT)
}

/// Media type of a body that came without a `Content-Type`: `text/html` when it
/// opens like an HTML document (the WHATWG sniffing signatures), `text/plain`
/// when its first bytes are UTF-8 text, `None` for anything else.
fn sniff_media_type(body: &[u8]) -> Option<&'static str> {
    let head = &body[..body.len().min(SNIFF_BYTES)];
    let head = head.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(head);
    let text = match std::str::from_utf8(head) {
        Ok(text) => text,
        // The sample may end inside a character; that is still text.
        Err(error) if error.error_len().is_none() => std::str::from_utf8(&head[..error.valid_up_to()]).ok()?,
        Err(_) => return None,
    };
    if text.chars().any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r' | '\x0c')) {
        return None;
    }
    const TAGS: [&str; 17] = [
        "<!doctype html", "<html", "<head", "<script", "<iframe", "<h1", "<div", "<font", "<table", "<a", "<style", "<title",
        "<b", "<body", "<br", "<p", "<!--",
    ];
    let start = text.trim_start_matches([' ', '\t', '\n', '\r', '\x0c']).as_bytes();
    let is_html = TAGS.iter().any(|tag| {
        start.len() > tag.len()
            && start[..tag.len()].eq_ignore_ascii_case(tag.as_bytes())
            && matches!(start[tag.len()], b' ' | b'>')
    });
    Some(if is_html { "text/html" } else { "text/plain" })
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
/// whole-body fallback for pages it cannot score. Also returns the link URLs
/// the text shows the model.
fn extract(requested: &str, url: &Url, content_type: &str, body: &[u8], body_truncated: bool) -> (FetchedPage, Vec<String>) {
    let raw = String::from_utf8_lossy(body);
    let (title, text, shown) = if content_type.contains("html") {
        html_text(&raw, url)
    } else {
        let shown = ledger::extract_urls(&raw);
        (String::new(), raw.into_owned(), shown)
    };
    let text = collapse_blank_lines(&text);
    let (text, text_truncated) = cap_bytes(text, MAX_TEXT_BYTES);
    let title = if title.trim().is_empty() { url.as_str().to_string() } else { title.trim().chars().take(MAX_TITLE_CHARS).collect() };
    let page = FetchedPage {
        url: requested.to_string(),
        final_url: url.to_string(),
        title,
        text,
        truncated: body_truncated || text_truncated,
    };
    (page, shown)
}

/// Title, main content as Markdown, and the link URLs it shows: link targets
/// first, then bare URLs in the prose.
///
/// Markdown keeps what plain text flattens: headings, list items, table cells,
/// code blocks and link targets. Bare URLs are still read from the plain text,
/// since Markdown escapes their dots.
fn html_text(html: &str, url: &Url) -> (String, String, Vec<String>) {
    let article = dom_smoothie::Readability::new(html, Some(url.as_str()), None).and_then(|mut readability| readability.parse());
    let (title, (text, mut shown), plain) = match article {
        Ok(article) if !article.text_content.trim().is_empty() => {
            let content = dom_query::Document::from(article.content.as_ref());
            (article.title, markdown(&content, url), article.text_content.to_string())
        }
        _ => {
            let document = dom_query::Document::from(html);
            document.select("script, style, noscript, template, svg").remove();
            let title = document.select("title").text().to_string();
            let plain = document.select("body").text().to_string();
            (title, markdown(&document, url), plain)
        }
    };
    shown.extend(ledger::extract_urls(&plain));
    (title, text, shown)
}

/// Markdown of the document's body, with links and images made absolute, and
/// the link targets it kept, in document order.
///
/// Readability already absolutises its own output; the whole-body fallback has
/// not been, and a relative `/docs` link is useless to the model. An image
/// without alt text, or one whose source is not http(s) (an inline `data:` URI
/// can run to hundreds of KB), is reduced to its alt text.
///
/// The model reads a bounded share of every page, so markup that repeats what
/// is already there goes: `title` attributes (usually the link text again),
/// links to a fragment of this same page (a wiki article has hundreds of
/// citation jumps), and the padding of table separator rows.
fn markdown(document: &dom_query::Document, base: &Url) -> (String, Vec<String>) {
    let mut page = base.clone();
    page.set_fragment(None);
    let mut links = Vec::new();
    for anchor in document.select("a[href]").iter() {
        anchor.remove_attr("title");
        match anchor.attr("href").and_then(|href| base.join(href.trim()).ok()) {
            Some(mut link) if matches!(link.scheme(), "http" | "https") => {
                let target = link.as_str().to_string();
                link.set_fragment(None);
                if link == page {
                    anchor.remove_attr("href");
                } else {
                    anchor.set_attr("href", &target);
                    links.push(target);
                }
            }
            // `javascript:`, `mailto:` and unparsable targets keep only their text.
            _ => anchor.remove_attr("href"),
        }
    }
    for image in document.select("img").iter() {
        image.remove_attr("title");
        let alt = image.attr("alt").map(|alt| alt.trim().to_string()).unwrap_or_default();
        let source = image.attr("src").and_then(|src| base.join(src.trim()).ok()).filter(|src| matches!(src.scheme(), "http" | "https"));
        match source {
            Some(source) if !alt.is_empty() => image.set_attr("src", source.as_str()),
            _ => image.replace_with_html(escape_html(&alt)),
        }
    }
    let body = document.select("body");
    let markdown = match body.nodes().first() {
        Some(body) => body.md(None).to_string(),
        None => document.md(None).to_string(),
    };
    (compact_table_rules(&markdown), links)
}

/// Shorten table separator rows (`| ------ | --- |` to `| - | - |`) outside
/// code fences; the serializer pads every rule to its column's width.
fn compact_table_rules(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut in_fence = false;
    for line in markdown.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
        }
        let is_rule = !in_fence
            && trimmed.len() > 2
            && trimmed.starts_with('|')
            && trimmed.ends_with('|')
            && trimmed.contains('-')
            && trimmed.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '));
        if is_rule {
            let cells = trimmed[1..trimmed.len() - 1].split('|').map(|cell| {
                let cell = cell.trim();
                match (cell.starts_with(':'), cell.ends_with(':') && cell.len() > 1) {
                    (true, true) => ":-:",
                    (true, false) => ":-",
                    (false, true) => "-:",
                    (false, false) => "-",
                }
            });
            out.push_str(&format!("| {} |", cells.collect::<Vec<_>>().join(" | ")));
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

/// Escape text for insertion as HTML.
fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Absolute http(s) links of the page for the ledger: the ones the extracted
/// text shows the model (`shown`) first, then the raw page's anchors, deduplicated
/// and capped at what the ledger takes from one source. Nav and sidebar anchors
/// come first in the raw page, so they must not use up the cap.
fn page_links(base: &Url, content_type: &str, body: &[u8], shown: Vec<String>) -> Vec<String> {
    let mut anchors = Vec::new();
    if content_type.contains("html") {
        let document = dom_query::Document::from(String::from_utf8_lossy(body).as_ref());
        for anchor in document.select("a[href]").iter() {
            if anchors.len() >= MAX_PAGE_LINKS {
                break;
            }
            if let Some(href) = anchor.attr("href") {
                if let Ok(link) = base.join(href.trim()) {
                    if matches!(link.scheme(), "http" | "https") {
                        anchors.push(link.to_string());
                    }
                }
            }
        }
    }
    let mut seen = HashSet::new();
    shown
        .into_iter()
        .chain(anchors)
        .filter_map(|link| ledger::normalize(&link))
        .filter(|link| seen.insert(link.clone()))
        .take(ledger::MAX_URLS_PER_SOURCE)
        .collect()
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
        let (page, _) = extract("https://e.example/a", &url("https://e.example/a"), "text/html", html.as_bytes(), false);
        assert_eq!(page.title, "Guide");
        assert!(page.text.contains("defeats DNS rebinding"));
        assert!(!page.text.contains("steal()"));
        assert!(!page.truncated);
    }

    #[test]
    fn plain_text_is_kept_and_blank_runs_collapse() {
        let (page, _) = extract("https://e.example/t", &url("https://e.example/t"), "text/plain", b"line one\n\n\n\nline two  \n", true);
        assert_eq!(page.text, "line one\n\nline two");
        assert_eq!(page.title, "https://e.example/t");
        assert!(page.truncated);
    }

    /// A documentation page: enough prose for Readability to score it.
    const GUIDE: &str = r#"<html><head><title>Install guide</title></head><body><nav><a href="/">Home</a></nav><article>
<h1>Install guide</h1>
<p>DocuBook runs on macOS and Linux. Read the <a href="/docs/faq">FAQ</a> before you start, and keep the release notes nearby while you upgrade.</p>
<h2>Requirements</h2><ul><li>Node 22 or newer</li><li>Rust 1.80</li></ul>
<h2>Steps</h2><ol><li>Clone the repo</li><li>Run the installer</li></ol>
<pre><code>npm install
npm run build</code></pre>
<table><thead><tr><th>Platform</th><th>Status</th></tr></thead><tbody><tr><td>macOS</td><td>Stable</td></tr><tr><td>Linux</td><td>Beta</td></tr></tbody></table>
<p>Every release is signed, and the notes explain each change in detail for the operators who upgrade, see https://notes.example/v1.2 for the latest.</p>
</article></body></html>"#;

    #[test]
    fn html_keeps_its_structure_as_markdown() {
        let (page, shown) = extract("https://e.example/guide", &url("https://e.example/guide"), "text/html", GUIDE.as_bytes(), false);
        assert_eq!(page.title, "Install guide");
        for expected in [
            "## Requirements",
            "- Node 22 or newer\n- Rust 1\\.80",
            "1. Clone the repo\n1. Run the installer",
            "```\nnpm install\nnpm run build\n```",
            "| Platform | Status |\n| - | - |\n| macOS | Stable |\n| Linux | Beta |",
            "[FAQ](https://e.example/docs/faq)",
        ] {
            assert!(page.text.contains(expected), "missing {expected:?} in:\n{}", page.text);
        }
        assert!(!page.text.contains("Home"), "navigation is not main content");
        // Markdown escapes the dots of a bare URL; bare URLs are read from the plain text.
        assert!(page.text.contains("https://notes\\.example"));
        assert_eq!(shown, ["https://e.example/docs/faq", "https://notes.example/v1.2"]);
    }

    #[test]
    fn links_the_text_shows_are_not_crowded_out_by_navigation() {
        let nav: String = (0..2 * MAX_PAGE_LINKS).map(|i| format!(r#"<a href="/n{i}">n{i}</a>"#)).collect();
        let html = GUIDE.replace(r#"<a href="/">Home</a>"#, &nav);
        let base = url("https://e.example/guide");
        let (page, shown) = extract(base.as_str(), &base, "text/html", html.as_bytes(), false);
        assert!(page.text.contains("[FAQ](https://e.example/docs/faq)"), "{}", page.text);
        let links = page_links(&base, "text/html", html.as_bytes(), shown);
        assert_eq!(&links[..3], ["https://e.example/docs/faq", "https://notes.example/v1.2", "https://e.example/n0"]);
        assert_eq!(links.len(), 2 + MAX_PAGE_LINKS);
    }

    #[test]
    fn fallback_markdown_has_absolute_links_and_no_inline_images() {
        // Too short for Readability to score, so the whole body is used.
        let html = r#"<body><p>See <a href="/docs">docs</a>, <a href="javascript:run()">run it</a> and <a href="mailto:a@b.c">mail us</a>.</p>
<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" alt="Tiny <logo>"><img src="/shot.png" alt="Main window"><img src="/spacer.gif"><script>steal()</script></body>"#;
        let (page, _) = extract("https://e.example/a/b", &url("https://e.example/a/b"), "text/html", html.as_bytes(), false);
        assert!(page.text.contains("[docs](https://e.example/docs)"), "{}", page.text);
        assert!(page.text.contains("run it") && !page.text.contains("javascript:"), "{}", page.text);
        assert!(page.text.contains("mail us") && !page.text.contains("mailto:"), "{}", page.text);
        assert!(page.text.contains("![Main window](https://e.example/shot.png)"), "{}", page.text);
        assert!(page.text.contains("Tiny \\<logo\\>") && !page.text.contains("base64"), "{}", page.text);
        assert!(!page.text.contains("spacer") && !page.text.contains("steal()"), "{}", page.text);
    }

    #[test]
    fn markup_that_repeats_the_page_is_dropped() {
        let html = r##"<body><p>Markdown<a href="#cite_note-1">[1]</a> is a <a href="/wiki/Markup" title="Markup">markup language</a>; see <a href="https://e.example/wiki/Page#History">its history</a> and <a href="/wiki/Other#Top">another page</a>.</p></body>"##;
        let (text, links) = markdown(&dom_query::Document::from(html), &url("https://e.example/wiki/Page"));
        assert_eq!(links, ["https://e.example/wiki/Markup", "https://e.example/wiki/Other#Top"]);
        assert!(text.contains("[markup language](https://e.example/wiki/Markup)"), "{text}");
        assert!(!text.contains("\"Markup\""), "title attribute kept: {text}");
        assert!(text.contains("Markdown\\[1\\]") && !text.contains("cite_note"), "{text}");
        assert!(text.contains("its history") && !text.contains("#History"), "{text}");
        assert!(text.contains("[another page](https://e.example/wiki/Other#Top)"), "{text}");
    }

    #[test]
    fn table_rules_are_compacted_outside_code_fences() {
        let input = "| Platform | Status |\n| -------- | -----: |\n| :------- | :----: |\n```\n| ------ |\n```\n";
        assert_eq!(compact_table_rules(input), "| Platform | Status |\n| - | -: |\n| :- | :-: |\n```\n| ------ |\n```\n");
    }

    #[test]
    fn links_are_absolutised_deduplicated_and_non_http_dropped() {
        let html = br#"<body><a href="/docs">d</a><a href="https://other.example/x">o</a><a href="mailto:a@b.c">m</a><a href="javascript:x()">j</a><a href="/docs#top">t</a></body>"#;
        let shown = vec!["https://text.example/y".to_string(), "https://e.example/docs".to_string()];
        let links = page_links(&url("https://e.example/start"), "text/html", html, shown);
        assert_eq!(links, ["https://text.example/y", "https://e.example/docs", "https://other.example/x"]);
    }

    #[test]
    fn text_is_capped_on_a_character_boundary() {
        let (text, truncated) = cap_bytes("aé".repeat(4), 4);
        assert_eq!(text, "aéa");
        assert!(truncated);
    }

    #[test]
    fn only_transient_statuses_are_retried_and_long_waits_are_not_honoured() {
        let header = |value: &'static str| HeaderValue::from_static(value);
        assert_eq!(retry_wait(503, None), Some(RETRY_DELAY));
        assert_eq!(retry_wait(429, Some(&header("2"))), Some(Duration::from_secs(2)));
        assert_eq!(retry_wait(502, Some(&header(" 0 "))), Some(Duration::ZERO));
        assert_eq!(retry_wait(429, Some(&header("60"))), None);
        assert_eq!(retry_wait(503, Some(&header("Wed, 21 Oct 2026 07:28:00 GMT"))), None);
        for status in [200, 301, 400, 403, 404, 500] {
            assert_eq!(retry_wait(status, None), None, "{status} must not be retried");
        }
    }

    #[test]
    fn unlabelled_bodies_are_sniffed_as_html_text_or_refused() {
        for html in ["\u{feff}  <!DOCTYPE html><html>", "<html lang=\"en\">", "\n<p>Hello", "<a href=\"/x\">x</a>", "<!-- built --><div>"] {
            assert_eq!(sniff_media_type(html.as_bytes()), Some("text/html"), "{html:?}");
        }
        for text in ["# Title\n\nSome *markdown*.", "<abbr>not a sniffed tag</abbr>", "<?xml version=\"1.0\"?>", ""] {
            assert_eq!(sniff_media_type(text.as_bytes()), Some("text/plain"), "{text:?}");
        }
        // A sample that ends inside a multi-byte character is still text.
        let cut = format!("a{}", "é".repeat(SNIFF_BYTES)).into_bytes();
        assert!(std::str::from_utf8(&cut[..SNIFF_BYTES]).is_err(), "the sample must end inside a character");
        assert_eq!(sniff_media_type(&cut), Some("text/plain"));
        assert_eq!(sniff_media_type(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"), None);
        assert_eq!(sniff_media_type(b"text\0with a NUL"), None);
        assert_eq!(sniff_media_type(&[0xff, 0xfe, b'a', 0]), None);
    }

    /// Serve `responses` in order, one per connection, and count the requests.
    async fn serve(responses: Vec<&'static str>) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/page", listener.local_addr().unwrap());
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            for response in responses {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let mut head = Vec::new();
                let mut buf = [0u8; 1024];
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => head.extend_from_slice(&buf[..n]),
                    }
                }
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        (base, hits)
    }

    const UNAVAILABLE_NOW: &str = "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    const OK_PAGE: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";

    /// `send` without the SSRF guard, so the retry loop can run against loopback.
    fn plain_send(url: &str) -> impl FnMut() -> std::pin::Pin<Box<dyn Future<Output = Sent> + Send>> {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let url = url.to_string();
        move || {
            let request = client.get(&url);
            Box::pin(async move { Ok(request.send().await) })
        }
    }

    #[tokio::test]
    async fn a_transient_status_is_retried_once() {
        let (_cancel, mut cancelled) = watch::channel(false);
        let (url, hits) = serve(vec![UNAVAILABLE_NOW, OK_PAGE]).await;
        let mut retry_left = true;
        let response = send_retrying(plain_send(&url), &mut retry_left, &mut cancelled).await.unwrap();
        assert_eq!((response.status().as_u16(), hits.load(std::sync::atomic::Ordering::SeqCst), retry_left), (200, 2, false));

        // The retry is spent: a second "not now" goes back to the caller as is.
        let (url, hits) = serve(vec![UNAVAILABLE_NOW, UNAVAILABLE_NOW, OK_PAGE]).await;
        let mut retry_left = true;
        let response = send_retrying(plain_send(&url), &mut retry_left, &mut cancelled).await.unwrap();
        assert_eq!((response.status().as_u16(), hits.load(std::sync::atomic::Ordering::SeqCst)), (503, 2));
        let (url, hits) = serve(vec![UNAVAILABLE_NOW, OK_PAGE]).await;
        let response = send_retrying(plain_send(&url), &mut retry_left, &mut cancelled).await.unwrap();
        assert_eq!((response.status().as_u16(), hits.load(std::sync::atomic::Ordering::SeqCst)), (503, 1), "one retry per fetch, not per hop");
    }

    #[tokio::test]
    async fn a_long_retry_after_is_not_waited_out() {
        let (_cancel, mut cancelled) = watch::channel(false);
        let (url, hits) = serve(vec!["HTTP/1.1 429 Too Many Requests\r\nRetry-After: 120\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", OK_PAGE]).await;
        let mut retry_left = true;
        let response = send_retrying(plain_send(&url), &mut retry_left, &mut cancelled).await.unwrap();
        assert_eq!((response.status().as_u16(), hits.load(std::sync::atomic::Ordering::SeqCst), retry_left), (429, 1, true));
    }

    #[tokio::test]
    async fn a_refused_connection_is_retried_then_reported() {
        let (_cancel, mut cancelled) = watch::channel(false);
        // Bind and drop: nothing listens on the port any more.
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
        let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut inner = plain_send(&format!("http://{closed}/"));
        let counter = attempts.clone();
        let send = move || {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            inner()
        };
        let mut retry_left = true;
        let error = send_retrying(send, &mut retry_left, &mut cancelled).await.unwrap_err();
        assert_eq!((error.code, error.message.as_str()), ("url_not_accessible", "the page could not be reached"));
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn stop_cancels_the_wait_before_a_retry() {
        let (cancel, mut cancelled) = watch::channel(false);
        let (url, hits) = serve(vec!["HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", OK_PAGE]).await;
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let _ = cancel.send(true);
        });
        let started = std::time::Instant::now();
        let mut retry_left = true;
        let error = send_retrying(plain_send(&url), &mut retry_left, &mut cancelled).await.unwrap_err();
        assert_eq!(error.message, "request cancelled");
        assert!(started.elapsed() < RETRY_DELAY, "the {RETRY_DELAY:?} wait was not cut short");
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
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
