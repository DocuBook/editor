//! Axum AI adapter. Shared request assembly, SSE parsing, limits, errors, and
//! event semantics live in `src-tauri/rust-ai`; this file owns web-only auth
//! state, rate limiting, provider credential resolution, and SSE presentation.

use super::*;
use crate::rust_ai::{events::AiEvent, request::AiRequest, sse::stream_chat};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio_stream::wrappers::ReceiverStream;

pub(crate) async fn ask_ai(State(state): State<AppState>, Json(args): Json<Value>) -> Response {
    let ai_slot = match state.ai_slots.clone().try_acquire_owned() {
        Ok(slot) => slot,
        Err(_) => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({ "error": "Too many AI requests — try again shortly" })),
            )
                .into_response();
        }
    };
    tracing::debug!(event = "ai_request_received");
    let string_arg = |key: &str| {
        args.get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let provider = string_arg("provider");
    let requested_model = string_arg("model");
    let base_url = string_arg("baseUrl");
    let messages = string_arg("messages");
    let tools = args.get("tools").and_then(Value::as_str);

    let mut custom_resolution = None;
    let agent_cfg = match (provider.as_str(), requested_model.as_str()) {
        // Custom endpoint is bound server-side. The webview URL is ignored.
        (p, m) if !p.is_empty() && !m.is_empty() && p == agent::CUSTOM_PROVIDER_ID => {
            let (bound_url, key, model) = match probe::custom_env_config() {
                Some((env_url, env_key, env_model)) => {
                    let key = match env_key.or_else(|| keys::get_key(&state.data_dir, p).ok()) {
                        Some(key) => key,
                        None => return err_response("No API key found"),
                    };
                    (env_url, key, env_model.unwrap_or_else(|| m.to_string()))
                }
                None => {
                    let url = match keys::get_base_url(&state.data_dir, p) {
                        Ok(url) => url,
                        Err(_) => {
                            return err_response(
                                "No custom base URL saved — set it in Settings → AI",
                            )
                        }
                    };
                    let key = match keys::get_key(&state.data_dir, p) {
                        Ok(key) => key,
                        Err(_) => return err_response("No API key found"),
                    };
                    (url, key, m.to_string())
                }
            };
            match agent::validated_custom_addrs(&bound_url, false) {
                Ok(resolution) => custom_resolution = Some(resolution),
                Err(error) => return err_response(&error),
            }
            agent::Agent::new(p, &model, &key, &bound_url)
        }
        (p, m) if !p.is_empty() && !m.is_empty() && !base_url.is_empty() => {
            if let Err(error) = agent::validate_provider_base_url(p, &base_url) {
                return err_response(&error);
            }
            let key = match keys::get_key(&state.data_dir, p) {
                Ok(key) => key,
                Err(_) => return err_response("No API key found"),
            };
            agent::Agent::new(p, m, &key, &base_url)
        }
        _ => return err_response("Provider, model, and base URL are required"),
    };

    state.ai_cancel.store(false, Ordering::SeqCst);
    let started = std::time::Instant::now();
    let mut client_builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(120));
    if let Some((host, addrs)) = &custom_resolution {
        client_builder = client_builder.resolve_to_addrs(host, addrs);
    }
    let client = match client_builder.build() {
        Ok(client) => client,
        Err(error) => return err_response(&format!("Client error: {error}")),
    };
    let request = match AiRequest::from_json(
        agent_cfg.model.clone(),
        agent_cfg.api_key.clone(),
        agent_cfg.base_url.clone(),
        &messages,
        tools,
    ) {
        Ok(request) => request,
        Err(error) => return err_response(&error),
    };
    let (event_tx, event_rx) = tokio::sync::mpsc::channel::<Result<AiEvent, String>>(64);
    let cancel = Arc::clone(&state.ai_cancel);
    let provider_name = agent_cfg.provider.clone();
    let model_name = agent_cfg.model.clone();
    tokio::spawn(async move {
        let _ai_slot = ai_slot;
        let url = request.url();
        let body = request.body();
        let api_key = request.api_key;
        let response = match tokio::time::timeout(
            std::time::Duration::from_secs(30),
            client
                .post(url)
                .header("Authorization", format!("Bearer {api_key}"))
                .json(&body)
                .send(),
        )
        .await
        {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                tracing::warn!(
                    event = "ai_request_failure",
                    provider = %provider_name,
                    model = %model_name,
                    duration_ms = started.elapsed().as_millis() as u64,
                    body_bytes = 0_u64,
                    error_category = "send"
                );
                let _ = event_tx
                    .send(Err(crate::rust_ai::error::sanitize_ai_error(
                        &error.to_string(),
                    )))
                    .await;
                return;
            }
            Err(_) => {
                tracing::warn!(
                    event = "ai_request_failure",
                    provider = %provider_name,
                    model = %model_name,
                    duration_ms = started.elapsed().as_millis() as u64,
                    body_bytes = 0_u64,
                    error_category = "send_timeout"
                );
                let _ = event_tx
                    .send(Err("AI provider did not respond — try again".into()))
                    .await;
                return;
            }
        };
        stream_chat(
            response,
            provider_name,
            model_name,
            cancel,
            started,
            event_tx,
        )
        .await;
    });

    let (sse_tx, sse_rx) = tokio::sync::mpsc::channel::<Result<Event, axum::Error>>(64);
    tokio::spawn(async move {
        let mut event_rx = event_rx;
        while let Some(event) = event_rx.recv().await {
            let result = match event {
                Ok(AiEvent::Token(token)) => Event::default()
                    .event(crate::rust_ai::events::TOKEN_EVENT)
                    .data(serde_json::to_string(&token).unwrap_or_else(|_| "\"\"".into())),
                Ok(AiEvent::ToolCall { tool_call_id, tool_name, input }) => Event::default()
                    .event(crate::rust_ai::events::TOOL_CALL_EVENT)
                    .data(json!({ "toolCallId": tool_call_id, "toolName": tool_name, "input": input }).to_string()),
                Ok(AiEvent::ToolsDone) => Event::default()
                    .event(crate::rust_ai::events::TOOLS_DONE_EVENT)
                    .data("\"\""),
                Ok(AiEvent::Done { provider, truncated }) => Event::default()
                    .event(crate::rust_ai::events::DONE_EVENT)
                    .data(json!({ "provider": provider, "truncated": truncated }).to_string()),
                Err(error) => Event::default()
                    .event(crate::rust_ai::events::ERROR_EVENT)
                    .data(error),
            };
            if sse_tx.send(Ok(result)).await.is_err() {
                break;
            }
        }
    });

    Sse::new(ReceiverStream::new(sse_rx))
        .keep_alive(KeepAlive::default())
        .into_response()
}
