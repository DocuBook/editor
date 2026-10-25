//! Web-server side of rust-ai's built-in web tools (`web_search`, `web_fetch`).
//!
//! Non-secret settings live in `config.json` (`webTools`), the Tavily key in
//! `keys.json` (`search:tavily`). Docker operators can pin the search provider
//! with `DOCUBOOK_SEARXNG_URL` or `DOCUBOOK_TAVILY_API_KEY`.

use serde_json::Value;

use super::{keys, rust_ai, AppState};
use rust_ai::web::{SearchProvider, WebToolsSettings, MAX_RESULTS_LIMIT};

/// keys.json entry holding the Tavily API key.
pub const TAVILY_KEY_ACCOUNT: &str = "search:tavily";
const SEARXNG_ENV: &str = "DOCUBOOK_SEARXNG_URL";
const TAVILY_ENV: &str = "DOCUBOOK_TAVILY_API_KEY";
/// Longest API key accepted from Settings.
const MAX_KEY_LEN: usize = 512;

/// Read a non-empty environment variable.
fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
}

/// Report whether the environment pins the search provider.
pub fn env_managed() -> bool {
    env(SEARXNG_ENV).is_some() || env(TAVILY_ENV).is_some()
}

/// Push the effective configuration (environment over config.json) into the runtime.
pub fn configure(state: &AppState) -> Result<(), String> {
    let settings = state.auth.config.lock().unwrap_or_else(|e| e.into_inner()).web_tools.clone();
    let mut config = settings.into_config(keys::get_key(&state.data_dir, TAVILY_KEY_ACCOUNT).ok());
    if let Some(base_url) = env(SEARXNG_ENV) {
        rust_ai::web::validate_searxng_url(&base_url).map_err(|error| format!("{SEARXNG_ENV}: {error}"))?;
        config.search = SearchProvider::Searxng { base_url };
    } else if let Some(api_key) = env(TAVILY_ENV) {
        config.search = SearchProvider::Tavily { api_key };
    }
    rust_ai::web::set_config(config)
}

/// Settings for the dashboard; the key is reported, never returned.
pub fn settings_json(state: &AppState) -> Result<String, String> {
    let mut settings = state.auth.config.lock().unwrap_or_else(|e| e.into_inner()).web_tools.clone();
    if let Some(url) = env(SEARXNG_ENV) {
        settings.search_provider = "searxng".into();
        settings.searxng_url = url;
    } else if env(TAVILY_ENV).is_some() {
        settings.search_provider = "tavily".into();
    }
    serde_json::to_string(&serde_json::json!({
        "settings": settings,
        "hasTavilyKey": env(TAVILY_ENV).is_some() || keys::get_key(&state.data_dir, TAVILY_KEY_ACCOUNT).is_ok(),
        "envManaged": env_managed(),
        "maxResultsLimit": MAX_RESULTS_LIMIT,
    }))
    .map_err(|e| e.to_string())
}

/// Validate, persist and apply new settings, restoring the old ones on failure.
pub fn set_settings(state: &AppState, args: &Value) -> Result<String, String> {
    let settings: WebToolsSettings = serde_json::from_value(args.get("settings").cloned().unwrap_or(Value::Null))
        .map_err(|_| "Invalid web tools settings".to_string())?;
    settings.validate()?;
    let mut cfg = state.auth.config.lock().unwrap_or_else(|e| e.into_inner());
    if env_managed() && settings.search_provider != cfg.web_tools.search_provider {
        return Err(format!("The search provider is controlled by {SEARXNG_ENV} / {TAVILY_ENV}"));
    }
    let previous = std::mem::replace(&mut cfg.web_tools, settings);
    if let Err(error) = cfg.save() {
        cfg.web_tools = previous;
        return Err(error);
    }
    drop(cfg);
    if let Err(error) = configure(state) {
        let mut cfg = state.auth.config.lock().unwrap_or_else(|e| e.into_inner());
        cfg.web_tools = previous;
        let _ = cfg.save();
        return Err(error);
    }
    Ok("null".into())
}

/// Store the Tavily key in keys.json and apply it.
pub fn set_key(state: &AppState, args: &Value) -> Result<String, String> {
    if env(TAVILY_ENV).is_some() {
        return Err(format!("The Tavily key is controlled by {TAVILY_ENV}"));
    }
    let key = args.get("key").and_then(Value::as_str).unwrap_or_default().trim();
    if key.is_empty() || key.len() > MAX_KEY_LEN || key.chars().any(char::is_control) {
        return Err("Enter a valid Tavily API key".into());
    }
    keys::set_key(&state.data_dir, TAVILY_KEY_ACCOUNT, key)?;
    configure(state).map(|_| "null".into())
}

/// Remove the Tavily key from keys.json.
pub fn delete_key(state: &AppState) -> Result<String, String> {
    if env(TAVILY_ENV).is_some() {
        return Err(format!("The Tavily key is controlled by {TAVILY_ENV}"));
    }
    if keys::get_key(&state.data_dir, TAVILY_KEY_ACCOUNT).is_ok() {
        keys::delete_key(&state.data_dir, TAVILY_KEY_ACCOUNT)?;
    }
    configure(state).map(|_| "null".into())
}

/// URL strings from a `urlSources` argument, ignoring anything else.
pub fn url_sources(args: &Value) -> Vec<String> {
    args.get("urlSources")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}
