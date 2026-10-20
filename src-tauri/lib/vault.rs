use std::path::Path;
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
    /* macOS gates these behind a one-time grant, and the error text is the only
     * signal that distinguishes "not allowed yet" from a real failure. Prefix the
     * message with a stable code so the UI can offer the matching System Settings
     * deep link instead of a dead-end toast. */
    if error.contains("not allowed to send keystrokes") || error.contains("-1743") || error.contains("Not authorized") {
        return Err(format!("{TRASH_PERMISSION_PREFIX}{}", permission_settings_hint(&error)));
    }
    Err(format!("Trash: {}", error.trim()))
}

/** Permission-scoped trash failures carry this prefix so the frontend can tell
 *  them apart from ordinary command errors and deep-link the right pane. */
pub(crate) const TRASH_PERMISSION_PREFIX: &str = "TRASH_PERMISSION:";

/** Map an osascript permission failure to the System Settings pane the user must
 *  grant. Keystroke automation (Finder "Put Back" via ⌘⌫) needs Accessibility;
 *  talking to Finder itself needs Automation. */
#[cfg(target_os = "macos")]
fn permission_settings_hint(error: &str) -> &'static str {
    if error.contains("not allowed to send keystrokes") { "accessibility" }
    else { "automation" }
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

/** Rebuild the wiki index after a file mutation. The index is a snapshot taken
 *  at open_vault — without this, suggest/backlinks/resolve stay stale until a
 *  hard refresh (reopen) reads new files. Cheap enough per save on desktop.
 *
 *  The vault lock only covers the file list: the content scan reads every
 *  markdown file, and holding the vault mutex across it would stall tree/read/
 *  search on every save. */
fn rescan_wiki(state: &State<'_, AppState>) {
    let files = {
        let vault = state.vault.lock().expect("lock");
        let Some(v) = vault.as_ref() else { return };
        v.markdown_files()
    };
    if let Some(w) = state.wiki.lock().expect("lock").as_mut() {
        w.scan(files);
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
    // Markdown list is shared, not copied: the index takes the same cached
    // `Arc` the search command will use. Link extraction is deferred (see
    // `WikiIndex`), so open pays for enumeration only, not for reading every note.
    let mut w = crate::wiki::WikiIndex::new(); w.scan(v.markdown_files());
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
pub async fn resolve_mentions(request: crate::vault::mentions::ResolveRequest, state: State<'_, AppState>) -> Result<String, String> {
    use crate::vault::mentions::{Bundle, resolve};
    if request.mentions.is_empty() { return serde_json::to_string(&Bundle::default()).map_err(|e| e.to_string()); }
    // Clone the shared handle, not the vault: the blocking task locks the open
    // vault (Vault is Send but not Sync, so it cannot be borrowed across threads).
    let vault = state.vault.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = vault.lock().map_err(|_| "Vault lock poisoned".to_string())?;
        let Some(v) = guard.as_ref() else { return serde_json::to_string(&Bundle::default()).map_err(|e| e.to_string()); };
        serde_json::to_string(&resolve(v, request)).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
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

/// Content version (`None` when absent) for optimistic-concurrency edits.
#[tauri::command]
pub fn file_version(path: &str, state: State<AppState>) -> Result<Option<String>, String> {
    match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.version_of(path), None => Err("No vault".to_string())
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

/// Guarded write used by the editor: rejects the write instead of clobbering a
/// file that changed since the caller read it. `baseVersion` is the token from
/// `file_version`/`read_file`; `null` means "expected to be new". Returns a JSON
/// `WriteOutcome` so the caller can branch on `status`.
#[tauri::command]
pub fn write_file_checked(
    path: &str,
    content: &str,
    base_version: Option<String>,
    state: State<AppState>,
) -> Result<String, String> {
    let outcome = match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.write_file_checked(path, content, base_version.as_deref()),
        None => Err("No vault".to_string()),
    }?;
    if matches!(outcome, crate::vault::WriteOutcome::Written { .. }) { rescan_wiki(&state); }
    serde_json::to_string(&outcome).map_err(|e| e.to_string())
}

/// Read the WYSIWYG-only snapshot for `path` (empty string when absent). A
/// disposable cache: the editor applies it only while its stored Markdown still
/// matches the file, so a missing/stale snapshot just means "no formatting".
#[tauri::command]
pub fn read_wysiwyg_snapshot(path: &str, state: State<AppState>) -> Result<String, String> {
    match state.vault.lock().expect("lock").as_ref() {
        Some(v) => Ok(v.read_snapshot(path)?.unwrap_or_default()),
        None => Ok(String::new()),
    }
}

/// Write the WYSIWYG-only snapshot for `path`. Never rescans the wiki and never
/// invalidates the tree/search caches — the snapshot directory is an ignored
/// entry and this is not a Markdown file.
#[tauri::command]
pub fn write_wysiwyg_snapshot(path: &str, content: &str, state: State<AppState>) -> Result<(), String> {
    match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.write_snapshot(path, content),
        None => Err("No vault".to_string()),
    }
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

/** Copy a file or directory into a destination folder. The vault resolves name
 *  collisions itself; the returned path is where the copy landed. */
#[tauri::command]
pub fn copy_path(from: &str, to_dir: &str, state: State<AppState>) -> Result<String, String> {
    let r = match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.copy_path(from, to_dir), None => Err("No vault".to_string())
    };
    if r.is_ok() { rescan_wiki(&state); }
    r
}

/** Move a file or directory into a destination folder. A name collision is
 *  refused (the vault reports it); the returned path is where it landed. */
#[tauri::command]
pub fn move_path(from: &str, to_dir: &str, state: State<AppState>) -> Result<String, String> {
    let r = match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.move_path(from, to_dir), None => Err("No vault".to_string())
    };
    if r.is_ok() { rescan_wiki(&state); }
    r
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
pub fn rename_file(from: &str, to: &str, state: State<AppState>) -> Result<(), String> {
    let r = match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.rename_file(from, to), None => Err("No vault".to_string())
    };
    if r.is_ok() { rescan_wiki(&state); }
    r
}

/** macOS System Settings panes the app can deep-link to. `open "x-apple.systempreferences:…"`
 *  is the documented way to land the user directly on the pane they must toggle —
 *  far better UX than telling them to navigate Privacy & Security by hand. */
#[cfg(target_os = "macos")]
fn system_settings_url(pane: &str) -> Option<&'static str> {
    match pane {
        "accessibility" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"),
        "automation" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"),
        "files" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"),
        _ => None,
    }
}

/** Open a System Settings pane. macOS opens the URL; other platforms (and the
 *  web build, which never calls this) report unsupported so the UI can fall back
 *  to plain instructions. */
#[tauri::command]
pub fn open_system_settings(pane: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url = system_settings_url(pane).ok_or_else(|| format!("Unknown settings pane: {pane}"))?;
        std::process::Command::new("open")
            .arg(url)
            .status()
            .map_err(|e| format!("Could not open System Settings: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = pane; Err("System Settings deep links are macOS-only".to_string()) }
}

/** Path spec from `$VISUAL` / `$EDITOR`, split into program + arguments. No shell
 *  is involved, so command chaining in the variable is never executed. A GUI
 *  editor spec often points inside an `.app` bundle, whose path contains spaces —
 *  an existing whole path is therefore taken as the program, unsplit. */
fn editor_command(spec: &str) -> Option<(String, Vec<String>)> {
    let trimmed = spec.trim();
    if Path::new(trimmed).exists() { return Some((trimmed.to_string(), Vec::new())); }
    let mut parts = trimmed.split_whitespace();
    let program = parts.next()?.to_string();
    Some((program, parts.map(str::to_string).collect()))
}

fn jxa_args(script: &str, paths: &[&Path]) -> Vec<std::ffi::OsString> {
    ["-l", "JavaScript", "-e", script]
        .into_iter()
        .map(std::ffi::OsString::from)
        .chain(paths.iter().map(|path| path.as_os_str().to_owned()))
        .collect()
}

/** One detected editor: the app that can take the vault folder as a project. */
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct EditorApp { pub name: String, pub path: String }

/** macOS apps that can open BOTH the file and its folder — i.e. editors that
 *  accept the whole vault as a project. LaunchServices supplies the list, so no
 *  editor name, CLI or bundle id is hardcoded. */
#[cfg(target_os = "macos")]
fn detected_editors(file: &Path, dir: &Path) -> Vec<EditorApp> {
    const SCRIPT: &str = r#"ObjC.import('AppKit'); function run(argv) {
  const ws = $.NSWorkspace.sharedWorkspace
  const files = ws.URLsForApplicationsToOpenURL($.NSURL.fileURLWithPath(argv[0]))
  const dirs = ws.URLsForApplicationsToOpenURL($.NSURL.fileURLWithPath(argv[1]))
  if (!files || !dirs) return '[]'
  const folders = {}
  for (let i = 0; i < dirs.count; i++) folders[ObjC.unwrap(dirs.objectAtIndex(i).path)] = true
  const out = []
  for (let i = 0; i < files.count; i++) {
    const path = ObjC.unwrap(files.objectAtIndex(i).path)
    if (!folders[path]) continue
    out.push({ path: path, name: path.split('/').pop().replace(/\.app$/, '') })
  }
  return JSON.stringify(out)
}"#;
    let output = match std::process::Command::new("osascript")
        .args(jxa_args(SCRIPT, &[file, dir]))
        .output()
    { Ok(o) if o.status.success() => o, _ => return vec![] };
    serde_json::from_slice::<Vec<EditorApp>>(&output.stdout).unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
fn detected_editors(_file: &Path, _dir: &Path) -> Vec<EditorApp> { vec![] }

/** macOS default application for `path`, read from LaunchServices. Only used
 *  when no folder-capable editor exists, so the file can still be opened. */
#[cfg(target_os = "macos")]
fn default_application(path: &Path) -> Option<String> {
    const SCRIPT: &str = r#"ObjC.import('AppKit'); function run(argv) { const u = $.NSURL.fileURLWithPath(argv[0]); const app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(u); return app ? ObjC.unwrap(app.path) : ''; }"#;
    let output = std::process::Command::new("osascript")
        .args(jxa_args(SCRIPT, &[path]))
        .output()
        .ok()?;
    if !output.status.success() { return None; }
    let app = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!app.is_empty()).then_some(app)
}

#[cfg(target_os = "macos")]
fn open_with_app(app: &str, paths: &[&Path]) -> Result<(), String> {
    let mut command = std::process::Command::new("open");
    command.arg("-a").arg(app);
    for path in paths { command.arg(path); }
    let status = command.status().map_err(|e| format!("Could not open {app}: {e}"))?;
    // `open` exits non-zero when the bundle is missing or refuses the request;
    // returning Ok there would report a success that never happened.
    status.success().then_some(()).ok_or_else(|| format!("Could not open {app}"))
}

/** Open the vault (with `file` focused) in the user's editor. `app` comes from
 *  the detected list, so an explicit choice is honored; otherwise `$VISUAL` /
 *  `$EDITOR` is tried first and a broken CLI (e.g. `code` missing from the GUI
 *  PATH) falls through to detection instead of failing the action. */
fn launch_editor(vault_root: &Path, file: &Path, app: Option<&str>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if let Some(app) = app {
        if !detected_editors(file, vault_root).iter().any(|e| e.path == app) {
            return Err(format!("Editor not available: {app}"));
        }
        return open_with_app(app, &[vault_root, file]);
    }
    // Detection is macOS-only, so an explicit editor choice cannot be honored
    // elsewhere — fail loudly instead of silently opening a different app.
    #[cfg(not(target_os = "macos"))]
    if app.is_some() {
        return Err("Choosing an editor is only supported on macOS".to_string());
    }
    if let Some(spec) = std::env::var("VISUAL").ok().filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("EDITOR").ok().filter(|s| !s.trim().is_empty()))
    {
        if let Some((program, args)) = editor_command(&spec) {
            use std::process::Stdio;
            if std::process::Command::new(&program)
                .args(args)
                .arg(vault_root)
                .arg(file)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .is_ok()
            { return Ok(()); }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(editor) = detected_editors(file, vault_root).first() {
            return open_with_app(&editor.path, &[vault_root, file]);
        }
        // Nothing can take a folder: still open the file rather than dead-end.
        let app = default_application(file).ok_or_else(|| "No application can open this file".to_string())?;
        open_with_app(&app, &[file])
    }
    #[cfg(not(target_os = "macos"))]
    {
        tauri_plugin_opener::open_path(file, None::<&str>)
            .map_err(|e| format!("Could not open file: {e}"))
    }
}

/** Apps that can open this vault as a project, for the Actions menu. */
#[tauri::command]
pub async fn list_editors(path: String, state: State<'_, AppState>) -> Result<Vec<EditorApp>, String> {
    let (root, file) = {
        let vault = state.vault.lock().expect("lock");
        let v = vault.as_ref().ok_or_else(|| "No vault".to_string())?;
        (v.root().to_path_buf(), v.absolute_path(&path)?)
    };
    // LaunchServices is a blocking subprocess call; keep it off the main thread
    // (this runs on every Actions menu open).
    tauri::async_runtime::spawn_blocking(move || detected_editors(&file, &root))
        .await
        .map_err(|e| e.to_string())
}

/** Open a vault file in the user's editor, with the vault as the project root.
 *  Desktop-only: the web runtime has no local editor. */
#[tauri::command]
pub async fn open_in_editor(path: String, app: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    let (root, file) = {
        let vault = state.vault.lock().expect("lock");
        let v = vault.as_ref().ok_or_else(|| "No vault".to_string())?;
        (v.root().to_path_buf(), v.absolute_path(&path)?)
    };
    tauri::async_runtime::spawn_blocking(move || launch_editor(&root, &file, app.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/** Reveal a vault file in the OS file manager (Finder on macOS). Desktop-only. */
#[tauri::command]
pub async fn reveal_in_finder(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let target = {
        let vault = state.vault.lock().expect("lock");
        let v = vault.as_ref().ok_or_else(|| "No vault".to_string())?;
        v.absolute_path(&path)?
    };
    tauri::async_runtime::spawn_blocking(move || {
        tauri_plugin_opener::reveal_item_in_dir(&target).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_command_splits_program_and_arguments() {
        assert_eq!(editor_command("code --wait"), Some(("code".to_string(), vec!["--wait".to_string()])));
        assert_eq!(editor_command("   "), None);
    }

    #[test]
    fn jxa_paths_follow_the_script_without_an_extra_argument() {
        let file = Path::new("/vault/notes/my note.md");
        let dir = Path::new("/vault");
        let args = jxa_args("function run(argv) {}", &[file, dir]);

        assert_eq!(args[0], "-l");
        assert_eq!(args[1], "JavaScript");
        assert_eq!(args[2], "-e");
        assert_eq!(args[3], "function run(argv) {}");
        assert_eq!(args[4], file.as_os_str());
        assert_eq!(args[5], dir.as_os_str());
        assert_eq!(args.len(), 6);
    }

    /** GUI editors live inside `.app` bundles whose paths contain spaces; the
     *  whole existing path must stay one program instead of splitting apart. */
    #[test]
    fn editor_command_keeps_paths_with_spaces_intact() {
        let dir = std::env::temp_dir().join(format!("docubook editor spec {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("Sublime Text");
        std::fs::write(&bin, "").unwrap();
        let spec = bin.to_str().unwrap().to_string();

        assert_eq!(editor_command(&spec), Some((spec.clone(), Vec::new())));
        let _ = std::fs::remove_dir_all(&dir);
    }

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

    /** The permission pane is the only thing the UI acts on, so pin the mapping
     *  from raw osascript stderr to a known-settings id. */
    #[cfg(target_os = "macos")]
    #[test]
    fn permission_errors_map_to_settings_panes() {
        assert_eq!(permission_settings_hint("execution error: ... not allowed to send keystrokes ..."), "accessibility");
        assert_eq!(permission_settings_hint("Not authorized to send Apple events"), "automation");
        assert_eq!(permission_settings_hint("\n\nError: -1743"), "automation");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn permission_failures_carry_the_prefix_and_the_hint() {
        let url = system_settings_url("accessibility").expect("known pane");
        assert!(url.starts_with("x-apple.systempreferences:"));
        assert!(system_settings_url("nonsense").is_none());
    }
}
