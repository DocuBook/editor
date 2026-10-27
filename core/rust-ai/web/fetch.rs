//! `web_fetch`: fetch one page through the SSRF guard and extract its main
//! content as Markdown.

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
            let (page, plain) = extract(&requested, &final_url, &content_type, &body, body_truncated);
            let links = page_links(&final_url, &content_type, &body, &plain);
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
/// whole-body fallback for pages it cannot score. Also returns the page's plain
/// text, which is what gets scanned for URLs.
fn extract(requested: &str, url: &Url, content_type: &str, body: &[u8], body_truncated: bool) -> (FetchedPage, String) {
    let raw = String::from_utf8_lossy(body);
    let (title, text, plain) = if content_type.contains("html") {
        html_text(&raw, url)
    } else {
        let raw = raw.into_owned();
        (String::new(), raw.clone(), raw)
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
    (page, plain)
}

/// Title, main content as Markdown, and its plain text.
///
/// Markdown keeps what plain text flattens: headings, list items, table cells,
/// code blocks and link targets. URLs are still read from the plain text, since
/// Markdown escapes the dots of a bare URL in prose.
fn html_text(html: &str, url: &Url) -> (String, String, String) {
    let article = dom_smoothie::Readability::new(html, Some(url.as_str()), None).and_then(|mut readability| readability.parse());
    match article {
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
    }
}

/// Markdown of the document's body, with links and images made absolute.
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
fn markdown(document: &dom_query::Document, base: &Url) -> String {
    let mut page = base.clone();
    page.set_fragment(None);
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
    compact_table_rules(&markdown)
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
        let (page, plain) = extract("https://e.example/guide", &url("https://e.example/guide"), "text/html", GUIDE.as_bytes(), false);
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
        // Markdown escapes the dots of a bare URL; links are read from the plain text.
        assert!(page.text.contains("https://notes\\.example"));
        let links = page_links(&url("https://e.example/guide"), "text/html", GUIDE.as_bytes(), &plain);
        assert!(links.contains(&"https://notes.example/v1.2".to_string()), "{links:?}");
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
        let text = markdown(&dom_query::Document::from(html), &url("https://e.example/wiki/Page"));
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
