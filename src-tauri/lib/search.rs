//! Search commands for vault file lookup.
//! Backing scan logic lives in `crate::search`.

use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn search_vault(query: String, state: State<'_, AppState>) -> Result<String, String> {
    // File scan can take a moment on large vaults — off the main thread. Clone
    // the shared handle, not the vault (Vault is Send but not Sync), so the
    // blocking task reuses the open vault instead of rebuilding it from root.
    let vault = state.vault.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = vault.lock().map_err(|_| "Vault lock poisoned".to_string())?;
        let Some(v) = guard.as_ref() else { return Ok("[]".to_string()) };
        serde_json::to_string(&crate::search::search_vault(v, &query)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
