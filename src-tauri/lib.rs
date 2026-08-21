//! docubook desktop backend.
//!
//! Layout: Tauri commands live under `lib/` (one module per responsibility,
//! each with its own unit tests); this file only owns shared state and the
//! app bootstrap (`run`).

// Backing logic modules (file system, git, wiki index, search, agent, ...).
mod vault;
mod wiki;
mod git;
mod search;
mod agent;
mod keychain;
mod markdown;

// Command layer — one module per responsibility. Files live in `lib/`;
// the module is named `commands` because `lib` collides with the crate root
// (lib.rs). Commands are referenced by full path in `generate_handler!`
// (tauri resolves each to its `__cmd__` wrapper macro inside the module).
#[path = "lib/mod.rs"]
mod commands;

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

/// Shared application state — one vault/wiki/git session at a time.
pub(crate) struct AppState {
    pub(crate) vault: Mutex<Option<vault::Vault>>,
    pub(crate) wiki: Mutex<Option<wiki::WikiIndex>>,
    pub(crate) git: Mutex<Option<git::Git>>,
    pub(crate) ai_cancel: AtomicBool,
    /** Set when the frontend confirmed it is safe to close (graceful shutdown). */
    pub(crate) closing: AtomicBool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                eprintln!("[docubook] window theme at startup: {:?}", w.theme());
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { vault: Mutex::new(None), wiki: Mutex::new(None), git: Mutex::new(None), ai_cancel: AtomicBool::new(false), closing: AtomicBool::new(false) })
        .on_window_event(|window, event| {
            // Graceful shutdown: ask the frontend to flush & save, then confirm.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if state.closing.swap(true, Ordering::SeqCst) {
                    return; // already confirmed by the frontend — allow close
                }
                let _ = window.emit("app:before-close", ());
                api.prevent_close();
                // Fallback: force close if the frontend never confirms (e.g. crashed).
                let win = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if !win.state::<AppState>().closing.load(Ordering::SeqCst) {
                        let _ = win.close();
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault::open_vault, commands::vault::close_vault, commands::vault::create_vault, commands::git::git_clone, commands::vault::list_tree, commands::vault::read_file, commands::vault::read_file_binary, commands::vault::write_file, commands::vault::create_file, commands::vault::delete_file, commands::vault::rename_file, commands::vault::create_directory,
            commands::git::git_settings, commands::git::git_add_remote, commands::git::git_remove_remote, commands::git::git_set_identity, commands::git::git_init,
            commands::wiki::wiki_backlinks, commands::wiki::wiki_suggest, commands::wiki::wiki_resolve, commands::search::search_vault, commands::git::git_stage, commands::git::git_push, commands::git::git_status,
            commands::agent::custom_ai_config,
            commands::markdown::md_to_html, commands::agent::ask_ai, commands::agent::cancel_ai, commands::agent::set_api_key, commands::agent::set_custom_endpoint, commands::agent::delete_api_key, commands::agent::list_api_keys, commands::agent::test_connection, commands::agent::list_models,
            commands::search::ai_grounding_context, commands::app::health, commands::app::app_ready_to_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
