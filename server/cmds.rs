// Vault / git / search / health command handlers (isolated).
use super::*;

pub(crate) fn open_vault(state: &AppState, path: &str) -> Result<String, String> {
    let v = vault::Vault::new(path)?;
    let name = v.name();
    let mut w = wiki::WikiIndex::new(v.root());
    w.scan();
    eprintln!(
        "[docubook] open_vault: {} (git repo: {})",
        path,
        std::path::Path::new(path).join(".git").exists()
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
    let root = match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.root().to_path_buf(),
        None => return Ok("[]".to_string()),
    };
    serde_json::to_string(&search::search_vault(&root, query)).map_err(|e| e.to_string())
}

/// Resolve wikilinks + search vault for AI system-prompt grounding.
/// Extracts [[links]] from query, resolves via wiki index, reads content,
/// and runs a filename search on remaining text. Token-budgeted.
pub(crate) fn ai_grounding_context(
    state: &AppState,
    query: &str,
    active_path: &str,
) -> Result<String, String> {
    let vault = state.vault.lock().expect("lock");
    let v = match vault.as_ref() {
        Some(v) => v,
        None => return Ok(String::new()),
    };

    // Read-per-file grounding: keyword terms from the prompt find
    // related .md files (OR match), then read a token-budgeted slice. No
    // wikilink index / semantic search — just grep-for-related + read.
    let stop = ["the","and","for","with","from","into","about","that","this","what","how","why","when","where","using","make","write","create"];
    let text = query.replace("[[", " ").replace("]]", " ");
    let terms: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 3 && !stop.contains(t))
        .map(|t| t.to_lowercase())
        .collect();
    if terms.is_empty() {
        return Ok(String::new());
    }
    let refs: Vec<&str> = terms.iter().map(String::as_str).collect();
    let results = search::search_vault_terms(v.root(), &refs);

    let mut context = String::new();
    for r in results.iter().take(3) {
        if r.path == active_path {
            continue;
        }
        if let Ok(content) = v.read_file(&r.path) {
            let trimmed = trim_to_tokens(&content, 2000);
            let name = std::path::Path::new(&r.path)
                .file_stem()
                .map(|s| s.to_string_lossy())
                .unwrap_or_default();
            context.push_str(&format!("\n\n## {name}\n(File: {})\n{trimmed}", r.path));
        }
    }
    Ok(context)
}

/// Trim markdown to roughly `max_chars`, breaking at paragraph boundaries.
fn trim_to_tokens(content: &str, max_chars: usize) -> String {
    if content.len() <= max_chars {
        return content.to_string();
    }
    let mut at = max_chars;
    if let Some(pos) = content[..at].rfind("\n\n") {
        at = pos;
    } else if let Some(pos) = content[..at].rfind('\n') {
        at = pos;
    } else if let Some(pos) = content[..at].rfind(". ") {
        at = pos + 1;
    }
    format!("{}...", &content[..at])
}

pub(crate) fn git_push(state: &AppState, message: &str) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Ok(r#"{"error":"No vault"}"#.to_string()),
    };
    serde_json::to_string(&git::Git::open(&repo_path).push_full(message)).map_err(|e| e.to_string())
}

pub(crate) fn git_settings(state: &AppState) -> Result<String, String> {
    match state.git.lock().expect("lock").as_ref() {
        Some(g) if g.is_repo() => {
            let (name, email) = g.identity()?;
            let remotes = g.remotes()?;
            Ok(json!({
                "isRepo": true, "name": name, "email": email,
                "remotes": remotes.iter().map(|(n, u)| json!({ "name": n, "url": u })).collect::<Vec<_>>(),
            }).to_string())
        }
        Some(_) => {
            Ok(r#"{"isRepo":false,"noVault":false,"name":"","email":"","remotes":[]}"#.to_string())
        }
        None => {
            Ok(r#"{"isRepo":false,"noVault":true,"name":"","email":"","remotes":[]}"#.to_string())
        }
    }
}

/** Server-side vault folders under DATA_DIR/vaults — the web "open folder" dialog. */
pub(crate) fn web_vaults(state: &AppState) -> Result<String, String> {
    let root = state.data_dir.join("vaults");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            out.push(json!({ "name": entry.file_name().to_string_lossy().to_string(), "path": path.to_string_lossy().to_string() }));
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

// ── HTTP handlers ──
