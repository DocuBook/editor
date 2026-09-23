//! Axum AI adapter. Shared request assembly, SSE parsing, limits, errors, and
//! event semantics live in `src-tauri/rust-ai`; this file owns web-only auth
//! state, rate limiting, provider credential resolution, and SSE presentation.

use super::*;
use crate::rust_ai::{events::AiEvent, request::AiRequest, sse::stream_chat};
use tokio_stream::wrappers::ReceiverStream;

/** Base URL chat should use for this request, in precedence order: the custom
 *  endpoint env override (unchanged), the endpoint saved in config.json (the
 *  single source of truth — the browser must not be able to rebind a stored key),
 *  the browser-supplied URL, then the catalog default. */
fn resolve_base_url(state: &AppState, provider: &str, browser_base_url: &str) -> String {
    // Once an endpoint exists, config.json is authoritative. The browser value is
    // only a compatibility fallback for a provider that has not been configured.
    let configured = state
        .auth
        .config
        .lock()
        .expect("lock")
        .ai
        .endpoints
        .get(provider)
        .map(|e| e.base_url.clone())
        .filter(|u| !u.is_empty());
    configured
        .or_else(|| (!browser_base_url.is_empty()).then(|| browser_base_url.to_string()))
        .unwrap_or_else(|| agent::catalog_base_url(provider).unwrap_or("").to_string())
}

fn resolve_model(state: &AppState, provider: &str, browser_model: &str) -> String {
    // A configured endpoint owns its model just like its base URL. Keep the
    // browser value only for first-time setup before an endpoint exists.
    state
        .auth
        .config
        .lock()
        .expect("lock")
        .ai
        .endpoints
        .get(provider)
        .map(|e| e.model.clone())
        .filter(|m| !m.is_empty())
        .or_else(|| (!browser_model.is_empty()).then(|| browser_model.to_string()))
        .unwrap_or_default()
}

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
    let request_id = string_arg("requestId");
    let tools = args.get("tools").and_then(Value::as_str);

    let mut custom_resolution = None;
    let agent_cfg = match provider.as_str() {
        // Custom endpoint is bound server-side. The webview URL is ignored.
        p if !p.is_empty() && p == agent::CUSTOM_PROVIDER_ID => {
            let requested_model = resolve_model(&state, p, &requested_model);
            let (bound_url, key, model) = match probe::custom_env_config() {
                Some((env_url, env_key, env_model)) => {
                    let key = match env_key.or_else(|| keys::get_key(&state.data_dir, p).ok()) {
                        Some(key) => key,
                        None => return err_response("No API key found"),
                    };
                    (
                        env_url,
                        key,
                        env_model.unwrap_or_else(|| requested_model.clone()),
                    )
                }
                None => {
                    // The bound URL comes from config.json (env override handled
                    // above); the browser-supplied URL is ignored for this provider.
                    let url = state
                        .auth
                        .config
                        .lock()
                        .expect("lock")
                        .ai
                        .endpoints
                        .get(p)
                        .map(|e| e.base_url.clone())
                        .filter(|u| !u.is_empty());
                    let url = match url {
                        Some(url) => url,
                        None => {
                            return err_response(
                                "No custom base URL saved — set it in Settings → AI",
                            )
                        }
                    };
                    let key = match keys::get_key(&state.data_dir, p) {
                        Ok(key) => key,
                        Err(_) => return err_response("No API key found"),
                    };
                    (url, key, requested_model)
                }
            };
            match agent::validated_custom_addrs(&bound_url, false) {
                Ok(resolution) => custom_resolution = Some(resolution),
                Err(error) => return err_response(&error),
            }
            agent::Agent::new(p, &model, &key, &bound_url)
        }
        p if !p.is_empty() => {
            let model = resolve_model(&state, p, &requested_model);
            if model.is_empty() {
                return err_response("Provider model is required");
            }
            let base_url = resolve_base_url(&state, p, &base_url);
            if base_url.is_empty() {
                return err_response("Provider, model, and base URL are required");
            }
            if let Err(error) = agent::validate_provider_base_url(p, &base_url) {
                return err_response(&error);
            }
            let key = match keys::get_key(&state.data_dir, p) {
                Ok(key) => key,
                Err(_) => return err_response("No API key found"),
            };
            agent::Agent::new(p, &model, &key, &base_url)
        }
        _ => return err_response("Provider, model, and base URL are required"),
    };

    // Own this turn's cancellation slot for as long as the provider stream runs.
    // `ask_ai` returns as soon as the SSE response is handed to axum, so the
    // guard has to live in the producing task — otherwise `cancel_ai` (a
    // separate HTTP request) would find no slot to cancel.
    let request_guard = state.ai_requests.begin(&request_id);
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
    let cancel = request_guard.flag();
    let provider_name = agent_cfg.provider.clone();
    let model_name = agent_cfg.model.clone();
    tokio::spawn(async move {
        let _request_guard = request_guard;
        let _ai_slot = ai_slot;
        let url = request.url();
        let body = request.body();
        let api_key = request.api_key;
        // OpenCode Go 400s without a session id; every other provider ignores it.
        let mut chat = client
            .post(url)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("User-Agent", agent::AI_USER_AGENT);
        if provider_name == agent::SESSION_PROVIDER_ID {
            chat = chat.header("x-opencode-session", agent::session_id());
        }
        let response = match tokio::time::timeout(
            std::time::Duration::from_secs(30),
            chat.json(&body).send(),
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
                Ok(event) => {
                    let (name, payload) = event.to_wire(&request_id);
                    Event::default().event(name).data(payload.to_string())
                }
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
