//! API-key storage for the web build.
//!
//! Desktop uses the macOS Keychain (`src-tauri/src/keychain.rs`); the web
//! server runs on Linux where that doesn't exist, so keys live in a JSON file
//! inside the data dir (`keys.json`, mode 0600). Same security model as the
//! desktop build: keys are written by the user, read server-side only, and
//! never sent to the browser.

use std::collections::HashMap;
use std::path::Path;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn keys_file(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("keys.json")
}

fn load(data_dir: &Path) -> HashMap<String, String> {
    std::fs::read_to_string(keys_file(data_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(data_dir: &Path, map: &HashMap<String, String>) -> Result<(), String> {
    let path = keys_file(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    Ok(())
}

pub fn get_key(data_dir: &Path, provider: &str) -> Result<String, String> {
    load(data_dir).get(provider).cloned().ok_or_else(|| "not_found".to_string())
}

pub fn set_key(data_dir: &Path, provider: &str, key: &str) -> Result<(), String> {
    let mut map = load(data_dir);
    map.insert(provider.to_string(), key.to_string());
    save(data_dir, &map)
}

pub fn delete_key(data_dir: &Path, provider: &str) -> Result<(), String> {
    let mut map = load(data_dir);
    map.remove(provider);
    save(data_dir, &map)
}

/** Providers that already have a saved key. */
pub fn list_keys(data_dir: &Path, providers: &[String]) -> Vec<String> {
    let map = load(data_dir);
    providers.iter().filter(|p| map.contains_key(*p)).cloned().collect()
}
