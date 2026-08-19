//! App lifecycle commands — graceful shutdown handshake and health/diagnostics.

use tauri::{Manager, State};
use std::sync::atomic::Ordering;
use crate::AppState;

/** Frontend confirms it saved everything — safe to actually close. */
#[tauri::command]
pub fn app_ready_to_close(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.closing.store(true, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("main") {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/** Minimal health/diagnostics surface (reused by the future cloud service). */
#[tauri::command]
pub fn health(state: State<AppState>) -> Result<String, String> {
    let vault_open = state.vault.lock().expect("lock").is_some();
    let git_repo = state.git.lock().expect("lock").as_ref().map(|g| g.is_repo()).unwrap_or(false);
    Ok(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "vaultOpen": vault_open,
        "gitRepo": git_repo,
    }).to_string())
}
