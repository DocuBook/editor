//! Search commands for vault file lookup.
//! Backing scan logic lives in `crate::search`.

use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn search_vault(query: String, state: State<'_, AppState>) -> Result<String, String> {
    let root = match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.root().to_path_buf(),
        None => return Ok("[]".to_string()),
    };
    // File scan can take a moment on large vaults — off the main thread.
    let results =
        tauri::async_runtime::spawn_blocking(move || crate::search::search_vault(&root, &query))
            .await
            .map_err(|e| e.to_string())?;
    serde_json::to_string(&results).map_err(|e| e.to_string())
}
