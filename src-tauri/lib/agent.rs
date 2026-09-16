//! Tauri AI commands: credentials, model discovery, connection tests, and the
//! thin desktop adapter around the shared `rust_ai` streaming transport.

use crate::AppState;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

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
pub fn set_api_key(provider: &str, key: &str) -> Result<(), String> {
    crate::keychain::set_key(provider, key)
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

/// Save custom endpoint and bind its key to that endpoint server-side.
#[tauri::command]
pub fn set_custom_endpoint(provider: &str, base_url: &str, key: &str) -> Result<(), String> {
    crate::agent::validate_custom_base_url(base_url, true)?;
    crate::keychain::set_base_url(provider, base_url)?;
    crate::keychain::set_key(provider, key)
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
