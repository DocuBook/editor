//! Wiki commands — wikilink suggestions, backlinks, and title resolution.
//! Backing index logic lives in `crate::wiki` (`WikiIndex`).

use tauri::State;
use crate::AppState;

#[tauri::command]
pub fn wiki_suggest(query: String, state: State<AppState>) -> Result<String, String> {
    // Vault lock before wiki lock — the order every nested path uses.
    let vault = state.vault.lock().expect("lock");
    let Some(v) = vault.as_ref() else { return Ok("[]".to_string()) };
    match state.wiki.lock().expect("lock").as_ref() {
        Some(w) => serde_json::to_string(&w.suggest(v, &query)).map_err(|e| e.to_string()),
        None => Ok("[]".to_string()),
    }
}

#[tauri::command]
pub fn wiki_backlinks(path: &str, state: State<AppState>) -> Result<String, String> {
    let vault = state.vault.lock().expect("lock");
    let Some(v) = vault.as_ref() else { return Ok("[]".to_string()) };
    match state.wiki.lock().expect("lock").as_ref() {
        Some(w) => serde_json::to_string(&w.backlinks(v, path)).map_err(|e| e.to_string()),
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
