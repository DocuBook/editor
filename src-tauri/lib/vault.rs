//! Vault lifecycle + file operation commands.
//!
//! Responsibility: open/close/create a vault session and all CRUD file
//! operations inside it. Backing logic lives in `crate::vault` (the `Vault`
//! filesystem wrapper); this module only wires it to Tauri IPC.

use tauri::State;
use crate::AppState;

/** Rebuild the wiki index after a file mutation. The index is a snapshot taken
 *  at open_vault — without this, suggest/backlinks/resolve stay stale until a
 *  hard refresh (reopen) reads new files. Cheap enough per save on desktop. */
fn rescan_wiki(state: &State<'_, AppState>) {
    if let Some(w) = state.wiki.lock().expect("lock").as_mut() {
        w.scan();
    }
}

/** Validate a vault folder name (no separators, no traversal). */
fn valid_vault_name(name: &str) -> bool {
    !name.is_empty() && name != "." && !name.contains("..") && !name.contains('/') && !name.contains('\\')
}

#[tauri::command]
pub fn open_vault(path: &str, state: State<AppState>) -> Result<String, String> {
    let v = crate::vault::Vault::new(path)?;
    let name = v.name();
    let mut w = crate::wiki::WikiIndex::new(v.root()); w.scan();
    eprintln!("[docubook] open_vault: {} (git repo: {})", path, std::path::Path::new(path).join(".git").exists());
    let g = crate::git::Git::open(path);
    *state.vault.lock().expect("lock") = Some(v);
    *state.wiki.lock().expect("lock") = Some(w);
    *state.git.lock().expect("lock") = Some(g);
    Ok(format!(r#"{{"name":"{}"}}"#, name))
}

#[tauri::command]
pub fn create_vault(parent: &str, name: &str, state: State<AppState>) -> Result<String, String> {
    if !valid_vault_name(name) { return Err("Invalid vault name".to_string()); }
    let dir = std::path::Path::new(parent).join(name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    open_vault(dir.to_str().ok_or("Invalid path")?, state)
}

#[tauri::command]
pub fn close_vault(state: State<AppState>) -> Result<(), String> {
    *state.vault.lock().expect("lock") = None; *state.wiki.lock().expect("lock") = None; *state.git.lock().expect("lock") = None; Ok(())
}

#[tauri::command]
pub fn list_tree(subpath: String, state: State<AppState>) -> Result<String, String> {
    match state.vault.lock().expect("lock").as_ref() {
        Some(v) => serde_json::to_string(&v.tree(&subpath)).map_err(|e| e.to_string()),
        None => Ok("[]".to_string()),
    }
}

#[tauri::command]
pub fn read_file(path: &str, state: State<AppState>) -> Result<String, String> {
    match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.read_file(path), None => Err("No vault".to_string())
    }
}

#[tauri::command]
pub fn read_file_binary(path: &str, state: State<AppState>) -> Result<String, String> {
    match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.read_file_binary(path), None => Err("No vault".to_string())
    }
}

#[tauri::command]
pub fn write_file(path: &str, content: &str, state: State<AppState>) -> Result<(), String> {
    let r = match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.write_file(path, content), None => Err("No vault".to_string())
    };
    if r.is_ok() { rescan_wiki(&state); }
    r
}

#[tauri::command]
pub fn create_file(path: &str, state: State<AppState>) -> Result<String, String> {
    let r = match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.create_file(path), None => Err("No vault".to_string())
    };
    if r.is_ok() { rescan_wiki(&state); }
    r
}

#[tauri::command]
pub fn create_directory(path: &str, state: State<AppState>) -> Result<(), String> {
    match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.create_directory(path), None => Err("No vault".to_string())
    }
}

#[tauri::command]
pub fn delete_file(path: &str, state: State<AppState>) -> Result<(), String> {
    let r = match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.delete_file(path), None => Err("No vault".to_string())
    };
    if r.is_ok() { rescan_wiki(&state); }
    r
}

#[tauri::command]
pub fn rename_file(from: &str, to: &str, state: State<AppState>) -> Result<(), String> {
    let r = match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.rename_file(from, to), None => Err("No vault".to_string())
    };
    if r.is_ok() { rescan_wiki(&state); }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_name_validation() {
        assert!(valid_vault_name("my vault"));
        assert!(!valid_vault_name(""));
        assert!(!valid_vault_name("."));
        assert!(!valid_vault_name(".."));
        assert!(!valid_vault_name("../evil"));
        assert!(!valid_vault_name("a/b"));
        assert!(!valid_vault_name("a\\b"));
    }
}
