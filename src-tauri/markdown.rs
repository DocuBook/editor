/*! Markdown → safe HTML rendering, shared by the desktop app (Tauri
 *  commands in lib.rs) and the web server (server includes this
 *  file via `#[path]`). Single source of truth — the snapshot tests in
 *  lib.rs cover this module for both binaries. */

/** Render markdown to HTML with raw HTML DISABLED, then sanitize — closes
 *  stored-XSS via raw tags, event handlers, and javascript: URLs. */
pub fn markdown_to_safe_html(content: &str) -> String {
    let mut options = pulldown_cmark::Options::empty();
    options.insert(pulldown_cmark::Options::ENABLE_STRIKETHROUGH);
    options.insert(pulldown_cmark::Options::ENABLE_TABLES);
    options.insert(pulldown_cmark::Options::ENABLE_TASKLISTS);
    // Raw HTML is NOT enabled — inline <script>/<img onerror> become escaped text.
    let parser = pulldown_cmark::Parser::new_ext(content, options);
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, parser);
    // Defense in depth: strip anything ammonia's allowlist does not permit
    // (script, iframe, event handlers, javascript: URLs).
    ammonia::clean(&html)
}

/** Preview wrapper used by both the desktop command and the web API. */
pub fn markdown_preview(content: &str) -> String {
    format!(r#"<div class="prose prose-invert max-w-none px-4 py-4 text-sm">{}</div>"#, markdown_to_safe_html(content))
}
