//! Tauri AI commands: credentials, model discovery, connection tests, and the
//! thin desktop adapter around the shared `rust_ai` streaming transport.

use crate::AppState;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

const MAX_PROBE_PROVIDERS: usize = 32;
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
) -> Result<(), String> {
    let previous_key = crate::keychain::get_key(provider).ok();
    let previous_selection = load_selection(&app);
    crate::keychain::set_key(provider, key)?;
    if let Err(error) = save_selection(&app, provider, model.as_deref().unwrap_or("")) {
        restore_key(provider, previous_key.as_deref());
        restore_selection(&app, &previous_selection);
        return Err(format!("API key saved, but AI selection could not be persisted: {error}"));
    }
    Ok(())
}

/** Persist the non-secret AI selection so it survives a webview storage wipe.
 *  The webview's localStorage is cleared with the app's site data, which would
 *  otherwise force the user to re-enter provider + model even though the API key
 *  is still in the keychain. Failure is non-fatal: the settings still work for
 *  this session, only the cross-wipe restore is lost. */
fn save_selection(app: &tauri::AppHandle, provider: &str, model: &str) -> Result<(), String> {
    let mut s = load_selection(app);
    s.provider = provider.to_string();
    s.model = model.to_string();
    write_selection(app, &s)
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct AiSelection {
    provider: String,
    model: String,
    /** Measured tool-call support per provider → model → supports tools, from the
     *  test_connection probe. Non-secret and expensive to re-measure (an extra
     *  round-trip per model), so it lives here rather than in webview localStorage:
     *  a wiped webview would otherwise run text-only until every model re-probed. */
    #[serde(default)]
    probes: std::collections::BTreeMap<String, std::collections::BTreeMap<String, bool>>,
}

fn selection_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("No config directory available: {e}"))?;
    Ok(dir.join("ai-settings.json"))
}

fn load_selection(app: &tauri::AppHandle) -> AiSelection {
    selection_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn restore_selection(app: &tauri::AppHandle, selection: &AiSelection) {
    let _ = save_selection(app, &selection.provider, &selection.model);
}

/** Record a measured probe outcome (provider → model → supports tools). Merged
 *  into the existing map so probing one model never drops the others. */
fn save_probe(
    app: &tauri::AppHandle,
    provider: &str,
    model: &str,
    tools: bool,
) -> Result<(), String> {
    validate_probe_id(provider, model)?;
    let mut s = load_selection(app);
    s.probes
        .entry(provider.to_string())
        .or_default()
        .insert(model.to_string(), tools);
    write_selection(app, &s)
}

fn write_selection(app: &tauri::AppHandle, s: &AiSelection) -> Result<(), String> {
    let path = selection_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(s).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Cannot write {}: {e}", path.display()))
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
    save_selection(&app, provider, model).map(|_| "null".into())
}

/** Batch probe sync (provider → model → supports tools). Merged, never
 *  destructive, so a browser that measured several models can push them all at
 *  once — and a partial payload cannot wipe results it does not mention. */
#[tauri::command]
pub fn set_probes(app: tauri::AppHandle, probes: serde_json::Value) -> Result<String, String> {
    let Some(by_provider) = probes.as_object() else {
        return Err("probes must be an object".into());
    };
    if by_provider.len() > MAX_PROBE_PROVIDERS {
        return Err(format!("At most {MAX_PROBE_PROVIDERS} probe providers are supported"));
    }
    let mut selection = load_selection(&app);
    let mut accepted = 0usize;
    for (provider, models) in by_provider {
        let Some(models) = models.as_object() else { continue };
        if models.len() > MAX_PROBE_MODELS_PER_PROVIDER {
            return Err(format!("At most {MAX_PROBE_MODELS_PER_PROVIDER} models per provider are supported"));
        }
        for (model, tools) in models {
            let Some(tools) = tools.as_bool() else { continue };
            validate_probe_id(provider, model)?;
            if !selection.probes.contains_key(provider)
                && selection.probes.len() >= MAX_PROBE_PROVIDERS
            {
                return Err(format!("At most {MAX_PROBE_PROVIDERS} probe providers are supported"));
            }
            let models = selection.probes.entry(provider.clone()).or_default();
            if !models.contains_key(model) && models.len() >= MAX_PROBE_MODELS_PER_PROVIDER {
                return Err(format!("At most {MAX_PROBE_MODELS_PER_PROVIDER} models per provider are supported"));
            }
            models.insert(model.clone(), tools);
            accepted += 1;
        }
    }
    if accepted > 0 {
        write_selection(&app, &selection)?;
    }
    Ok(serde_json::json!({ "accepted": accepted }).to_string())
}

/** Record one probe result — the incremental path used by the auto-probe and by
 *  API-key save, which measure a single model at a time. */
#[tauri::command]
pub fn set_probe(
    app: tauri::AppHandle,
    provider: &str,
    model: &str,
    tools: bool,
) -> Result<String, String> {
    save_probe(&app, provider, model, tools).map(|_| "null".into())
}

/** Non-secret AI selection + which catalog providers hold a key. The webview
 *  re-reads this on every load, because its localStorage cannot be trusted to
 *  survive a browser/device change. */
#[tauri::command]
pub async fn ai_settings(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = load_selection(&app);
        let providers: Vec<String> = crate::agent::PROVIDER_IDS.iter().map(|p| p.to_string()).collect();
        let mut saved = crate::keychain::list_keys(&providers)?;
        let custom = crate::keychain::active_provider();
        if let Some(id) = &custom {
            if !saved.contains(id) {
                saved.push(id.clone());
            }
        }
        // The bound endpoint URL lives in the keychain with the key, not in the
        // selection file, so a fresh webview can still reach the endpoint.
        let base_url = custom.as_deref().and_then(|p| crate::keychain::get_base_url(p).ok());
        Ok(serde_json::json!({
            "provider": s.provider,
            "model": s.model,
            "savedProviders": saved,
            "baseUrl": base_url,
            // Measured tool-call support, so a wiped webview does not run
            // text-only until every model is re-probed.
            "probes": s.probes,
        })
        .to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runtime model discovery. API keys stay in the keychain, never in webview state.
#[tauri::command]
pub async fn list_models(provider: String, base_url: String) -> Result<String, String> {
    if base_url.is_empty() {
        return Err("Base URL is required".into());
    }
    let key = crate::keychain::get_key(&provider)
        .map_err(|_| "No API key found — save one in Settings -> AI".to_string())?;
    let client = pin_custom_endpoint(
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(10)),
        &provider,
        &base_url,
    )?
    .build()
    .map_err(|e| format!("Client error: {}", e))?;
    let models = crate::agent::fetch_models(&client, &base_url, &key).await?;
    serde_json::to_string(&models).map_err(|e| e.to_string())
}

/** Save custom endpoint and bind its key to that endpoint server-side. */
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
    let previous_base_url = crate::keychain::get_base_url(provider).ok();
    let previous_selection = load_selection(&app);
    crate::keychain::set_base_url(provider, base_url)?;
    if let Err(error) = crate::keychain::set_key(provider, key) {
        restore_base_url(provider, previous_base_url.as_deref());
        return Err(error);
    }
    if let Err(error) = save_selection(&app, provider, model.as_deref().unwrap_or("")) {
        restore_key(provider, previous_key.as_deref());
        restore_base_url(provider, previous_base_url.as_deref());
        restore_selection(&app, &previous_selection);
        return Err(format!("API key saved, but AI selection could not be persisted: {error}"));
    }
    Ok(())
}

fn restore_base_url(provider: &str, url: Option<&str>) {
    match url {
        Some(url) => { let _ = crate::keychain::set_base_url(provider, url); }
        None => { let _ = crate::keychain::delete_base_url(provider); }
    }
}

#[tauri::command]
pub fn custom_ai_config() -> Result<String, String> {
    let base_url = crate::keychain::get_base_url(crate::agent::CUSTOM_PROVIDER_ID).ok();
    let has_key = crate::keychain::get_key(crate::agent::CUSTOM_PROVIDER_ID).is_ok();
    Ok(serde_json::json!({ "source": "file", "baseUrl": base_url, "hasKey": has_key, "model": null }).to_string())
}

#[tauri::command]
pub fn delete_api_key(provider: &str) -> Result<(), String> {
    let _ = crate::keychain::delete_base_url(provider);
    crate::keychain::delete_key(provider)
}

// ── Connection test ──

#[tauri::command]
pub async fn test_connection(
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
    let base_url = if base_url.is_empty() && provider == crate::agent::CUSTOM_PROVIDER_ID {
        crate::keychain::get_base_url(&provider)
            .map_err(|_| "No custom base URL saved — set it in Settings → AI".to_string())?
    } else {
        base_url
    };
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
    let res = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
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
    let tool_res = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&tool_body)
        .send()
        .await
        .map_err(|e| format!("Tool test failed: {}", e))?;
    if !tool_res.status().is_success() {
        tool_body["tool_choice"] = serde_json::json!("auto");
        if let Ok(resp) = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
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
    let base_url =
        base_url.ok_or_else(|| "Provider, model, and base URL are required".to_string())?;
    let mut custom_resolution = None;
    let agent = if provider == crate::agent::CUSTOM_PROVIDER_ID {
        let bound_url = crate::keychain::get_base_url(&provider)
            .map_err(|_| "No custom base URL saved — set it in Settings → AI")?;
        custom_resolution = Some(crate::agent::validated_custom_addrs(&bound_url, true)?);
        let key =
            crate::keychain::get_key(&provider).map_err(|_| "No API key found in keychain")?;
        crate::agent::Agent::new(&provider, &model, &key, &bound_url)
    } else {
        crate::agent::validate_base_url(&base_url)?;
        let key =
            crate::keychain::get_key(&provider).map_err(|_| "No API key found in keychain")?;
        crate::agent::Agent::new(&provider, &model, &key, &base_url)
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
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        client
            .post(request.url())
            .header("Authorization", format!("Bearer {}", request.api_key))
            .json(&request.body())
            .send(),
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

    #[test]
    fn pin_custom_endpoint_rejects_non_custom_provider_host() {
        let result = pin_custom_endpoint(
            reqwest::Client::builder(),
            "openai",
            "https://evil.example.com/v1",
        );
        assert!(result.is_err());
    }
}
