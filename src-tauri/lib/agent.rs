//! Tauri AI commands: credentials, model discovery, connection tests, and the
//! thin desktop adapter around the shared `rust_ai` streaming transport.
//!
//! The non-secret AI selection (active provider, every endpoint's base URL and
//! model, measured probes) lives in `ai-settings.json` in the app config dir —
//! the desktop analog of the web build's `ai/config` block in `config.json`.
//! The macOS keychain holds ONLY API keys, so a base URL survives a keychain
//! reset and a webview storage wipe alike.

use crate::AppState;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

const MAX_PROBE_MODELS_PER_PROVIDER: usize = 128;
const MAX_PROBE_ID_LEN: usize = 256;

fn validate_probe_id(provider: &str, model: &str) -> Result<(), String> {
    if provider.is_empty() || model.is_empty() {
        return Err("Provider and model are required for a probe result".into());
    }
    if provider.len() > MAX_PROBE_ID_LEN || model.len() > MAX_PROBE_ID_LEN {
        return Err(format!("Provider and model IDs must be at most {MAX_PROBE_ID_LEN} bytes"));
    }
    Ok(())
}

fn pin_custom_endpoint(
    builder: reqwest::ClientBuilder,
    provider: &str,
    base_url: &str,
) -> Result<reqwest::ClientBuilder, String> {
    if provider != crate::agent::CUSTOM_PROVIDER_ID {
        crate::agent::validate_base_url(base_url)?;
        return Ok(builder);
    }
    let (host, addrs) = crate::agent::validated_custom_addrs(base_url, true)?;
    Ok(builder.resolve_to_addrs(&host, &addrs))
}

// ── Keychain / model discovery ──

#[tauri::command]
pub async fn list_api_keys(providers: Vec<String>) -> Result<String, String> {
    let keys = tauri::async_runtime::spawn_blocking(move || crate::keychain::list_keys(&providers))
        .await
        .map_err(|e| e.to_string())??;
    serde_json::to_string(&keys).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_api_key(
    app: tauri::AppHandle,
    provider: &str,
    key: &str,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<(), String> {
    let previous_key = crate::keychain::get_key(provider).ok();
    let previous_selection = load_selection(&app);
    if previous_key.is_some() && previous_selection.endpoints.contains_key(provider) {
        return Err("Provider is already configured; revoke it before changing settings".into());
    }
    crate::keychain::set_key(provider, key)?;
    // The endpoint records where the key will actually be sent. An omitted URL
    // (catalog provider, UI did not send one) must NOT erase a URL already on
    // file — `validate_base_url` re-checks it at send time either way.
    let mut selection = load_selection(&app);
    {
        let endpoint = selection.endpoints.entry(provider.to_string()).or_default();
        endpoint.model = model.as_deref().unwrap_or("").to_string();
        if let Some(url) = base_url.filter(|u| !u.is_empty()) {
            endpoint.base_url = url;
        }
    }
    selection.active = provider.to_string();
    if let Err(error) = write_selection(&app, &selection) {
        restore_key(provider, previous_key.as_deref());
        restore_selection(&app, &previous_selection);
        return Err(format!("API key saved, but AI selection could not be persisted: {error}"));
    }
    Ok(())
}

/** Decode the selection file, tolerating anything malformed: a hand-edited or
 *  older `ai-settings.json` must never fail the load over non-essential state. */
fn load_selection(app: &tauri::AppHandle) -> AiSelection {
    parse_selection(
        selection_path(app)
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .as_deref()
            .unwrap_or(""),
    )
}

/** Decode the persisted selection, migrating the legacy shape when needed. */
fn parse_selection(raw: &str) -> AiSelection {
    let value: serde_json::Value = serde_json::from_str(raw).unwrap_or(serde_json::Value::Null);
    // `endpoints` is the current shape; anything else is a file written before
    // multi-endpoint support, which is migrated rather than discarded.
    if let Some(endpoints) = value.get("endpoints").and_then(|v| v.as_object()) {
        // Per-entry decode, not `from_value` on the whole object: one malformed
        // endpoint must not discard the good ones. The UI reads this payload as
        // authoritative, so dropping everything would look like "nothing is
        // configured" and invite a duplicate save.
        let endpoints = endpoints
            .iter()
            .filter_map(|(provider, endpoint)| {
                serde_json::from_value(endpoint.clone())
                    .ok()
                    .map(|parsed| (provider.clone(), parsed))
            })
            .collect();
        let active = value
            .get("active")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        return AiSelection { active, endpoints };
    }
    migrate_legacy_selection(&value)
}

/** Legacy `{provider, model, probes: {provider: {model: bool}}}` → endpoints.
 *
 *  The old shape kept ONE model and one probe tree for every provider ever probed,
 *  so no provider identity is lost: each probed provider becomes an endpoint. The
 *  legacy `model` belongs to the selected provider only — copying it onto the
 *  others would claim a model they were never used with. Base URLs start empty:
 *  they lived in the keychain and are folded in by `migrate_base_urls`. */
fn migrate_legacy_selection(value: &serde_json::Value) -> AiSelection {
    let active = value.get("provider").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let model = value.get("model").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let mut out = AiSelection { active: active.clone(), endpoints: std::collections::BTreeMap::new() };
    if let Some(probes) = value.get("probes").and_then(|v| v.as_object()) {
        for (provider, models) in probes {
            let Some(models) = models.as_object() else { continue };
            out.endpoints.insert(provider.clone(), AiEndpoint {
                base_url: String::new(),
                model: if *provider == active { model.clone() } else { String::new() },
                probes: parse_probe_map(models),
            });
        }
    }
    // A provider selected but never probed still has to survive the migration,
    // otherwise the UI cannot recover the selection it lost.
    if !active.is_empty() && !out.endpoints.contains_key(&active) {
        out.endpoints.insert(active, AiEndpoint { base_url: String::new(), model, probes: Default::default() });
    }
    out
}

/** Decode one `model → supports tools` map, dropping non-bool entries. */
fn parse_probe_map(
    models: &serde_json::Map<String, serde_json::Value>,
) -> std::collections::BTreeMap<String, bool> {
    models
        .iter()
        .filter_map(|(model, tools)| tools.as_bool().map(|t| (model.clone(), t)))
        .collect()
}

/** One configured AI endpoint: where it lives and what it was last used with.
 *  Non-secret, so it belongs in `ai-settings.json` rather than the keychain
 *  (which holds only credentials). */
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct AiEndpoint {
    #[serde(rename = "baseUrl", default)]
    base_url: String,
    #[serde(default)]
    model: String,
    /** Measured tool-call support model → supports tools, from the test_connection
     *  probe. Expensive to re-measure (an extra round-trip per model), so it is
     *  persisted here rather than in webview localStorage: a wiped webview would
     *  otherwise run text-only until every model re-probed. Nested under the
     *  endpoint because support is a property of the gateway+model pair. */
    #[serde(default)]
    probes: std::collections::BTreeMap<String, bool>,
}

/** Every AI endpoint the desktop knows about, plus which one chat uses. Multiple
 *  endpoints stay valid at once (like Zed), so switching providers does not
 *  destroy the other provider's base URL. */
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct AiSelection {
    #[serde(default)]
    active: String,
    #[serde(default)]
    endpoints: std::collections::BTreeMap<String, AiEndpoint>,
}

fn selection_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("No config directory available: {e}"))?;
    Ok(dir.join("ai-settings.json"))
}

fn restore_selection(app: &tauri::AppHandle, selection: &AiSelection) {
    let _ = write_selection(app, selection);
}

/** Record a measured probe outcome (endpoint → model → supports tools). Merged
 *  into the existing map so probing one model never drops the others. The endpoint
 *  is created empty when absent: an auto-probe can run before the provider is
 *  configured, and it would otherwise be dropped. */
fn save_probe(
    app: &tauri::AppHandle,
    provider: &str,
    model: &str,
    tools: bool,
) -> Result<(), String> {
    validate_probe_id(provider, model)?;
    let mut selection = load_selection(app);
    let endpoint = selection.endpoints.entry(provider.to_string()).or_default();
    if !endpoint.probes.contains_key(model) && endpoint.probes.len() >= MAX_PROBE_MODELS_PER_PROVIDER {
        return Err(format!(
            "At most {MAX_PROBE_MODELS_PER_PROVIDER} models per provider are supported"
        ));
    }
    endpoint.probes.insert(model.to_string(), tools);
    write_selection(app, &selection)
}

fn write_selection(app: &tauri::AppHandle, s: &AiSelection) -> Result<(), String> {
    let path = selection_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(s).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Cannot write {}: {e}", path.display()))
}

/** Move legacy base URLs out of the keychain and into the selection file.
 *
 *  Runs on every settings read because the app has no init hook that can reach the
 *  keychain before the UI asks. A base URL is not a secret, so leaving it in the
 *  keychain is the bug being fixed: it vanished on a keychain reset and could not be
 *  shared with a second device. Candidates are the catalog ids plus whatever the
 *  selection file already knows, which is exactly the set of providers that can have
 *  a key. Never clobbers a URL already on file, so a re-run (or a user-edited file)
 *  always wins over the stale keychain entry; idempotent once the entries are gone. */
fn migrate_base_urls(app: &tauri::AppHandle) -> Result<(), String> {
    let mut selection = load_selection(app);
    let mut candidates: Vec<String> =
        crate::agent::PROVIDER_IDS.iter().map(|p| p.to_string()).collect();
    candidates.extend(selection.endpoints.keys().cloned());
    candidates.push(crate::agent::CUSTOM_PROVIDER_ID.to_string());
    let migrated = crate::keychain::migrate_base_urls(&candidates);
    if migrated.is_empty() {
        return Ok(());
    }
    for (provider, url) in migrated {
        let endpoint = selection.endpoints.entry(provider).or_default();
        if endpoint.base_url.is_empty() {
            endpoint.base_url = url;
        }
    }
    write_selection(app, &selection)
}

/** Resolve the base URL a provider's requests go to. Order: the selection file (it
 *  is authoritative and identifies the gateway the measurements belong to), then
 *  the URL the caller supplied, then the catalog default so a first save works
 *  without the UI having to know the canonical URL. */
fn resolve_base_url(selection: &AiSelection, provider: &str, supplied: &str) -> Result<String, String> {
    if let Some(url) = selection
        .endpoints
        .get(provider)
        .map(|e| e.base_url.clone())
        .filter(|u| !u.is_empty())
    {
        return Ok(url);
    }
    if !supplied.is_empty() {
        return Ok(supplied.to_string());
    }
    crate::agent::catalog_base_url(provider)
        .map(|u| u.to_string())
        .ok_or_else(|| "Base URL is required".to_string())
}

/** Providers that hold a key: the catalog ids plus every endpoint in the selection
 *  file (a custom endpoint is configured by its presence there, not by a catalog
 *  id). Counted without spawning one `security` process per provider. */
fn saved_providers(selection: &AiSelection) -> Result<Vec<String>, String> {
    let mut providers: Vec<String> =
        crate::agent::PROVIDER_IDS.iter().map(|p| p.to_string()).collect();
    for provider in selection.endpoints.keys() {
        if !providers.iter().any(|p| p == provider) {
            providers.push(provider.clone());
        }
    }
    crate::keychain::list_keys(&providers)
}

fn restore_key(provider: &str, key: Option<&str>) {
    match key {
        Some(key) => { let _ = crate::keychain::set_key(provider, key); }
        None => { let _ = crate::keychain::delete_key(provider); }
    }
}

#[tauri::command]
pub fn set_ai_settings(
    app: tauri::AppHandle,
    provider: &str,
    model: &str,
) -> Result<String, String> {
    // Selection only: an endpoint is created by `set_api_key` /
    // `set_custom_endpoint`, so switching providers cannot mint one with no URL.
    let mut selection = load_selection(&app);
    selection.active = provider.to_string();
    if !model.is_empty() {
        if let Some(endpoint) = selection.endpoints.get_mut(provider) {
            endpoint.model = model.to_string();
        }
    }
    write_selection(&app, &selection).map(|_| "null".into())
}

/** Record one probe result — the incremental path used by the auto-probe and by
 *  API-key save, which measure a single model at a time. Does NOT touch the
 *  selection: the probe is keyed by provider+model and arriving here does not mean
 *  the user switched to that model. */
#[tauri::command]
pub fn set_probe(
    app: tauri::AppHandle,
    provider: &str,
    model: &str,
    tools: bool,
) -> Result<String, String> {
    save_probe(&app, provider, model, tools).map(|_| "null".into())
}

/** Non-secret AI configuration: every configured endpoint (URL, model, measured
 *  probes, whether a key is held) and which one is active. The webview re-reads
 *  this on every load, because its localStorage cannot be trusted to survive a
 *  browser/device change. */
#[tauri::command]
pub async fn ai_settings(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Fold any legacy keychain base URL in before reading, so the caller sees
        // the migrated value in this same response.
        migrate_base_urls(&app)?;
        let selection = load_selection(&app);
        let saved = saved_providers(&selection)?;
        let endpoints = selection
            .endpoints
            .iter()
            .map(|(provider, endpoint)| {
                // `hasKey` is per endpoint: a configured URL with no credential is
                // shown as incomplete rather than ready.
                (provider.clone(), serde_json::json!({
                    "baseUrl": endpoint.base_url,
                    "model": endpoint.model,
                    "probes": endpoint.probes,
                    "hasKey": saved.contains(provider),
                }))
            })
            .collect::<serde_json::Map<_, _>>();
        Ok(serde_json::json!({
            // Resolved, not echoed: a hand-edited file can point `active` at an
            // endpoint that is no longer there.
            "active": if selection.endpoints.contains_key(&selection.active) {
                selection.active.clone()
            } else {
                String::new()
            },
            "endpoints": endpoints,
            "savedProviders": saved,
        })
        .to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runtime model discovery. API keys stay in the keychain, never in webview state.
#[tauri::command]
pub async fn list_models(
    app: tauri::AppHandle,
    provider: String,
    base_url: String,
) -> Result<String, String> {
    let resolved = resolve_base_url(&load_selection(&app), &provider, &base_url)?;
    let key = crate::keychain::get_key(&provider)
        .map_err(|_| "No API key found — save one in Settings -> AI".to_string())?;
    let client = pin_custom_endpoint(
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(10)),
        &provider,
        &resolved,
    )?
    .build()
    .map_err(|e| format!("Client error: {}", e))?;
    let models = crate::agent::fetch_models(&client, &provider, &resolved, &key).await?;
    serde_json::to_string(&models).map_err(|e| e.to_string())
}

/** Save a custom endpoint and bind its key to that endpoint. */
#[tauri::command]
pub fn set_custom_endpoint(
    app: tauri::AppHandle,
    provider: &str,
    base_url: &str,
    key: &str,
    model: Option<String>,
) -> Result<(), String> {
    crate::agent::validate_custom_base_url(base_url, true)?;
    let previous_key = crate::keychain::get_key(provider).ok();
    let previous_selection = load_selection(&app);
    if previous_key.is_some() && previous_selection.endpoints.contains_key(provider) {
        return Err("Provider is already configured; revoke it before changing settings".into());
    }
    crate::keychain::set_key(provider, key)?;
    let mut selection = load_selection(&app);
    {
        // Probes survive: they were measured against this gateway+model and stay
        // valid when only the key or URL is re-entered.
        let endpoint = selection.endpoints.entry(provider.to_string()).or_default();
        endpoint.base_url = base_url.to_string();
        endpoint.model = model.as_deref().unwrap_or("").to_string();
    }
    selection.active = provider.to_string();
    if let Err(error) = write_selection(&app, &selection) {
        restore_key(provider, previous_key.as_deref());
        restore_selection(&app, &previous_selection);
        return Err(format!("API key saved, but AI selection could not be persisted: {error}"));
    }
    Ok(())
}

#[tauri::command]
pub fn custom_ai_config(app: tauri::AppHandle) -> Result<String, String> {
    let base_url = load_selection(&app)
        .endpoints
        .get(crate::agent::CUSTOM_PROVIDER_ID)
        .map(|e| e.base_url.clone())
        .filter(|u| !u.is_empty());
    let has_key = crate::keychain::get_key(crate::agent::CUSTOM_PROVIDER_ID).is_ok();
    // The desktop build has no env override, so the source is always the file. The
    // URL is a saved string, not a live override, so `model` stays null rather than
    // reporting a value the backend would silently substitute.
    Ok(serde_json::json!({ "source": "file", "baseUrl": base_url, "hasKey": has_key, "model": null }).to_string())
}

#[tauri::command]
pub fn delete_api_key(app: tauri::AppHandle, provider: &str) -> Result<(), String> {
    // Total revoke: a key without its endpoint (or an endpoint without its key) is
    // a half-configured provider the UI cannot reason about.
    crate::keychain::delete_key(provider)?;
    let mut selection = load_selection(&app);
    selection.endpoints.remove(provider);
    if selection.active == provider {
        // Cleared rather than reassigned: silently switching chat to another
        // provider would send the next prompt somewhere the user did not choose.
        selection.active.clear();
    }
    write_selection(&app, &selection)
}

// ── Connection test ──

#[tauri::command]
pub async fn test_connection(
    app: tauri::AppHandle,
    provider: String,
    model: String,
    base_url: String,
    api_key: String,
) -> Result<String, String> {
    let api_key = if api_key.is_empty() {
        crate::keychain::get_key(&provider)
            .map_err(|_| "No API key found in keychain".to_string())?
    } else {
        api_key
    };
    // The selection file owns the saved URL (and the catalog the default), so a
    // caller that sends nothing still probes the endpoint chat will actually use.
    let base_url = resolve_base_url(&load_selection(&app), &provider, &base_url)?;
    // OpenCode Go 400s without a session id; every other provider ignores it.
    let session = (provider == crate::agent::SESSION_PROVIDER_ID)
        .then(crate::agent::session_id);
    let client = pin_custom_endpoint(
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(15)),
        &provider,
        &base_url,
    )?
    .build()
    .map_err(|e| format!("Client error: {}", e))?;
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let basic_body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "say ok"}],
        "max_tokens": 8,
    });
    let mut probe = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("User-Agent", crate::agent::AI_USER_AGENT);
    if let Some(session) = &session {
        probe = probe.header("x-opencode-session", *session);
    }
    let res = probe
        .json(&basic_body)
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    if !res.status().is_success() {
        return Err(format!(
            "API error ({}): {}",
            res.status(),
            res.text().await.unwrap_or_default()
        ));
    }

    // Probe the exact nested schema sent by the document-operation tool.
    let mut tool_body = serde_json::json!({
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
                            "items": { "anyOf": [
                                { "type": "object", "properties": { "type": { "const": "update" }, "id": { "type": "string" } }, "required": ["type", "id"], "additionalProperties": false },
                                { "$ref": "#/$defs/BlockOp" }
                            ] }
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
    let mut tool_req = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("User-Agent", crate::agent::AI_USER_AGENT);
    if let Some(session) = &session {
        tool_req = tool_req.header("x-opencode-session", *session);
    }
    let tool_res = tool_req
        .json(&tool_body)
        .send()
        .await
        .map_err(|e| format!("Tool test failed: {}", e))?;
    if !tool_res.status().is_success() {
        tool_body["tool_choice"] = serde_json::json!("auto");
        let mut retry = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("User-Agent", crate::agent::AI_USER_AGENT);
        if let Some(session) = &session {
            retry = retry.header("x-opencode-session", *session);
        }
        if let Ok(resp) = retry
            .json(&tool_body)
            .send()
            .await
        {
            if resp.status().is_success() {
                let text = resp.text().await.map_err(|e| e.to_string())?;
                if text.contains("tool_calls") || text.contains("test_tool") {
                    return Ok(r#"{"status":"ok","tools":true}"#.to_string());
                }
            }
        }
        return Ok(r#"{"status":"ok","tools":false}"#.to_string());
    }
    let text = tool_res.text().await.map_err(|e| e.to_string())?;
    let supports_tools = text.contains("tool_calls") || text.contains("test_tool");
    Ok(format!(r#"{{"status":"ok","tools":{}}}"#, supports_tools))
}

// ── Shared streaming adapter ──

#[tauri::command]
pub async fn ask_ai(
    messages: String,
    app: tauri::AppHandle,
    provider: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    _api_key: Option<String>,
    tools: Option<String>,
) -> Result<(), String> {
    let provider =
        provider.ok_or_else(|| "Provider, model, and base URL are required".to_string())?;
    let model = model.ok_or_else(|| "Provider, model, and base URL are required".to_string())?;
    // Single source of truth for where the request goes.
    let resolved = resolve_base_url(
        &load_selection(&app),
        &provider,
        base_url.as_deref().unwrap_or(""),
    )?;
    let mut custom_resolution = None;
    let agent = if provider == crate::agent::CUSTOM_PROVIDER_ID {
        custom_resolution = Some(crate::agent::validated_custom_addrs(&resolved, true)?);
        let key =
            crate::keychain::get_key(&provider).map_err(|_| "No API key found in keychain")?;
        crate::agent::Agent::new(&provider, &model, &key, &resolved)
    } else {
        crate::agent::validate_base_url(&resolved)?;
        let key =
            crate::keychain::get_key(&provider).map_err(|_| "No API key found in keychain")?;
        crate::agent::Agent::new(&provider, &model, &key, &resolved)
    };

    let state = app.state::<AppState>();
    state.ai_cancel.store(false, Ordering::SeqCst);
    let started = std::time::Instant::now();
    let mut client_builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(120));
    if let Some((host, addrs)) = &custom_resolution {
        client_builder = client_builder.resolve_to_addrs(host, addrs);
    }
    let client = client_builder
        .build()
        .map_err(|e| format!("Client error: {}", e))?;
    let request = crate::rust_ai::request::AiRequest::from_json(
        agent.model.clone(),
        agent.api_key.clone(),
        agent.base_url.clone(),
        &messages,
        tools.as_deref(),
    )?;
    let mut chat = client
        .post(request.url())
        .header("Authorization", format!("Bearer {}", request.api_key))
        .header("User-Agent", crate::agent::AI_USER_AGENT);
    if provider == crate::agent::SESSION_PROVIDER_ID {
        chat = chat.header("x-opencode-session", crate::agent::session_id());
    }
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        chat.json(&request.body()).send(),
    )
    .await
    .map_err(|_| "AI provider did not respond — try again".to_string())?
    .map_err(|e| crate::rust_ai::error::sanitize_ai_error(&e.to_string()))?;

    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let cancel = Arc::clone(&state.ai_cancel);
    tokio::spawn(crate::rust_ai::sse::stream_chat(
        response,
        agent.provider.clone(),
        agent.model.clone(),
        cancel,
        started,
        tx,
    ));
    while let Some(event) = rx.recv().await {
        match event {
            Ok(crate::rust_ai::events::AiEvent::Token(token)) => {
                app.emit(crate::rust_ai::events::TOKEN_EVENT, token)
                    .map_err(|e| e.to_string())?;
            }
            Ok(crate::rust_ai::events::AiEvent::ToolCall {
                tool_call_id,
                tool_name,
                input,
            }) => {
                app.emit(
                    crate::rust_ai::events::TOOL_CALL_EVENT,
                    serde_json::json!({
                        "toolCallId": tool_call_id,
                        "toolName": tool_name,
                        "input": input,
                    }),
                )
                .map_err(|e| e.to_string())?;
            }
            Ok(crate::rust_ai::events::AiEvent::ToolsDone) => {
                app.emit(crate::rust_ai::events::TOOLS_DONE_EVENT, "")
                    .map_err(|e| e.to_string())?;
            }
            Ok(crate::rust_ai::events::AiEvent::Done {
                provider,
                truncated,
            }) => {
                app.emit(
                    crate::rust_ai::events::DONE_EVENT,
                    serde_json::json!({ "provider": provider, "truncated": truncated }),
                )
                .map_err(|e| e.to_string())?;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// Cancel in-flight AI request. Desktop-only policy; web keeps its own request lifecycle.
#[tauri::command]
pub fn cancel_ai(state: State<AppState>) {
    state.ai_cancel.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(base_url: &str, model: &str) -> AiEndpoint {
        AiEndpoint { base_url: base_url.into(), model: model.into(), probes: Default::default() }
    }

    #[test]
    fn pin_custom_endpoint_rejects_non_custom_provider_host() {
        let result = pin_custom_endpoint(
            reqwest::Client::builder(),
            "openai",
            "https://evil.example.com/v1",
        );
        assert!(result.is_err());
    }

    #[test]
    fn legacy_selection_migrates_to_endpoints() {
        // Upgrades must not lose the selection or the measured probes: every probed
        // provider becomes an endpoint, but the legacy model is the active
        // provider's only — copying it onto the others would claim a model they were
        // never used with.
        let raw = r#"{"provider":"anthropic","model":"claude-sonnet-5","probes":{"anthropic":{"claude-sonnet-5":true},"deepseek":{"deepseek-chat":false,"bad":"x"}}}"#;
        let s = parse_selection(raw);
        assert_eq!(s.active, "anthropic");
        assert_eq!(s.endpoints.len(), 2, "every probed provider becomes an endpoint");
        assert_eq!(s.endpoints["anthropic"].model, "claude-sonnet-5");
        assert!(s.endpoints["anthropic"].probes["claude-sonnet-5"]);
        assert_eq!(s.endpoints["deepseek"].model, "", "legacy model belongs to the active provider");
        assert!(!s.endpoints["deepseek"].probes["deepseek-chat"], "probe results migrate");
        assert_eq!(s.endpoints["deepseek"].probes.len(), 1, "non-bool entry dropped");
        assert_eq!(s.endpoints["anthropic"].base_url, "", "base URLs come from the keychain, not the file");
    }

    #[test]
    fn selected_but_unprobed_provider_survives_migration() {
        // A provider selected but never probed still has to survive the migration,
        // or the UI cannot recover the selection it lost.
        let s = parse_selection(r#"{"provider":"google","model":"gemini-3-pro","probes":{}}"#);
        assert_eq!(s.active, "google");
        assert_eq!(s.endpoints["google"].model, "gemini-3-pro");
        assert!(s.endpoints["google"].probes.is_empty());
    }

    #[test]
    fn current_selection_round_trips_with_camel_case_base_url() {
        // The file is a contract with the web build (which writes the same shape in
        // config.json), so the wire key stays `baseUrl` and must not drift.
        let mut s = AiSelection { active: "opencode-go".into(), endpoints: Default::default() };
        let mut probes = std::collections::BTreeMap::new();
        probes.insert("deepseek-v4-flash".to_string(), true);
        s.endpoints.insert("opencode-go".into(), AiEndpoint {
            base_url: "https://opencode.ai/zen/go/v1".into(),
            model: "deepseek-v4-flash".into(),
            probes,
        });
        let raw = serde_json::to_string(&s).unwrap();
        assert!(raw.contains("\"baseUrl\""), "baseUrl is the persisted key");
        let back = parse_selection(&raw);
        assert_eq!(back.active, "opencode-go");
        assert_eq!(back.endpoints["opencode-go"].base_url, "https://opencode.ai/zen/go/v1");
        assert!(back.endpoints["opencode-go"].probes["deepseek-v4-flash"]);
    }

    #[test]
    fn malformed_selection_degrades_to_empty_instead_of_failing() {
        // A hand-edited or truncated file must never fail the settings read: an
        // empty selection is recoverable, a hard error would lock the UI out of AI
        // configuration entirely.
        for raw in ["", "not json", "[]", "{}", r#"{"endpoints":"nope"}"#] {
            let s = parse_selection(raw);
            assert_eq!(s.active, "");
            assert!(s.endpoints.is_empty());
        }
    }

    #[test]
    fn malformed_endpoints_are_skipped_not_fatal() {
        // One bad endpoint entry must not discard the good ones — the UI reads this
        // as authoritative, so dropping the whole payload would look like "nothing
        // is configured" and invite a duplicate save.
        let s = parse_selection(
            r#"{"active":"deepseek","endpoints":{"deepseek":{"baseUrl":"https://api.deepseek.com","model":"m","probes":{"m":true}},"broken":"nope"}}"#,
        );
        assert_eq!(s.endpoints.len(), 1);
        assert_eq!(s.endpoints["deepseek"].model, "m");
        assert_eq!(s.endpoints["deepseek"].probes.len(), 1);
    }

    #[test]
    fn base_url_resolution_prefers_the_selection_file() {
        // The saved URL identifies the gateway the stored probes were measured
        // against, so it wins over a caller-supplied guess.
        let mut s = AiSelection::default();
        s.endpoints.insert("opencode-go".into(), endpoint("https://opencode.ai/zen/go/v1", "m"));
        assert_eq!(
            resolve_base_url(&s, "opencode-go", "https://evil.example.com/v1").unwrap(),
            "https://opencode.ai/zen/go/v1"
        );
    }

    #[test]
    fn base_url_resolution_falls_back_to_the_caller_then_the_catalog() {
        let s = AiSelection::default();
        assert_eq!(
            resolve_base_url(&s, "deepseek", "https://proxy.example.com/v1").unwrap(),
            "https://proxy.example.com/v1"
        );
        // Nothing supplied: the catalog default keeps a first save working without
        // the UI having to know the canonical URL.
        assert_eq!(
            resolve_base_url(&s, "deepseek", "").unwrap(),
            crate::agent::catalog_base_url("deepseek").unwrap()
        );
        // An empty saved URL is not a value — it must not shadow the fallbacks.
        let mut empty = AiSelection::default();
        empty.endpoints.insert("deepseek".into(), endpoint("", "m"));
        assert_eq!(
            resolve_base_url(&empty, "deepseek", "https://proxy.example.com/v1").unwrap(),
            "https://proxy.example.com/v1"
        );
    }

    #[test]
    fn base_url_resolution_rejects_an_unknown_provider_with_no_url() {
        // No saved URL, no caller URL and no catalog entry: a clear error beats
        // sending an API key to an empty host.
        assert!(resolve_base_url(&AiSelection::default(), "invented", "").is_err());
    }
}
