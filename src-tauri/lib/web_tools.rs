//! Settings for rust-ai's built-in web tools (`web_search`, `web_fetch`).
//!
//! Non-secret settings live in `web-tools.json` next to the other app config;
//! the Tavily key lives in the Keychain under `search:tavily`.

use tauri::Manager;

use crate::rust_ai::web::{self, WebToolsSettings, MAX_RESULTS_LIMIT};

/// Keychain account holding the Tavily API key.
pub const TAVILY_KEY_ACCOUNT: &str = "search:tavily";
/// Longest API key accepted from Settings.
const MAX_KEY_LEN: usize = 512;

/// Path of the persisted non-secret settings, creating the config dir.
fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("web-tools.json"))
}

/// Load the persisted settings; missing or unreadable files mean "all off".
fn load_settings(app: &tauri::AppHandle) -> WebToolsSettings {
    settings_path(app)
        .ok()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|raw| serde_json::from_slice::<WebToolsSettings>(&raw).ok())
        .filter(|settings| settings.validate().is_ok())
        .unwrap_or_default()
}

/// Push settings plus the stored key into the shared runtime.
fn apply(settings: WebToolsSettings) -> Result<(), String> {
    let key = crate::keychain::get_key(TAVILY_KEY_ACCOUNT).ok();
    web::set_config(settings.into_config(key))
}

/// Load persisted settings into the runtime at startup.
pub fn initialize_web_tools(app: &tauri::AppHandle) -> Result<(), String> {
    apply(load_settings(app))
}

/// Return the settings for the Settings pane; the key is reported, never sent.
#[tauri::command]
pub fn web_tools_settings(app: tauri::AppHandle) -> Result<String, String> {
    let settings = load_settings(&app);
    serde_json::to_string(&serde_json::json!({
        "settings": settings,
        "hasTavilyKey": crate::keychain::get_key(TAVILY_KEY_ACCOUNT).is_ok(),
        "envManaged": false,
        "maxResultsLimit": MAX_RESULTS_LIMIT,
    }))
    .map_err(|e| e.to_string())
}

/// Validate, persist and apply new settings; the file is restored on failure.
#[tauri::command]
pub fn set_web_tools_settings(app: tauri::AppHandle, settings: WebToolsSettings) -> Result<(), String> {
    settings.validate()?;
    let path = settings_path(&app)?;
    let previous = std::fs::read(&path).ok();
    std::fs::write(&path, serde_json::to_vec(&settings).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if let Err(error) = apply(settings) {
        let _ = match &previous {
            Some(contents) => std::fs::write(&path, contents),
            None => std::fs::remove_file(&path),
        };
        return Err(error);
    }
    Ok(())
}

/// Store the Tavily API key in the Keychain and apply it.
#[tauri::command]
pub fn set_web_search_key(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() || key.len() > MAX_KEY_LEN || key.chars().any(char::is_control) {
        return Err("Enter a valid Tavily API key".into());
    }
    crate::keychain::set_key(TAVILY_KEY_ACCOUNT, key)?;
    apply(load_settings(&app))
}

/// Remove the Tavily API key; Tavily search stops until a new key is saved.
#[tauri::command]
pub fn delete_web_search_key(app: tauri::AppHandle) -> Result<(), String> {
    if crate::keychain::get_key(TAVILY_KEY_ACCOUNT).is_ok() {
        crate::keychain::delete_key(TAVILY_KEY_ACCOUNT)?;
    }
    apply(load_settings(&app))
}
