//! Git commands — clone/init/settings/remotes/identity/stage/push/status.
//! Backing logic lives in `crate::git` (the `Git` wrapper); `open_vault` is
//! reused from the vault module to mount the freshly cloned repo.

use crate::commands::vault::open_vault;
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn git_clone(
    url: String,
    parent: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Network clone can take seconds — run off the main thread so the
    // "Cloning…" UI stays responsive.
    let dir =
        tauri::async_runtime::spawn_blocking(move || crate::git::Git::clone_repo(&url, &parent))
            .await
            .map_err(|e| e.to_string())??;
    let resp = open_vault(&dir, state)?;
    let mut v: serde_json::Value = serde_json::from_str(&resp).map_err(|e| e.to_string())?;
    v["path"] = serde_json::Value::String(dir);
    Ok(v.to_string())
}

#[tauri::command]
pub fn git_init(branch: String, state: State<AppState>) -> Result<String, String> {
    match state.git.lock().expect("lock").as_ref() {
        Some(g) => serde_json::to_string(&g.init(&branch)?).map_err(|e| e.to_string()),
        None => Err("No vault".into()),
    }
}

#[tauri::command]
pub fn git_settings(state: State<AppState>) -> Result<String, String> {
    let default_branch = crate::git::repo::configured_initial_branch();
    match state.git.lock().expect("lock").as_ref() {
        Some(g) if g.is_repo() => {
            let (name, email) = g.identity()?;
            let remotes = g.remotes()?;
            Ok(serde_json::json!({
                "isRepo": true, "name": name, "email": email,
                "defaultBranch": default_branch,
                "remotes": remotes.iter().map(|(n, u)| serde_json::json!({ "name": n, "url": u })).collect::<Vec<_>>(),
            }).to_string())
        }
        Some(_) => {
            Ok(serde_json::json!({"isRepo": false, "noVault": false, "name": "", "email": "", "defaultBranch": default_branch, "remotes": []}).to_string())
        }
        None => {
            Ok(serde_json::json!({"isRepo": false, "noVault": true, "name": "", "email": "", "defaultBranch": default_branch, "remotes": []}).to_string())
        }
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

/// Remote connectivity/state check — network, so off the main thread.
#[tauri::command]
pub async fn git_remote_probe(name: String, state: State<'_, AppState>) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_string(&crate::git::Git::open(&repo_path).probe_remote(&name))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fetch a remote's branches into `refs/remotes/<name>/*` — network, off-thread.
#[tauri::command]
pub async fn git_fetch(name: String, state: State<'_, AppState>) -> Result<(), String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::Git::open(&repo_path).fetch_remote(&name)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fetch and reconcile in one libgit2 operation. `request.strategy` accepts
/// `auto`, `rebase`, or `merge`; auto keeps the common one-local-commit case linear.
#[tauri::command]
pub async fn git_pull(
    request: crate::git::sync::GitPullRequest,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_string(&crate::git::Git::open(&repo_path).pull(request))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reconcile the current branch with `<name>/<branch>` — fast-forward, adopt,
/// or merge commit. Never force-pushes; conflicts are reported back.
#[tauri::command]
pub async fn git_remote_merge(
    name: String,
    branch: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_string(&crate::git::Git::open(&repo_path).merge_remote(&name, &branch))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Rebase the current branch onto `<name>/<branch>` (`branch` empty = the
/// remote's default) — network, off-thread. Conflicts come back as data.
#[tauri::command]
pub async fn git_rebase(
    name: String,
    branch: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_string(&crate::git::Git::open(&repo_path).rebase_remote(&name, &branch))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resume a stopped rebase after its conflicts were resolved and staged.
#[tauri::command]
pub async fn git_rebase_continue(state: State<'_, AppState>) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_string(&crate::git::Git::open(&repo_path).rebase_continue())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Undo an in-progress rebase.
#[tauri::command]
pub async fn git_rebase_abort(state: State<'_, AppState>) -> Result<(), String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::Git::open(&repo_path).rebase_abort()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Abandon an in-progress merge (discards the conflicting local changes).
#[tauri::command]
pub async fn git_merge_abort(state: State<'_, AppState>) -> Result<(), String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::Git::open(&repo_path).merge_abort()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn git_set_identity(name: String, email: String, state: State<AppState>) -> Result<(), String> {
    match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.set_identity(&name, &email),
        None => Err("No vault".into()),
    }
}

#[tauri::command]
pub async fn git_diff_summary(state: State<'_, AppState>) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Ok(String::new()),
    };
    tauri::async_runtime::spawn_blocking(move || crate::git::Git::open(&repo_path).diff_summary())
        .await
        .map_err(|e| e.to_string())?
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
        serde_json::to_string(&crate::git::Git::open(&repo_path).commit_all(&message))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(res)
}

#[tauri::command]
pub async fn git_push_only(
    remote: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Ok(r#"{"error":"No vault"}"#.to_string()),
    };
    // git push hits the network — off the main thread.
    let res = tauri::async_runtime::spawn_blocking(move || {
        let target = remote.as_deref().filter(|name| !name.is_empty());
        serde_json::to_string(&crate::git::Git::open(&repo_path).push_checked_to(target))
            .map_err(|e| e.to_string())
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
        // branches() is a Result — serialize the LIST, not the Result wrapper.
        serde_json::to_string(&crate::git::Git::open(&repo_path).branches()?)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    res
}

#[tauri::command]
pub async fn git_create_branch(branch: String, state: State<'_, AppState>) -> Result<(), String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".to_string()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::Git::open(&repo_path).create_branch(&branch)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_checkout(
    branch: String,
    remote: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".to_string()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::Git::open(&repo_path).checkout_branch(&branch, remote)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_status(state: State<'_, AppState>) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => {
            return Ok(r#"{"isRepo":false,"hasRemote":false,"branch":"","upstream":"","status":"","ahead":0,"behind":0,"pushTarget":"","hasCommits":false,"remotes":[],"state":"clean"}"#.to_string())
        }
    };
    // Repository scanning can touch many files — keep the 3s poll off the UI thread.
    let res = tauri::async_runtime::spawn_blocking(move || {
        let g = crate::git::Git::open(&repo_path);
        if !g.is_repo() {
            return serde_json::json!({ "isRepo": false, "hasRemote": false, "branch": "", "upstream": "", "status": "", "ahead": 0, "behind": 0, "pushTarget": "", "hasCommits": false, "remotes": [], "state": "clean" });
        }
        let ws = g.status_with_branch().unwrap_or_default();
        let remotes = g
            .remotes()
            .map(|list| list.into_iter().map(|(name, _)| name).collect::<Vec<_>>())
            .unwrap_or_default();
        serde_json::json!({ "isRepo": true, "hasRemote": g.has_remote(), "branch": ws.branch, "upstream": ws.upstream, "status": ws.status.trim(), "ahead": ws.ahead, "behind": ws.behind, "pushTarget": g.push_target(), "hasCommits": g.has_commits(), "remotes": remotes, "state": ws.state })
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(res.to_string())
}
