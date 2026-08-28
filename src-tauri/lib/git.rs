//! Git commands — clone/init/settings/remotes/identity/stage/push/status.
//! Backing logic lives in `crate::git` (the `Git` wrapper); `open_vault` is
//! reused from the vault module to mount the freshly cloned repo.

use tauri::State;
use crate::AppState;
use crate::commands::vault::open_vault;

#[tauri::command]
pub async fn git_clone(url: String, parent: String, state: State<'_, AppState>) -> Result<String, String> {
    // Network clone can take seconds — run off the main thread so the
    // "Cloning…" UI stays responsive.
    let dir = tauri::async_runtime::spawn_blocking(move || crate::git::Git::clone_repo(&url, &parent))
        .await
        .map_err(|e| e.to_string())??;
    let resp = open_vault(&dir, state)?;
    let mut v: serde_json::Value = serde_json::from_str(&resp).map_err(|e| e.to_string())?;
    v["path"] = serde_json::Value::String(dir);
    Ok(v.to_string())
}

#[tauri::command]
pub fn git_init(state: State<AppState>) -> Result<(), String> {
    match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.init(),
        None => Err("No vault".into()),
    }
}

#[tauri::command]
pub fn git_settings(state: State<AppState>) -> Result<String, String> {
    match state.git.lock().expect("lock").as_ref() {
        Some(g) if g.is_repo() => {
            let (name, email) = g.identity()?;
            let remotes = g.remotes()?;
            Ok(serde_json::json!({
                "isRepo": true, "name": name, "email": email,
                "remotes": remotes.iter().map(|(n, u)| serde_json::json!({ "name": n, "url": u })).collect::<Vec<_>>(),
            }).to_string())
        }
        Some(_) => Ok(r#"{"isRepo":false,"noVault":false,"name":"","email":"","remotes":[]}"#.to_string()),
        None => Ok(r#"{"isRepo":false,"noVault":true,"name":"","email":"","remotes":[]}"#.to_string()),
    }
}

#[tauri::command]
pub fn git_add_remote(name: String, url: String, state: State<AppState>) -> Result<(), String> {
    match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.add_remote(&name, &url),
        None => Err("No vault".into()),
    }
}

#[tauri::command]
pub fn git_remove_remote(name: String, state: State<AppState>) -> Result<(), String> {
    match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.remove_remote(&name),
        None => Err("No vault".into()),
    }
}

#[tauri::command]
pub fn git_set_identity(name: String, email: String, state: State<AppState>) -> Result<(), String> {
    match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.set_identity(&name, &email),
        None => Err("No vault".into()),
    }
}

#[tauri::command]
pub fn git_stage(path: Option<String>, state: State<AppState>) -> Result<(), String> {
    let guard = state.git.lock().expect("lock");
    match guard.as_ref() {
        Some(g) => match path {
            Some(p) if !p.is_empty() => g.stage_path(&p).map_err(|e| e.to_string()),
            _ => g.add_all().map_err(|e| e.to_string()),
        },
        None => Err("No vault".to_string()),
    }
}

#[tauri::command]
pub async fn git_commit(message: String, state: State<'_, AppState>) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Ok(r#"{"error":"No vault"}"#.to_string()),
    };
    // git commit can take a moment on large repos — off the main thread.
    let res = tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_string(&crate::git::Git::open(&repo_path).commit_all(&message)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(res)
}

#[tauri::command]
pub async fn git_push_only(state: State<'_, AppState>) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Ok(r#"{"error":"No vault"}"#.to_string()),
    };
    // git push hits the network — off the main thread.
    let res = tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_string(&crate::git::Git::open(&repo_path).push_checked()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(res)
}

#[tauri::command]
pub async fn git_branches(state: State<'_, AppState>) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Ok("[]".to_string()),
    };
    let res = tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_string(&crate::git::Git::open(&repo_path).branches()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(res?)
}

#[tauri::command]
pub async fn git_checkout(branch: String, state: State<'_, AppState>) -> Result<(), String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".to_string()),
    };
    tauri::async_runtime::spawn_blocking(move || crate::git::Git::open(&repo_path).checkout_branch(&branch))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_status(state: State<'_, AppState>) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Ok(r#"{"isRepo":false,"hasRemote":false,"branch":"","status":""}"#.to_string()),
    };
    // git spawns subprocesses (is_repo + status) — off the main thread (PERF:
    // this runs on a 3s poller; previously SYNC on the UI thread).
    let res = tauri::async_runtime::spawn_blocking(move || {
        let g = crate::git::Git::open(&repo_path);
        if !g.is_repo() {
            return serde_json::json!({ "isRepo": false, "hasRemote": false, "branch": "", "upstream": "", "status": "", "ahead": 0, "behind": 0 });
        }
        let ws = g.status_with_branch().unwrap_or_default();
        serde_json::json!({ "isRepo": true, "hasRemote": g.has_remote(), "branch": ws.branch, "upstream": ws.upstream, "status": ws.status.trim(), "ahead": ws.ahead, "behind": ws.behind })
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(res.to_string())
}
