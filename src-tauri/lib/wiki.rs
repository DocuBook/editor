//! Wiki commands — wikilink suggestions, backlinks, and title resolution.
//! Backing index logic lives in `crate::wiki` (`WikiIndex`).

use tauri::State;
use crate::AppState;

#[tauri::command]
pub fn wiki_suggest(query: String, state: State<AppState>) -> Result<String, String> {
    // Only the root is copied out under the vault lock: the suggestion scan reads
    // markdown files, and holding the vault mutex across it would stall every
    // other vault command while the user types.
    let root = match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.root().to_path_buf(),
        None => return Ok("[]".to_string()),
    };
    match state.wiki.lock().expect("lock").as_ref() {
        Some(w) => serde_json::to_string(&w.suggest(&root, &query)).map_err(|e| e.to_string()),
        None => Ok("[]".to_string()),
    }
}

#[tauri::command]
pub fn wiki_backlinks(path: &str, state: State<AppState>) -> Result<String, String> {
    let root = match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.root().to_path_buf(),
        None => return Ok("[]".to_string()),
    };
    match state.wiki.lock().expect("lock").as_ref() {
        Some(w) => serde_json::to_string(&w.backlinks(&root, path)).map_err(|e| e.to_string()),
        None => Ok("[]".to_string()),
    }
}

#[tauri::command]
pub fn wiki_resolve(title: String, state: State<AppState>) -> Result<String, String> {
    Ok(match state.wiki.lock().expect("lock").as_ref() {
        Some(w) => w.resolve(&title).unwrap_or_default(),
        None => String::new(),
    })
}
