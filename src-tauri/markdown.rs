/*! Markdown → safe HTML rendering, shared by the desktop app (Tauri
 *  commands in lib.rs) and the web server (server includes this
 *  file via `#[path]`). Single source of truth — the snapshot tests in
 *  lib.rs cover this module for both binaries. */

/** Markdown-family extensions handled by the editor (CommonMark + frontmatter).
 *  Single source of truth for .md/.mdx handling across tree, search, wiki,
 *  and file-classification — keep in sync with frontend/utils/fileKind.ts. */
pub const MARKDOWN_EXTENSIONS: [&str; 2] = [".md", ".mdx"];

/** True when a file NAME is a markdown-family file (.md/.mdx, case-insensitive).
 *  Accepts full names ("notes.md") or bare extensions ("md"). */
pub fn is_markdown_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    MARKDOWN_EXTENSIONS.iter().any(|e| lower.ends_with(e) || lower == e.trim_start_matches('.'))
}

/** Strip the markdown extension from a file name (".md" / ".mdx"). */
pub fn strip_markdown_ext(name: &str) -> &str {
    for e in MARKDOWN_EXTENSIONS.iter() {
        if name.to_ascii_lowercase().ends_with(e) {
            return &name[..name.len() - e.len()];
        }
    }
    name
}

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
