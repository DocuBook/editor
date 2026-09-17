// Vault / git / search / health command handlers (isolated).
use super::*;

pub(crate) fn open_vault(state: &AppState, path: &str) -> Result<String, String> {
    let v = vault::Vault::new(path)?;
    let name = v.name();
    let mut w = wiki::WikiIndex::new();
    w.scan(v.root(), v.walk("", vault::WalkKind::Markdown));
    tracing::info!(
        event = "vault_opened",
        git_repository = std::path::Path::new(path).join(".git").exists()
    );
    let g = git::Git::open(path);
    *state.vault.lock().expect("lock") = Some(v);
    *state.wiki.lock().expect("lock") = Some(w);
    *state.git.lock().expect("lock") = Some(g);
    Ok(json!({ "name": name }).to_string())
}

fn valid_vault_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && !name.contains("..")
        && !name.contains('/')
        && !name.contains('\\')
}

/** Rebuild the wiki index after a file mutation — same staleness fix as the
 *  desktop command layer (lib/vault.rs). The index is a snapshot taken at
 *  open_vault; without this, suggest/backlinks/resolve stay stale until the
 *  vault is reopened.
 *
 *  The vault lock only covers the file list: the content scan reads every
 *  markdown file, so holding the vault mutex across it would stall every other
 *  vault command. */
pub(crate) fn rescan_wiki(state: &AppState) {
    let (root, files) = {
        let vault = state.vault.lock().expect("lock");
        let Some(v) = vault.as_ref() else { return };
        (v.root().to_path_buf(), v.walk("", vault::WalkKind::Markdown))
    };
    if let Some(w) = state.wiki.lock().expect("lock").as_mut() {
        w.scan(&root, files);
    }
}

pub(crate) fn create_vault(state: &AppState, parent: &str, name: &str) -> Result<String, String> {
    if !valid_vault_name(name) {
        return Err("Invalid vault name".to_string());
    }
    let dir = std::path::Path::new(parent).join(name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    open_vault(state, dir.to_str().ok_or("Invalid path")?)
}

pub(crate) fn git_clone(state: &AppState, url: &str, parent: &str) -> Result<String, String> {
    let dir = git::Git::clone_repo(url, parent)?;
    let resp = open_vault(state, &dir)?;
    let mut v: Value = serde_json::from_str(&resp).map_err(|e| e.to_string())?;
    v["path"] = Value::String(dir);
    Ok(v.to_string())
}

pub(crate) fn search_vault(state: &AppState, query: &str) -> Result<String, String> {
    let vault = state.vault.lock().expect("lock");
    let Some(v) = vault.as_ref() else { return Ok("[]".to_string()) };
    serde_json::to_string(&search::search_vault(v, query)).map_err(|e| e.to_string())
}

pub(crate) fn git_diff_summary(state: &AppState) -> Result<String, String> {
    match state.git.lock().expect("lock").as_ref() {
        Some(g) if g.is_repo() => Ok(g.diff_summary()?),
        _ => Ok(String::new()),
    }
}

pub(crate) fn git_commit(state: &AppState, message: &str) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Ok(r#"{"error":"No vault"}"#.to_string()),
    };
    serde_json::to_string(&git::Git::open(&repo_path).commit_all(message)).map_err(|e| e.to_string())
}

pub(crate) fn git_push_only(state: &AppState, remote: Option<&str>) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Ok(r#"{"error":"No vault"}"#.to_string()),
    };
    serde_json::to_string(&git::Git::open(&repo_path).push_checked_to(remote))
        .map_err(|e| e.to_string())
}

/** Initialize the vault repository on `branch` (empty = configured default).
 *  Existing repositories are reported, never re-initialized. */
pub(crate) fn git_init(state: &AppState, branch: &str) -> Result<String, String> {
    match state.git.lock().expect("lock").as_ref() {
        Some(g) => serde_json::to_string(&g.init(branch)?).map_err(|e| e.to_string()),
        None => Err("No vault".into()),
    }
}

/** Connect to a remote and report reachability/default branch without fetching. */
pub(crate) fn git_remote_probe(state: &AppState, name: &str) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".into()),
    };
    serde_json::to_string(&git::Git::open(&repo_path).probe_remote(name)).map_err(|e| e.to_string())
}

/** Fetch a remote's branches into the `refs/remotes/<name>` namespace. */
pub(crate) fn git_fetch(state: &AppState, name: &str) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".into()),
    };
    git::Git::open(&repo_path)
        .fetch_remote(name)
        .map(|_| "null".into())
}

/** Fetch and reconcile through the shared libgit2 pull API. */
pub(crate) fn git_pull(
    state: &AppState,
    request: git::sync::GitPullRequest,
) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".into()),
    };
    serde_json::to_string(&git::Git::open(&repo_path).pull(request)).map_err(|e| e.to_string())
}

/** Reconcile the current branch with `<name>/<branch>` (fast-forward, adopt, or
 *  merge commit). Never force-pushes; conflicts come back to the UI. */
pub(crate) fn git_remote_merge(state: &AppState, name: &str, branch: &str) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".into()),
    };
    serde_json::to_string(&git::Git::open(&repo_path).merge_remote(name, branch))
        .map_err(|e| e.to_string())
}

/** Rebase the current branch onto `<name>/<branch>` (`branch` empty = the
 *  remote's default). Conflicts come back to the UI as data. */
pub(crate) fn git_rebase(state: &AppState, name: &str, branch: &str) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".into()),
    };
    serde_json::to_string(&git::Git::open(&repo_path).rebase_remote(name, branch))
        .map_err(|e| e.to_string())
}

/** Resume a stopped rebase after its conflicts were resolved and staged. */
pub(crate) fn git_rebase_continue(state: &AppState) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".into()),
    };
    serde_json::to_string(&git::Git::open(&repo_path).rebase_continue())
        .map_err(|e| e.to_string())
}

/** Undo an in-progress rebase. */
pub(crate) fn git_rebase_abort(state: &AppState) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".into()),
    };
    git::Git::open(&repo_path)
        .rebase_abort()
        .map(|_| "null".into())
}

/** Abandon an in-progress merge (discards the conflicting local changes). */
pub(crate) fn git_merge_abort(state: &AppState) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".into()),
    };
    git::Git::open(&repo_path)
        .merge_abort()
        .map(|_| "null".into())
}

pub(crate) fn git_branches(state: &AppState) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Ok("[]".to_string()),
    };
    // branches() is a Result — serialize the LIST, not the Result wrapper.
    serde_json::to_string(&git::Git::open(&repo_path).branches()?).map_err(|e| e.to_string())
}

pub(crate) fn git_create_branch(state: &AppState, branch: &str) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".to_string()),
    };
    git::Git::open(&repo_path).create_branch(branch).map(|_| "null".into())
}

pub(crate) fn git_checkout(state: &AppState, branch: &str, remote: bool) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Err("No vault".to_string()),
    };
    git::Git::open(&repo_path)
        .checkout_branch(branch, remote)
        .map(|_| "null".into())
}

pub(crate) fn git_settings(state: &AppState) -> Result<String, String> {
    let default_branch = git::repo::configured_initial_branch();
    match state.git.lock().expect("lock").as_ref() {
        Some(g) if g.is_repo() => {
            let (name, email) = g.identity()?;
            let remotes = g.remotes()?;
            Ok(json!({
                "isRepo": true, "name": name, "email": email,
                "defaultBranch": default_branch,
                "remotes": remotes.iter().map(|(n, u)| json!({ "name": n, "url": u })).collect::<Vec<_>>(),
            }).to_string())
        }
        Some(_) => {
            Ok(json!({"isRepo": false, "noVault": false, "name": "", "email": "", "defaultBranch": default_branch, "remotes": []}).to_string())
        }
        None => {
            Ok(json!({"isRepo": false, "noVault": true, "name": "", "email": "", "defaultBranch": default_branch, "remotes": []}).to_string())
        }
    }
}

/** Server-side vault folders under DATA_DIR/vaults — the web "open folder" dialog.
 *  Every path sink below is guarded by an explicit containment check against a
 *  canonical base, so neither a crafted DATA_DIR nor a crafted folder name/symlink
 *  can turn the listing into a traversal outside the data directory. */
pub(crate) fn web_vaults(state: &AppState) -> Result<String, String> {
    // Trusted, canonical base; root is derived from it and must stay under it.
    let base = state
        .data_dir
        .canonicalize()
        .unwrap_or_else(|_| state.data_dir.clone());
    let root = base.join("vaults");
    if !root.starts_with(&base) {
        return Err("invalid data directory".to_string());
    }
    let _ = std::fs::create_dir_all(&root);
    let root = root.canonicalize().unwrap_or(root);
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !valid_vault_name(&name) {
                continue;
            }
            let dir = root
                .join(&name)
                .canonicalize()
                .unwrap_or_else(|_| root.clone());
            if !dir.starts_with(&root) {
                continue;
            }
            if dir.is_dir() {
                out.push(json!({ "name": name, "path": dir.to_string_lossy().to_string() }));
            }
        }
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

pub(crate) fn health(state: &AppState) -> String {
    let vault_open = state.vault.lock().expect("lock").is_some();
    let git_repo = state
        .git
        .lock()
        .expect("lock")
        .as_ref()
        .map(|g| g.is_repo())
        .unwrap_or(false);
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "vaultOpen": vault_open,
        "gitRepo": git_repo,
    })
    .to_string()
}

