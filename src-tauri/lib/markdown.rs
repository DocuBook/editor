//! Markdown rendering commands — preview wrapper + safe HTML for TipTap.
//! Backing logic lives in `crate::markdown`; sanitization is `markdown_to_safe_html`
//! (pulldown-cmark + ammonia). Security & snapshot tests live here with the code.

use crate::markdown::markdown_to_safe_html;

/// Convert markdown to clean HTML (no wrapper) for TipTap display.
#[tauri::command]
pub fn md_to_html(content: &str) -> String {
    markdown_to_safe_html(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_renders_html() {
        let html = md_to_html("# Hello\n\n**bold** and `code`");
        assert!(html.contains("<h1"));
        assert!(html.contains("Hello"));
        assert!(html.contains("<strong>"));
        assert!(html.contains("<code>"));
    }
}

#[cfg(test)]
mod security_tests {
    use super::*;

    fn has(hay: &str, needle: &str) -> bool { hay.contains(needle) }

    #[test]
    fn markdown_xss_payloads_are_neutralized() {
        // raw script tag → escaped text, no executable script element
        let out = markdown_to_safe_html("<script>alert(1)</script>");
        assert!(!has(&out, "<script"), "script tag survived: {out}");
        assert!(!has(&out, "<script>alert"), "script content leaked: {out}");

        // event handler attribute stripped
        let out = markdown_to_safe_html("<img src=x onerror=alert(1)>");
        assert!(!has(&out, "onerror"), "onerror survived: {out}");

        // javascript: link URL neutralized
        let out = markdown_to_safe_html("[click](javascript:alert(1))");
        assert!(!has(&out, "javascript:"), "javascript: URL survived: {out}");

        // iframe dropped
        let out = markdown_to_safe_html("<iframe src=https://evil></iframe>");
        assert!(!has(&out, "iframe"), "iframe survived: {out}");
    }

    #[test]
    fn markdown_safe_content_still_renders() {
        let out = markdown_to_safe_html("# Title\n\n**bold** and [link](https://example.com)");
        assert!(has(&out, "<h1"), "heading lost: {out}");
        assert!(has(&out, "<strong>"), "bold lost: {out}");
        assert!(has(&out, "<a href=\"https://example.com\""), "link lost: {out}");
    }
}

/** Snapshot tests — full HTML contract of markdown_to_safe_html (md_to_html /
 *  preview path). Deterministic: no timestamps/UUIDs in output.
 *  UPDATE POLICY: regenerate ONLY on an intentional rendering change
 *  (deliberate pulldown-cmark/ammonia upgrade). A snapshot diff in a
 *  feature/refactor PR = unintended contract drift — fix the code, not the
 *  snapshot. To update deliberately: cargo shows the diff; paste the new
 *  output into the const below. */
#[cfg(test)]
mod snapshot_tests {
    use super::*;

    const RICH_GFM: &str = "# Title\n\nSome **bold**, *italic*, ~~strike~~, `code`, and [link](https://example.com).\n\n> Quote\n\n- item one\n- item two\n\n1. first\n2. second\n\n```rust\nfn main() {}\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] open\n";

    // SNAPSHOTS — regenerate only per update policy above. Values captured
    // from the current pulldown-cmark + ammonia pipeline (v0.13.x / current).
    const RICH_HTML: &str = "<h1>Title</h1>\n<p>Some <strong>bold</strong>, <em>italic</em>, <del>strike</del>, <code>code</code>, and <a href=\"https://example.com\" rel=\"noopener noreferrer\">link</a>.</p>\n<blockquote>\n<p>Quote</p>\n</blockquote>\n<ul>\n<li>item one</li>\n<li>item two</li>\n</ul>\n<ol>\n<li>first</li>\n<li>second</li>\n</ol>\n<pre><code>fn main() {}\n</code></pre>\n<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>\n<tr><td>1</td><td>2</td></tr>\n</tbody></table>\n<ul>\n<li>\ndone</li>\n<li>\nopen</li>\n</ul>\n";

    const XSS_HTML: &str = "\n<img src=\"x\">\n<p><a rel=\"noopener noreferrer\">click</a></p>\n";

    #[test]
    fn rich_gfm_html_snapshot() {
        assert_eq!(markdown_to_safe_html(RICH_GFM), RICH_HTML);
    }

    #[test]
    fn xss_payload_html_snapshot() {
        assert_eq!(
            markdown_to_safe_html("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1))"),
            XSS_HTML
        );
    }

    #[test]
    fn empty_html_snapshot() {
        // SNAPSHOT — regenerate only per update policy above
        assert_eq!(markdown_to_safe_html(""), "");
    }
}
