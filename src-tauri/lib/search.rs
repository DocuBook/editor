//! Search commands — vault keyword search + AI system-prompt grounding.
//! Backing scan logic lives in `crate::search`.

use tauri::State;
use crate::AppState;

#[tauri::command]
pub async fn search_vault(query: String, state: State<'_, AppState>) -> Result<String, String> {
    let root = match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.root().to_path_buf(),
        None => return Ok("[]".to_string()),
    };
    // File scan can take a moment on large vaults — off the main thread.
    let results = tauri::async_runtime::spawn_blocking(move || crate::search::search_vault(&root, &query))
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&results).map_err(|e| e.to_string())
}

// ── AI Grounding ──
/// Resolve wikilinks + search the vault for AI system-prompt grounding.
/// Extracts [[links]] from the user query, resolves each via the wiki index,
/// reads their content, also runs a filename search on the remaining text,
/// and returns a compact markdown context block (token-budgeted).
#[tauri::command]
pub fn ai_grounding_context(query: String, active_path: String, state: State<AppState>) -> Result<String, String> {
    let vault = state.vault.lock().expect("lock");
    let v = match vault.as_ref() { Some(v) => v, None => return Ok(String::new()) };

    // Read-per-file grounding (PI-style): keyword terms from the prompt find
    // related .md files (OR match), then read a token-budgeted slice. No
    // wikilink index / semantic search — just grep-for-related + read.
    let stop = ["the","and","for","with","from","into","about","that","this","what","how","why","when","where","using","make","write","create","like",];
    let text = query.replace("[[", " ").replace("]]", " ");
    let terms: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 3 && !stop.contains(t))
        .map(|t| t.to_lowercase())
        .collect();
    if terms.is_empty() { return Ok(String::new()); }
    let refs: Vec<&str> = terms.iter().map(String::as_str).collect();
    let results = crate::search::search_vault_terms(v.root(), &refs);

    let mut context = String::new();
    for r in results.iter().take(3) {
        if r.path == active_path { continue; }
        if let Ok(content) = v.read_file(&r.path) {
            let trimmed = trim_to_tokens(&content, 2000);
            let name = std::path::Path::new(&r.path).file_stem().map(|s| s.to_string_lossy()).unwrap_or_default();
            context.push_str(&format!("\n\n## {name}\n(File: {})\n{trimmed}", r.path));
        }
    }
    Ok(context)
}

/// Trim markdown to roughly `max_chars` while keeping structural integrity
/// (break at paragraph/heading boundary, never mid-word).
fn trim_to_tokens(content: &str, max_chars: usize) -> String {
    if content.len() <= max_chars { return content.to_string(); }
    let mut at = max_chars;
    // back up to the nearest double-newline (paragraph boundary)
    if let Some(pos) = content[..at].rfind("\n\n") { at = pos; }
    else if let Some(pos) = content[..at].rfind('\n') { at = pos; }
    else if let Some(pos) = content[..at].rfind(". ") { at = pos + 1; }
    format!("{}...", &content[..at])
}
