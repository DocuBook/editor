
mod vault;
mod wiki;
mod git;
mod search;
mod agent;
mod keychain;
mod markdown;
use markdown::markdown_to_safe_html;

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::collections::HashSet;
use regex::Regex;
use tauri::{State, Manager, Emitter};

struct AppState {
    vault: Mutex<Option<vault::Vault>>,
    wiki: Mutex<Option<wiki::WikiIndex>>,
    git: Mutex<Option<git::Git>>,
    ai_cancel: AtomicBool,
    /** Set when the frontend confirmed it is safe to close (graceful shutdown). */
    closing: AtomicBool,
}

#[tauri::command]
fn open_vault(path: &str, state: State<AppState>) -> Result<String, String> {
    let v = vault::Vault::new(path)?;
    let name = v.name();
    let mut w = wiki::WikiIndex::new(v.root()); w.scan();
    eprintln!("[docubook] open_vault: {} (git repo: {})", path, std::path::Path::new(path).join(".git").exists());
    let g = git::Git::open(path);
    *state.vault.lock().expect("lock") = Some(v);
    *state.wiki.lock().expect("lock") = Some(w);
    *state.git.lock().expect("lock") = Some(g);
    Ok(format!(r#"{{"name":"{}"}}"#, name))
}

/** Validate a vault folder name (no separators, no traversal). */
fn valid_vault_name(name: &str) -> bool {
    !name.is_empty() && name != "." && !name.contains("..") && !name.contains('/') && !name.contains('\\')
}

#[tauri::command]
fn create_vault(parent: &str, name: &str, state: State<AppState>) -> Result<String, String> {
    if !valid_vault_name(name) { return Err("Invalid vault name".to_string()); }
    let dir = std::path::Path::new(parent).join(name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    open_vault(dir.to_str().ok_or("Invalid path")?, state)
}

#[tauri::command]
fn close_vault(state: State<AppState>) -> Result<(), String> {
    *state.vault.lock().expect("lock") = None; *state.wiki.lock().expect("lock") = None; *state.git.lock().expect("lock") = None; Ok(())
}

#[tauri::command]
fn list_tree(subpath: String, state: State<AppState>) -> Result<String, String> {
    match state.vault.lock().expect("lock").as_ref() {
        Some(v) => serde_json::to_string(&v.tree(&subpath)).map_err(|e| e.to_string()),
        None => Ok("[]".to_string()),
    }
}

#[tauri::command]
fn read_file(path: &str, state: State<AppState>) -> Result<String, String> {
    match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.read_file(path), None => Err("No vault".to_string())
    }
}

#[tauri::command]
fn read_file_binary(path: &str, state: State<AppState>) -> Result<String, String> {
    match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.read_file_binary(path), None => Err("No vault".to_string())
    }
}

#[tauri::command]
fn write_file(path: &str, content: &str, state: State<AppState>) -> Result<(), String> {
    match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.write_file(path, content), None => Err("No vault".to_string())
    }
}

#[tauri::command]
fn create_file(path: &str, state: State<AppState>) -> Result<String, String> {
    match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.create_file(path), None => Err("No vault".to_string())
    }
}

#[tauri::command]
fn create_directory(path: &str, state: State<AppState>) -> Result<(), String> {
    match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.create_directory(path), None => Err("No vault".to_string())
    }
}

#[tauri::command]
fn delete_file(path: &str, state: State<AppState>) -> Result<(), String> {
    match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.delete_file(path), None => Err("No vault".to_string())
    }
}

#[tauri::command]
fn rename_file(from: &str, to: &str, state: State<AppState>) -> Result<(), String> {
    match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.rename_file(from, to), None => Err("No vault".to_string())
    }
}

// ── Wiki ──
#[tauri::command]
fn wiki_suggest(query: String, state: State<AppState>) -> Result<String, String> {
    match state.wiki.lock().expect("lock").as_ref() {
        Some(w) => serde_json::to_string(&w.suggest(&query)).map_err(|e| e.to_string()),
        None => Ok("[]".to_string()),
    }
}

#[tauri::command]
fn wiki_backlinks(path: &str, state: State<AppState>) -> Result<String, String> {
    match state.wiki.lock().expect("lock").as_ref() {
        Some(w) => serde_json::to_string(&w.backlinks(path)).map_err(|e| e.to_string()),
        None => Ok("[]".to_string()),
    }
}

#[tauri::command]
fn wiki_resolve(title: String, state: State<AppState>) -> Result<String, String> {
    Ok(match state.wiki.lock().expect("lock").as_ref() {
        Some(w) => w.resolve(&title).unwrap_or_default(),
        None => String::new(),
    })
}

// ── Search ──
#[tauri::command]
async fn search_vault(query: String, state: State<'_, AppState>) -> Result<String, String> {
    let root = match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.root().to_path_buf(),
        None => return Ok("[]".to_string()),
    };
    // File scan can take a moment on large vaults — off the main thread.
    let results = tauri::async_runtime::spawn_blocking(move || search::search_vault(&root, &query))
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&results).map_err(|e| e.to_string())
}

// ── AI Grounding ──
/// Resolve wikilinks + search the vault for AI system-prompt grounding.
/// Extracts [[links]] from the user query, resolves each via the wiki index,
/// reads their content, also runs a filename search on the remaining text,
/// and returns a compact markdown context block (token-budgeted).
#[tauri::command]
fn ai_grounding_context(query: String, active_path: String, state: State<AppState>) -> Result<String, String> {
    let vault = state.vault.lock().expect("lock");
    let wiki = state.wiki.lock().expect("lock");
    let v = match vault.as_ref() { Some(v) => v, None => return Ok(String::new()) };
    let w = match wiki.as_ref() { Some(w) => w, None => return Ok(String::new()) };

    let link_re = Regex::new(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]").unwrap();
    let mut context = String::new();
    let mut linked: HashSet<String> = HashSet::new();

    // 1. Resolve wikilinks → read content
    for cap in link_re.captures_iter(&query) {
        let target = &cap[1];
        if let Some(path) = w.resolve(target) {
            if path != active_path && linked.insert(path.clone()) {
                if let Ok(content) = v.read_file(&path) {
                    let name = std::path::Path::new(&path).file_stem().map(|s| s.to_string_lossy()).unwrap_or_default();
                    let trimmed = trim_to_tokens(&content, 2000);
                    context.push_str(&format!("\n\n## {name}\n(File: {path})\n{trimmed}"));
                }
            }
        }
    }

    // 2. Extract search terms (non-wikilink text, min 3 chars)
    let search_text = link_re.replace_all(&query, "").to_string();
    let terms: Vec<&str> = search_text.split_whitespace().filter(|t| t.len() >= 3).collect();
    if !terms.is_empty() {
        let results = search::search_vault(v.root(), &terms.join(" "));
        for r in results.iter().take(3) {
            if r.path != active_path && !linked.contains(&r.path) {
                linked.insert(r.path.clone());
                if let Ok(content) = v.read_file(&r.path) {
                    let trimmed = trim_to_tokens(&content, 1500);
                    context.push_str(&format!("\n\n## {}\n(File: {})\n{trimmed}", r.name.trim_end_matches(".md").trim_end_matches(".mdx"), r.path));
                }
            }
        }
    }

    Ok(context)
}

/// Trim markdown to roughly `max_chars` while keeping structural integrity
/// (break at paragraph/heading boundary, never mid-word).
fn trim_to_tokens(content: &str, max_chars: usize) -> String {
    if content.len() <= max_chars { return content.to_string(); }
    let mut at = max_chars;
    // back up to the nearest double-newline (paragraph boundary)
    if let Some(pos) = content[..at].rfind("\n\n") { at = pos; }
    else if let Some(pos) = content[..at].rfind('\n') { at = pos; }
    else if let Some(pos) = content[..at].rfind(". ") { at = pos + 1; }
    format!("{}...", &content[..at])
}

// ── Git ──
#[tauri::command]
async fn git_clone(url: String, parent: String, state: State<'_, AppState>) -> Result<String, String> {
    // Network clone can take seconds — run off the main thread so the
    // "Cloning…" UI stays responsive.
    let dir = tauri::async_runtime::spawn_blocking(move || git::Git::clone_repo(&url, &parent))
        .await
        .map_err(|e| e.to_string())??;
    let resp = open_vault(&dir, state)?;
    let mut v: serde_json::Value = serde_json::from_str(&resp).map_err(|e| e.to_string())?;
    v["path"] = serde_json::Value::String(dir);
    Ok(v.to_string())
}

#[tauri::command]
fn git_init(state: State<AppState>) -> Result<(), String> {
    match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.init(),
        None => Err("No vault".into()),
    }
}

#[tauri::command]
fn git_settings(state: State<AppState>) -> Result<String, String> {
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
fn git_add_remote(name: String, url: String, state: State<AppState>) -> Result<(), String> {
    match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.add_remote(&name, &url),
        None => Err("No vault".into()),
    }
}

#[tauri::command]
fn git_remove_remote(name: String, state: State<AppState>) -> Result<(), String> {
    match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.remove_remote(&name),
        None => Err("No vault".into()),
    }
}

#[tauri::command]
fn git_set_identity(name: String, email: String, state: State<AppState>) -> Result<(), String> {
    match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.set_identity(&name, &email),
        None => Err("No vault".into()),
    }
}

#[tauri::command]
fn git_stage(state: State<AppState>) -> Result<(), String> {
    let guard = state.git.lock().expect("lock");
    match guard.as_ref() {
        Some(g) => g.add_all().map_err(|e| e.to_string()),
        None => Err("No vault".to_string()),
    }
}

#[tauri::command]
async fn git_push(message: String, state: State<'_, AppState>) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Ok(r#"{"error":"No vault"}"#.to_string()),
    };
    // add+commit+push can take seconds on large repos — off the main thread.
    let res = tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_string(&git::Git::open(&repo_path).push_full(&message)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(res)
}

#[tauri::command]
async fn git_status(state: State<'_, AppState>) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Ok(r#"{"branch":"","status":""}"#.to_string()),
    };
    // git spawns subprocesses (is_repo + status) — off the main thread (PERF:
    // this runs on a 3s poller; previously SYNC on the UI thread).
    let (branch, status) = tauri::async_runtime::spawn_blocking(move || {
        let g = git::Git::open(&repo_path);
        if !g.is_repo() {
            return (String::new(), String::new());
        }
        g.status_with_branch().unwrap_or_default()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "branch": branch, "status": status.trim() }).to_string())
}

// ── Preview ──
#[tauri::command]
fn markdown_preview(content: &str) -> String {
    markdown::markdown_preview(content)
}

/// Convert markdown to clean HTML (no wrapper) for TipTap display.
#[tauri::command]
fn md_to_html(content: &str) -> String {
    markdown_to_safe_html(content)
}

// ── Agent ──
#[tauri::command]
async fn list_api_keys(providers: Vec<String>) -> Result<String, String> {
    // Keychain scan spawns ~174 `security` processes — run off the main thread
    // so opening Settings never blocks the UI.
    let keys = tauri::async_runtime::spawn_blocking(move || keychain::list_keys(&providers))
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&keys).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_api_key(provider: &str, key: &str) -> Result<(), String> {
    keychain::set_key(provider, key)
}

/** Runtime model discovery — GET {baseUrl}/models with the stored key, so the
 *  frontend never holds API keys (SEC-5). SSRF-guarded and no redirects (same
 *  policy as ask_ai). */
#[tauri::command]
async fn list_models(provider: String, base_url: String) -> Result<String, String> {
    if base_url.is_empty() {
        return Err("Base URL is required".into());
    }
    agent::validate_base_url(&base_url)?;
    let key = keychain::get_key(&provider).map_err(|_| "No API key found — save one in Settings -> AI".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Client error: {}", e))?;
    let models = agent::fetch_models(&client, &base_url, &key).await?;
    serde_json::to_string(&models).map_err(|e| e.to_string())
}

/** Save a custom OpenAI-compatible endpoint: base URL + key bound together
 *  server-side. The stored URL is the ONLY destination the key is ever sent to
 *  (ask_ai ignores webview-provided URLs for the custom provider), which closes
 *  the exfiltration vector a webview-controlled URL would open. */
#[tauri::command]
fn set_custom_endpoint(provider: &str, base_url: &str, key: &str) -> Result<(), String> {
    agent::validate_custom_base_url(base_url, true)?;
    keychain::set_base_url(provider, base_url)?;
    keychain::set_key(provider, key)
}

/** Custom-provider config for the UI. Desktop is never env-controlled — the
 *  keychain is the source; env overrides are a Docker/web feature. */
#[tauri::command]
fn custom_ai_config() -> Result<String, String> {
    let base_url = keychain::get_base_url(agent::CUSTOM_PROVIDER_ID).ok();
    let has_key = keychain::get_key(agent::CUSTOM_PROVIDER_ID).is_ok();
    Ok(serde_json::json!({ "source": "file", "baseUrl": base_url, "hasKey": has_key, "model": null }).to_string())
}

#[tauri::command]
fn delete_api_key(provider: &str) -> Result<(), String> {
    let _ = keychain::delete_base_url(provider); // best-effort — custom-endpoint entry may not exist
    keychain::delete_key(provider)
}


#[tauri::command]
async fn test_connection(provider: String, model: String, base_url: String, api_key: String) -> Result<String, String> {
    // SSRF / exfiltration guard — the key may only be sent to an allowed host.
    // Custom endpoints skip the allowlist (any public https host) but still pass
    // the generic sanitize; catalog providers stay strictly allowlisted.
    if provider == agent::CUSTOM_PROVIDER_ID {
        agent::validate_custom_base_url(&base_url, true)?;
    } else {
        agent::validate_base_url(&base_url)?;
    }
    // API key: prefer the explicit arg (just-entered key), fall back to the
    // stored keychain key so auto-probe works without re-typing the key
    // (mirrors ask_ai, which always resolves from the keychain). Custom
    // endpoints also fall back to the stored base URL.
    let api_key = if api_key.is_empty() {
        keychain::get_key(&provider).map_err(|_| "No API key found in keychain".to_string())?
    } else {
        api_key
    };
    let base_url = if base_url.is_empty() && provider == agent::CUSTOM_PROVIDER_ID {
        keychain::get_base_url(&provider).map_err(|_| "No custom base URL saved — set it in Settings → AI".to_string())?
    } else {
        base_url
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build().map_err(|e| format!("Client error: {}", e))?;
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    // Test 1: basic connectivity
    let basic_body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "say ok"}],
        "max_tokens": 8,
    });
    let res = client.post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&basic_body)
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("API error ({}): {}", res.status(), res.text().await.unwrap_or_default()));
    }

    // Test 2: tool call support — send a dummy tool whose schema MIRRORS the
    // real applyDocumentOperations payload ($defs/$ref, anyOf,
    // additionalProperties:false) so the probe measures whether OUR payload
    // shape passes this gateway, not just "model supports tools".
    let tool_body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "call the test_tool"}],
        "stream": false,
        "tools": [{
            "type": "function",
            "function": {
                "name": "test_tool",
                "description": "A test tool",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "operations": {
                            "type": "array",
                            "items": {
                                "anyOf": [
                                    { "type": "object", "properties": { "type": { "const": "update" }, "id": { "type": "string" } }, "required": ["type", "id"], "additionalProperties": false },
                                    { "$ref": "#/$defs/BlockOp" }
                                ]
                            }
                        }
                    },
                    "required": ["operations"],
                    "additionalProperties": false,
                    "$defs": { "BlockOp": { "type": "object", "properties": { "type": { "const": "add" } }, "required": ["type"], "additionalProperties": false } }
                }
            }
        }],
        "tool_choice": "required",
        "max_tokens": 50,
    });
    let tool_req = client.post(&url)
        .header("Authorization", format!("Bearer {}", api_key));
    let tool_res = tool_req.json(&tool_body).send()
        .await
        .map_err(|e| format!("Tool test failed: {}", e))?;
    if !tool_res.status().is_success() {
        // Tool call not supported — ignore error, just report no tools.
        // HTTP 400 here MEANS the gateway rejected tool_choice:"required"
        // (e.g. DeepSeek thinking-mode models) — this is a definitive
        // negative, not a maybe. The provider cannot do forced tool calls.
        eprintln!("[docubook] test_connection tool probe: provider rejected tool_choice:'required' (HTTP {}) — tools disabled", tool_res.status());
        return Ok(r#"{"status":"ok","tools":false}"#.to_string());
    }
    // Non-streaming parse: response is a single JSON object, not SSE chunks.
    let text = tool_res.text().await.map_err(|e| e.to_string())?;
    let supports_tools = text.contains("tool_calls") || text.contains("test_tool");
    Ok(format!(r#"{{"status":"ok","tools":{}}}"#, supports_tools))
}

#[tauri::command]
async fn ask_ai(messages: String, app: tauri::AppHandle, provider: Option<String>, model: Option<String>, base_url: Option<String>, _api_key: Option<String>, tools: Option<String>) -> Result<(), String> {
    let agent = match (&provider, &model, &base_url) {
        // Custom OpenAI-compatible endpoint: URL is bound server-side at save time,
        // the webview-provided base_url is IGNORED so the stored key can never be
        // redirected to a host the user did not explicitly bind it to.
        (Some(p), Some(m), _) if p == agent::CUSTOM_PROVIDER_ID => {
            let b = keychain::get_base_url(p).map_err(|_| "No custom base URL saved — set it in Settings → AI")?;
            agent::validate_custom_base_url(&b, true)?;
            // API key is ALWAYS resolved from the keychain — a webview-provided
            // key is ignored so it can never be exfiltrated to a non-trusted host.
            let key = keychain::get_key(p).map_err(|_| "No API key found in keychain")?;
            agent::Agent::new(p, m, &key, &b)
        }
        (Some(p), Some(m), Some(b)) => {
            // SSRF / exfiltration guard: base URL must be an allowlisted provider
            // endpoint or a loopback (local LLM) server.
            agent::validate_base_url(b)?;
            // API key is ALWAYS resolved from the keychain — a webview-provided
            // key is ignored so it can never be exfiltrated to a non-trusted host.
            let key = keychain::get_key(p).map_err(|_| "No API key found in keychain")?;
            agent::Agent::new(p, m, &key, b)
        }
        _ => return Err("Provider, model, and base URL are required".to_string()),
    };
    let state = app.state::<AppState>();
    eprintln!("[docubook] ask_ai: provider={} model={}", agent.provider, agent.model);
    let started = std::time::Instant::now();
    state.ai_cancel.store(false, Ordering::SeqCst);
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        // Streaming: no total deadline (long generations) — read_timeout resets per chunk, only stalls abort.
        .read_timeout(std::time::Duration::from_secs(120))
        .build().map_err(|e| format!("Client error: {}", e))?;
    let mut body_obj = serde_json::json!({
        "model": agent.model,
        "messages": serde_json::from_str::<serde_json::Value>(&messages).map_err(|e| format!("Invalid messages: {}", e))?,
        "stream": true,
    });
    if let Some(ref tools_str) = tools {
        if let Ok(tools_val) = serde_json::from_str::<serde_json::Value>(tools_str) {
            if let Some(arr) = tools_val.as_array() {
                if !arr.is_empty() {
                    body_obj["tools"] = tools_val;
                    // "auto": the model chooses tool or text. The test_connection
                    // probe (tool_choice:"required") is the definitive gate — if it
                    // says tools:false, tools are never sent. With "auto" here, even
                    // an unprobed thinking-mode model (DeepSeek) degrades gracefully
                    // to text → text-to-applyDocumentOperations path instead of 400.
                    body_obj["tool_choice"] = serde_json::json!("auto");
                }
            }
        }
    }
    let body = body_obj;
    let url = format!("{}/chat/completions", agent.base_url.trim_end_matches('/'));
    // Neutral OpenAI-compatible request — no provider-specific attribution headers.
    let req = client.post(&url).header("Authorization", format!("Bearer {}", agent.api_key));
    // Timeout budget (P1): 30s to get response headers AND first chunk — a
    // provider that accepts the request but never sends data errors out at 30s
    // instead of hanging on send() or the 120s read_timeout.
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        req.json(&body).send(),
    )
    .await
    .map_err(|_| "AI provider did not respond — try again".to_string())?
    .map_err(|e| sanitize_ai_error(&e.to_string()))?;
    let status = response.status();
    if !status.is_success() {
        // Do NOT surface the raw provider body — it may leak internal details.
        // Log the EXACT request body + provider response server-side (desktop
        // terminal / docker logs) so a gateway rejection is diagnosable without
        // guessing: this shows what we actually sent and why it was rejected.
        let req_snapshot = serde_json::json!({
            "model": body.get("model"),
            "stream": body.get("stream"),
            "max_tokens": body.get("max_tokens"),
            "tool_choice": body.get("tool_choice"),
            "tools": body.get("tools"),
            "message_roles": body.get("messages").and_then(|m| m.as_array()).map(|a| a.iter().filter_map(|x| x.get("role").and_then(|r| r.as_str()).map(String::from)).collect::<Vec<_>>()),
        }).to_string();
        let body = response.text().await.unwrap_or_default();
        eprintln!("[docubook] ask_ai provider error: HTTP {} — request: {} — body: {}", status, &req_snapshot[..req_snapshot.len().min(1600)], &body[..body.len().min(800)]);
        return Err(format!("AI provider error (HTTP {})", status));
    }
    let mut stream = response;
    // First chunk budget: headers arrived but body never starts → 30s, not 120s.
    let first_chunk = tokio::time::timeout(std::time::Duration::from_secs(30), stream.chunk())
        .await
        .map_err(|_| "AI provider did not respond — try again".to_string())?
        .map_err(|e| sanitize_ai_error(&e.to_string()))?
        .ok_or_else(|| "AI provider returned an empty response".to_string())?;

    use tauri::Emitter;
    let mut full = String::new();
    let mut tool_calls: Vec<(i64, String, String, String)> = Vec::new();

    // Byte-buffered SSE parse (mirrors PI's streaming UTF-8 decoder):
    // buffer RAW bytes across chunks, split on \n (0x0A), decode each COMPLETE line.
    // Per-chunk String::from_utf8_lossy corrupts multi-byte UTF-8 chars split across chunks,
    // and partial SSE lines (JSON split mid-event) are dropped.
    let mut byte_buf: Vec<u8> = Vec::new();
    let mut truncated = false;
    // Process the pre-fetched first chunk, then stream the rest (read_timeout 120s
    // per chunk for long generations).
    let mut pending_first = Some(first_chunk);
    loop {
        // Total generation budget (per attempt): the per-chunk read_timeout only
        // catches STALLS — a model that trickles tokens forever never trips it,
        // so the whole run is bounded here. Errors cleanly (invoke rejects →
        // xl-ai shows retry/cancel in the AI menu).
        if started.elapsed().as_secs() >= AI_MAX_SECONDS {
            return Err(format!("AI generation exceeded {}s — try again or use a stronger model", AI_MAX_SECONDS));
        }
        let chunk = match pending_first.take() {
            Some(c) => Some(c),
            None => stream.chunk().await.map_err(|e| sanitize_ai_error(&e.to_string()))?,
        };
        let Some(chunk) = chunk else { break };
        if state.ai_cancel.load(Ordering::SeqCst) { break }
        byte_buf.extend_from_slice(&chunk);
        let mut start = 0;
        while let Some(pos) = byte_buf[start..].iter().position(|&b| b == b'\n') {
            let line_end = start + pos;
            let line = String::from_utf8_lossy(&byte_buf[start..line_end]);
            let data = line.trim_end_matches('\r').strip_prefix("data: ").unwrap_or("");
            if !data.is_empty() {
                process_sse_data(data, &mut full, &mut tool_calls, &app);
                // Cap runaway responses (memory exhaustion guard).
                if full.len() >= MAX_AI_BUFFER {
                    truncated = true;
                    break;
                }
            }
            start = line_end + 1;
        }
        // Drop processed bytes; keep the partial tail for the next chunk.
        byte_buf.drain(..start);
        if truncated { break }
    }
    // Process any final event without a trailing newline.
    if !byte_buf.is_empty() {
        let line = String::from_utf8_lossy(&byte_buf);
        let data = line.trim_end_matches('\r').strip_prefix("data: ").unwrap_or("");
        if !data.is_empty() {
            process_sse_data(data, &mut full, &mut tool_calls, &app);
        }
    }
    // Emit complete tool calls after stream — validation lives frontend-side (doc state).
    for (_, id, name, args) in &tool_calls {
        if !id.is_empty() && !name.is_empty() {
            let input: serde_json::Value = serde_json::from_str(args).unwrap_or(serde_json::Value::Null);
            let _ = app.emit("ai:tool_call", serde_json::json!({
                "toolCallId": id,
                "toolName": name,
                "input": input,
            }));
        }
    }
    let _ = app.emit("ai:tools_done", "");
    if full.is_empty() && tool_calls.is_empty() {
        return Err("AI returned empty response".to_string());
    }
    eprintln!("[docubook] ask_ai done: elapsed={:.1}s chars={} tools={} truncated={}", started.elapsed().as_secs_f32(), full.len(), tool_calls.len(), truncated);
    let _ = app.emit("ai:done", serde_json::json!({ "provider": agent.provider, "truncated": truncated }));
    Ok(())
}

/** Cap runaway AI responses (memory-exhaustion guard): 8 MiB of text is far
 *  beyond any legitimate document. When exceeded the stream is stopped and
 *  `ai:done` carries `truncated: true`. */
const MAX_AI_BUFFER: usize = 8 * 1024 * 1024;
/** Total AI generation budget per attempt (seconds) — a pure backstop.
 *  Failure detection is the PI pattern: 30s first-chunk + 120s per-chunk stall
 *  timeout kill hung streams fast, and the user can always Abort (cancel_ai).
 *  A model that streams slowly but steadily (weak/thinking models) is allowed
 *  to finish; this cap only guards against a runaway generation. */
const AI_MAX_SECONDS: u64 = 900;
/** Map transport errors to user-safe messages — never leak URLs, paths, or
 *  raw provider details into the UI (structured error contract). */
fn sanitize_ai_error(err: &str) -> String {
    let e = err.to_lowercase();
    if e.contains("dns") || e.contains("resolve") || e.contains("connection") || e.contains("refused") || e.contains("connect") {
        "Could not reach the AI provider — check your connection".into()
    } else if e.contains("timeout") || e.contains("timed out") {
        "The AI provider timed out".into()
    } else if e.contains("tls") || e.contains("ssl") || e.contains("certificate") {
        "Secure connection to the AI provider failed".into()
    } else if e.contains("body") || e.contains("json") || e.contains("parse") {
        "The AI provider returned an unreadable response".into()
    } else {
        "AI request failed".into()
    }
}

/// Cancel the in-flight AI request (frontend abort). Stream loop checks the flag between chunks.
#[tauri::command]
fn cancel_ai(state: State<AppState>) {
    state.ai_cancel.store(true, Ordering::SeqCst);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                eprintln!("[docubook] window theme at startup: {:?}", w.theme());
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { vault: Mutex::new(None), wiki: Mutex::new(None), git: Mutex::new(None), ai_cancel: AtomicBool::new(false), closing: AtomicBool::new(false) })
        .on_window_event(|window, event| {
            // Graceful shutdown: ask the frontend to flush & save, then confirm.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if state.closing.swap(true, Ordering::SeqCst) {
                    return; // already confirmed by the frontend — allow close
                }
                let _ = window.emit("app:before-close", ());
                api.prevent_close();
                // Fallback: force close if the frontend never confirms (e.g. crashed).
                let win = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if !win.state::<AppState>().closing.load(Ordering::SeqCst) {
                        let _ = win.close();
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_vault, close_vault, create_vault, git_clone, list_tree, read_file, read_file_binary, write_file, create_file, delete_file, rename_file, create_directory,
            git_settings, git_add_remote, git_remove_remote, git_set_identity, git_init,
            wiki_backlinks, wiki_suggest, wiki_resolve, search_vault, git_stage, git_push, git_status,
            custom_ai_config,
            markdown_preview, md_to_html, ask_ai, cancel_ai, set_api_key, set_custom_endpoint, delete_api_key, list_api_keys, test_connection, list_models,
            ai_grounding_context, health, app_ready_to_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/** Frontend confirms it saved everything — safe to actually close. */
#[tauri::command]
fn app_ready_to_close(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.closing.store(true, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("main") {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/** Minimal health/diagnostics surface (reused by the future cloud service). */
#[tauri::command]
fn health(state: State<AppState>) -> Result<String, String> {
    let vault_open = state.vault.lock().expect("lock").is_some();
    let git_repo = state.git.lock().expect("lock").as_ref().map(|g| g.is_repo()).unwrap_or(false);
    Ok(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "vaultOpen": vault_open,
        "gitRepo": git_repo,
    }).to_string())
}

/// Process one complete SSE `data:` payload (content delta + tool call accumulation).
fn process_sse_data(data: &str, full: &mut String, tool_calls: &mut Vec<(i64, String, String, String)>, app: &tauri::AppHandle) {
    use tauri::Emitter;
    if data == "[DONE]" { return; }
    let Ok(val) = serde_json::from_str::<serde_json::Value>(data) else { return; };
    if let Some(content) = val["choices"][0]["delta"]["content"].as_str() {
        full.push_str(content);
        let _ = app.emit("ai:token", content);
    }
    if let Some(tcs) = val["choices"][0]["delta"]["tool_calls"].as_array() {
        for tc in tcs {
            let idx = tc["index"].as_i64().unwrap_or(0);
            let id = tc["id"].as_str().unwrap_or("").to_string();
            let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
            let args = tc["function"]["arguments"].as_str().unwrap_or("").to_string();
            if let Some(pos) = tool_calls.iter().position(|(i,_,_,_)| *i == idx) {
                if !id.is_empty() { tool_calls[pos].1 = id; }
                if !name.is_empty() { tool_calls[pos].2 = name; }
                tool_calls[pos].3.push_str(&args);
            } else {
                tool_calls.push((idx, id, name, args));
            }
        }
    }
}

/// Parse a single SSE data line from /chat/completions stream.
/// Returns (content_delta, accumulated_tool_calls, is_done).
pub fn parse_sse_line(data: &str, tool_calls: &mut Vec<(i64, String, String, String)>) -> (Option<String>, bool) {
    if data == "[DONE]" { return (None, true); }
    let Ok(val) = serde_json::from_str::<serde_json::Value>(data) else { return (None, false); };
    
    let content = val["choices"][0]["delta"]["content"].as_str().map(|s| s.to_string());
    
    if let Some(tcs) = val["choices"][0]["delta"]["tool_calls"].as_array() {
        for tc in tcs {
            let idx = tc["index"].as_i64().unwrap_or(0);
            let id = tc["id"].as_str().unwrap_or("").to_string();
            let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
            let args = tc["function"]["arguments"].as_str().unwrap_or("").to_string();
            if let Some(pos) = tool_calls.iter().position(|(i,_,_,_)| *i == idx) {
                if !id.is_empty() { tool_calls[pos].1 = id; }
                if !name.is_empty() { tool_calls[pos].2 = name; }
                tool_calls[pos].3.push_str(&args);
            } else {
                tool_calls.push((idx, id, name, args));
            }
        }
    }
    (content, false)
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

    #[test]
    fn markdown_renders_html() {
        let html = markdown_preview("# Hello\n\n**bold** and `code`");
        assert!(html.contains("<h1"));
        assert!(html.contains("Hello"));
        assert!(html.contains("<strong>"));
        assert!(html.contains("<code>"));
    }

    #[test]
    fn empty_markdown() {
        let html = markdown_preview("");
        assert!(html.contains("<div"));
    }

    #[test]
    fn markdown_handles_code_block() {
        let html = markdown_preview("```rust\nfn main() {}\n```");
        assert!(html.contains("<code"));
    }

    #[test]
    fn parse_sse_text_content() {
        let mut tcs = Vec::new();
        let (content, done) = parse_sse_line(
            r#"{"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}"#,
            &mut tcs
        );
        assert_eq!(content, Some("Hello".to_string()));
        assert!(!done);
        assert!(tcs.is_empty());
    }

    #[test]
    fn parse_sse_done() {
        let mut tcs = Vec::new();
        let (content, done) = parse_sse_line("[DONE]", &mut tcs);
        assert!(content.is_none());
        assert!(done);
    }

    #[test]
    fn parse_sse_tool_call_start() {
        let mut tcs = Vec::new();
        let (_content, done) = parse_sse_line(
            r#"{"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"applyDocumentOperations","arguments":""}}]}}]}"#,
            &mut tcs
        );
        assert!(!done);
        assert_eq!(tcs.len(), 1);
        assert_eq!(tcs[0].0, 0);
        assert_eq!(tcs[0].1, "call_1");
        assert_eq!(tcs[0].2, "applyDocumentOperations");
    }

    #[test]
    fn parse_sse_tool_call_accumulate_args() {
        let mut tcs = Vec::new();
        // First chunk: start with empty args
        parse_sse_line(
            r#"{"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"test","arguments":""}}]}}]}"#,
            &mut tcs
        );
        // Second chunk: args fragment
        parse_sse_line(
            r#"{"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"ops\":"}}]}}]}"#,
            &mut tcs
        );
        // Third chunk: complete args
        parse_sse_line(
            r#"{"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"[]}"}}]}}]}"#,
            &mut tcs
        );
        assert_eq!(tcs.len(), 1);
        assert_eq!(tcs[0].1, "call_1");
        assert_eq!(tcs[0].2, "test");
        assert_eq!(tcs[0].3, r#"{"ops":[]}"#);
    }

    #[test]
    fn parse_sse_multiple_tool_calls() {
        let mut tcs = Vec::new();
        parse_sse_line(
            r#"{"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"fn1","arguments":"{}"}},{"index":1,"id":"call_2","function":{"name":"fn2","arguments":"{}"}}]}}]}"#,
            &mut tcs
        );
        assert_eq!(tcs.len(), 2);
        assert_eq!(tcs[0].1, "call_1");
        assert_eq!(tcs[1].1, "call_2");
    }

    #[test]
    fn parse_sse_skips_invalid_json() {
        let mut tcs = Vec::new();
        let (content, done) = parse_sse_line("not json", &mut tcs);
        assert!(content.is_none());
        assert!(!done);
        assert!(tcs.is_empty());
    }

    #[test]
    fn parse_sse_multiple_indices() {
        let mut tcs = Vec::new();
        // Tool call at index 0
        parse_sse_line(
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"f1","arguments":"{}"}}]}}]}"#,
            &mut tcs
        );
        // Tool call at index 1 starts while index 0 is open
        parse_sse_line(
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"f2","arguments":"{}"}}]}}]}"#,
            &mut tcs
        );
        assert_eq!(tcs.len(), 2, "tcs should have 2 entries after two tool calls at different indices");
        assert_eq!(tcs[0].2, "f1");
        assert_eq!(tcs[1].2, "f2");
    }

    #[test]
    fn parse_sse_text_and_tool_call_mixed() {
        let mut tcs = Vec::new();
        let (content, _done) = parse_sse_line(
            r#"{"choices":[{"index":0,"delta":{"content":"Hello","tool_calls":[{"index":0,"id":"c1","function":{"name":"fn","arguments":"{}"}}]}}]}"#,
            &mut tcs
        );
        assert_eq!(content, Some("Hello".to_string()));
        assert_eq!(tcs.len(), 1);
    }
}

#[cfg(test)]
mod sse_chunking {
    /** Simulate the byte-buffered SSE parse: feed chunks that split events AND multi-byte UTF-8 chars. */
    fn parse_sse_chunks(chunks: Vec<&str>) -> (String, Vec<(i64, String, String, String)>) {
        let mut byte_buf: Vec<u8> = Vec::new();
        let mut full = String::new();
        let tool_calls: Vec<(i64, String, String, String)> = Vec::new();
        for chunk in chunks {
            byte_buf.extend_from_slice(chunk.as_bytes());
            let mut start = 0;
            while let Some(pos) = byte_buf[start..].iter().position(|&b| b == b'\n') {
                let line_end = start + pos;
                let line = String::from_utf8_lossy(&byte_buf[start..line_end]);
                let data = line.trim_end_matches('\r').strip_prefix("data: ").unwrap_or("");
                if !data.is_empty() {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(data) {
                        if let Some(content) = val["choices"][0]["delta"]["content"].as_str() {
                            full.push_str(content);
                        }
                    }
                }
                start = line_end + 1;
            }
            byte_buf.drain(..start);
        }
        if !byte_buf.is_empty() {
            let line = String::from_utf8_lossy(&byte_buf);
            let data = line.trim_end_matches('\r').strip_prefix("data: ").unwrap_or("");
            if !data.is_empty() {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(content) = val["choices"][0]["delta"]["content"].as_str() {
                        full.push_str(content);
                    }
                }
            }
        }
        (full, tool_calls)
    }

    #[test]
    fn sse_event_split_across_chunks_is_reassembled() {
        // One event split mid-JSON across 3 chunks (the exact failure mode)
        let event = r#"data: {"choices":[{"delta":{"content":"Menghantui"}}]}"#;
        let chunks = vec![
            &event[..20],
            &event[20..40],
            &event[40..],
        ];
        let (full, _) = parse_sse_chunks(chunks);
        assert_eq!(full, "Menghantui", "content must survive chunk boundaries");
    }

    #[test]
    fn sse_multiple_events_in_one_chunk() {
        let chunks = vec![
            "data: {\"choices\":[{\"delta\":{\"content\":\"Halo \"}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"dunia\"}}]}\ndata: [DONE]\n",
        ];
        let (full, _) = parse_sse_chunks(chunks);
        assert_eq!(full, "Halo dunia");
    }

    #[test]
    fn sse_partial_at_end_completes_with_next_chunk() {
        // First chunk ends with partial event (no newline), second completes it
        let first = r#"data: {"choices":[{"delta":{"content":"padahal"#;
        let second = r#" yang"}}]}"#;
        let (full, _) = parse_sse_chunks(vec![first, second]);
        assert_eq!(full, "padahal yang");
    }
}

#[cfg(test)]
mod sse_utf8_chunking {
    /** Feed chunks that split a multi-byte UTF-8 char (é = 0xC3 0xA9) mid-boundary. */
    fn parse_utf8_chunks(chunks: Vec<Vec<u8>>) -> String {
        let mut byte_buf: Vec<u8> = Vec::new();
        let mut full = String::new();
        for chunk in chunks {
            byte_buf.extend_from_slice(&chunk);
            let mut start = 0;
            while let Some(pos) = byte_buf[start..].iter().position(|&b| b == b'\n') {
                let line_end = start + pos;
                let line = String::from_utf8_lossy(&byte_buf[start..line_end]);
                let data = line.trim_end_matches('\r').strip_prefix("data: ").unwrap_or("");
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(content) = val["choices"][0]["delta"]["content"].as_str() {
                        full.push_str(content);
                    }
                }
                start = line_end + 1;
            }
            byte_buf.drain(..start);
        }
        full
    }

    #[test]
    fn utf8_char_split_across_chunks_survives() {
        // "café" — the é (0xC3 0xA9) is split across two chunks.
        // Event bytes: data: {"choices":[{"delta":{"content":"café"}}]}\n
        let line = b"data: {\"choices\":[{\"delta\":{\"content\":\"caf\xc3\xa9\"}}]}\n";
        // split mid-é: first chunk ends after 0xC3, second starts with 0xA9
        let split_at = line.len() - 3; // before the final 0xA9 of é + "}}\n"
        let chunks = vec![line[..split_at].to_vec(), line[split_at..].to_vec()];
        assert_eq!(parse_utf8_chunks(chunks), "café");
    }

    #[test]
    fn crlf_line_endings_handled() {
        let line = b"data: {\"choices\":[{\"delta\":{\"content\":\"halo\"}}]}\r\n";
        assert_eq!(parse_utf8_chunks(vec![line.to_vec()]), "halo");
    }
}

#[cfg(test)]
mod security_tests {
    use super::*;

    fn has(hay: &str, needle: &str) -> bool { hay.contains(needle) }

    #[test]
    fn markdown_xss_payloads_are_neutralized() {
        // raw script tag → escaped text, no executable script element
        let out = markdown_to_safe_html("<script>alert(1)</script>");
        assert!(!has(&out, "<script"), "script tag survived: {out}");
        assert!(!has(&out, "<script>alert"), "script content leaked: {out}");

        // event handler attribute stripped
        let out = markdown_to_safe_html("<img src=x onerror=alert(1)>");
        assert!(!has(&out, "onerror"), "onerror survived: {out}");

        // javascript: link URL neutralized
        let out = markdown_to_safe_html("[click](javascript:alert(1))");
        assert!(!has(&out, "javascript:"), "javascript: URL survived: {out}");

        // iframe dropped
        let out = markdown_to_safe_html("<iframe src=https://evil></iframe>");
        assert!(!has(&out, "iframe"), "iframe survived: {out}");
    }


    #[test]
    fn ai_error_contract_is_user_safe() {
        // raw provider/transport details are never leaked
        assert!(!sanitize_ai_error("error sending request for url (https://internal.corp:8080/chat/completions): connection refused").contains("internal.corp"));
        assert!(sanitize_ai_error("connection refused").contains("Could not reach"));
        assert!(sanitize_ai_error("operation timed out after 120s").contains("timed out"));
        assert!(sanitize_ai_error("TLS handshake failed").contains("Secure connection"));
        assert!(!sanitize_ai_error("random error xyz").contains("random error"));
        assert!(sanitize_ai_error("random error xyz").contains("AI request failed"));
    }

    #[test]
    fn markdown_safe_content_still_renders() {
        let out = markdown_to_safe_html("# Title\n\n**bold** and [link](https://example.com)");
        assert!(has(&out, "<h1"), "heading lost: {out}");
        assert!(has(&out, "<strong>"), "bold lost: {out}");
        assert!(has(&out, "<a href=\"https://example.com\""), "link lost: {out}");
    }
}

/** Snapshot tests — full HTML contract of markdown_to_safe_html (md_to_html /
 *  preview path). Deterministic: no timestamps/UUIDs in output.
 *  UPDATE POLICY: regenerate ONLY on an intentional rendering change
 *  (deliberate pulldown-cmark/ammonia upgrade). A snapshot diff in a
 *  feature/refactor PR = unintended contract drift — fix the code, not the
 *  snapshot. To update deliberately: cargo shows the diff; paste the new
 *  output into the const below. */
#[cfg(test)]
mod snapshot_tests {
    use super::*;

    const RICH_GFM: &str = "# Title\n\nSome **bold**, *italic*, ~~strike~~, `code`, and [link](https://example.com).\n\n> Quote\n\n- item one\n- item two\n\n1. first\n2. second\n\n```rust\nfn main() {}\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] open\n";

    // SNAPSHOTS — regenerate only per update policy above. Values captured
    // from the current pulldown-cmark + ammonia pipeline (v0.13.x / current).
    const RICH_HTML: &str = "<h1>Title</h1>\n<p>Some <strong>bold</strong>, <em>italic</em>, <del>strike</del>, <code>code</code>, and <a href=\"https://example.com\" rel=\"noopener noreferrer\">link</a>.</p>\n<blockquote>\n<p>Quote</p>\n</blockquote>\n<ul>\n<li>item one</li>\n<li>item two</li>\n</ul>\n<ol>\n<li>first</li>\n<li>second</li>\n</ol>\n<pre><code>fn main() {}\n</code></pre>\n<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>\n<tr><td>1</td><td>2</td></tr>\n</tbody></table>\n<ul>\n<li>\ndone</li>\n<li>\nopen</li>\n</ul>\n";

    const XSS_HTML: &str = "\n<img src=\"x\">\n<p><a rel=\"noopener noreferrer\">click</a></p>\n";

    #[test]
    fn rich_gfm_html_snapshot() {
        assert_eq!(markdown_to_safe_html(RICH_GFM), RICH_HTML);
    }

    #[test]
    fn xss_payload_html_snapshot() {
        assert_eq!(
            markdown_to_safe_html("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1))"),
            XSS_HTML
        );
    }

    #[test]
    fn empty_html_snapshot() {
        // SNAPSHOT — regenerate only per update policy above
        assert_eq!(markdown_to_safe_html(""), "");
    }
}
