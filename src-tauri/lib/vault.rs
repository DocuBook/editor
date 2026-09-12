use tauri::State;
use crate::AppState;

#[cfg(target_os = "macos")]
fn run_osascript(language: Option<&str>, script: &str, args: &[&str]) -> Result<String, String> {
    let mut command = std::process::Command::new("osascript");
    if let Some(language) = language { command.args(["-l", language]); }
    let output = command.arg("-e").arg(script).arg("--").args(args).output().map_err(|e| format!("Trash: {e}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let error = String::from_utf8_lossy(&output.stderr);
    if error.contains("not allowed to send keystrokes") {
        return Err("Put Back requires DocuBook Editor access in System Settings > Privacy & Security > Accessibility".to_string());
    }
    if error.contains("Not authorized") || error.contains("-1743") {
        return Err("Trash access requires DocuBook Editor permission in System Settings > Privacy & Security > Automation".to_string());
    }
    Err(format!("Trash: {}", error.trim()))
}

#[cfg(target_os = "macos")]
fn list_system_trash() -> Result<String, String> {
    run_osascript(Some("JavaScript"), r#"
const finder = Application("Finder")
const entries = finder.trash.items().map(item => {
  try {
    const properties = item.properties()
    return {
      name: item.url(),
      original: item.name(),
      deleted_at: 0,
      is_dir: String(properties.class).toLowerCase().includes("folder")
    }
  } catch (_) { return null }
}).filter(Boolean).sort((a, b) => b.deleted_at - a.deleted_at)
JSON.stringify(entries)
"#, &[])
}

#[cfg(target_os = "macos")]
fn restore_system_trash_item(url: &str) -> Result<(), String> {
    run_osascript(None, r#"
on run argv
  set targetURL to item 1 of argv
  tell application "Finder"
    set matches to every item of trash whose URL is targetURL
    if (count of matches) is not 1 then error "Trash item not found"
    activate
    open trash
    set selection to {item 1 of matches}
  end tell
  delay 0.2
  tell application "System Events" to key code 51 using command down
  delay 0.5
  tell application "Finder"
    if (count of (every item of trash whose URL is targetURL)) is not 0 then error "Put Back failed. The original location may already contain an item with this name."
  end tell
end run
"#, &[url]).map(|_| ())
}

#[cfg(target_os = "macos")]
fn delete_system_trash_item(url: &str) -> Result<(), String> {
    run_osascript(Some("JavaScript"), r#"
function run(argv) {
  const finder = Application("Finder")
  const matches = finder.trash.items().filter(item => {
    try { return item.url() === argv[0] } catch (_) { return false }
  })
  if (matches.length !== 1) throw new Error("Trash item not found")
  finder.delete(matches[0])
}
"#, &[url]).map(|_| ())
}

#[cfg(target_os = "macos")]
fn empty_system_trash() -> Result<(), String> {
    run_osascript(None, "tell application \"Finder\" to empty trash", &[]).map(|_| ())
}

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
pub fn list_trash(state: State<AppState>) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    { let _ = state; list_system_trash() }
    #[cfg(not(target_os = "macos"))]
    { match state.vault.lock().expect("lock").as_ref() {
        Some(v) => serde_json::to_string(&v.list_trash()).map_err(|e| e.to_string()),
        None => Ok("[]".to_string()),
    } }
}

#[tauri::command]
pub fn restore_file(trash_name: &str, state: State<AppState>, window: tauri::Window) -> Result<(), String> {
    let result = {
        #[cfg(target_os = "macos")]
        { restore_system_trash_item(trash_name) }
        #[cfg(not(target_os = "macos"))]
        { match state.vault.lock().expect("lock").as_ref() {
            Some(v) => v.restore_file(trash_name), None => Err("No vault".to_string()),
        } }
    };
    if result.is_ok() {
        rescan_wiki(&state);
        let _ = window.set_focus();
    }
    result
}

#[tauri::command]
pub fn delete_trash_item(trash_name: &str, state: State<AppState>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { let _ = state; delete_system_trash_item(trash_name) }
    #[cfg(not(target_os = "macos"))]
    { match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.delete_trash_item(trash_name), None => Err("No vault".to_string()),
    } }
}

#[tauri::command]
pub fn empty_trash(state: State<AppState>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { let _ = state; empty_system_trash() }
    #[cfg(not(target_os = "macos"))]
    { match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.empty_trash(), None => Err("No vault".to_string()),
    } }
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
