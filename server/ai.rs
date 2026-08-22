// AI pipeline — grounding, probe, ask_ai SSE streaming. Isolated into its own
// module; shared state/imports come from the parent via `use super::*`.
use super::*;

fn sanitize_ai_error(err: &str) -> String {
    let e = err.to_lowercase();
    if e.contains("dns")
        || e.contains("resolve")
        || e.contains("connection")
        || e.contains("refused")
        || e.contains("connect")
    {
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

pub(crate) async fn ask_ai(State(state): State<AppState>, Json(args): Json<Value>) -> Response {
    let ai_slot = match state.ai_slots.clone().try_acquire_owned() {
        Ok(slot) => slot,
        Err(_) => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({ "error": "Too many AI requests — try again shortly" })),
            )
                .into_response()
        }
    };
    tracing::debug!(event = "ai_request_received");
    let s = |k: &str| {
        args.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let provider = s("provider");
    let model = s("model");
    let base_url = s("baseUrl");
    let messages = s("messages");
    let tools = args
        .get("tools")
        .and_then(|v| v.as_str())
        .map(|t| t.to_string());

    let mut custom_resolution = None;
    let agent_cfg = match (provider.as_str(), model.as_str()) {
        // Custom OpenAI-compatible endpoint: URL is bound server-side at save time,
        // the webview-provided baseUrl is IGNORED so the stored key can never be
        // redirected to a host the user did not explicitly bind it to.
        (p, m) if !p.is_empty() && !m.is_empty() && p == agent::CUSTOM_PROVIDER_ID => {
            // Env override (Docker): DB_OPENAI_COMPAT_BASE_URL/API_KEY/MODEL win
            // when set; otherwise the keys.json values are used (backward compat).
            let (b, key, model) = match probe::custom_env_config() {
                Some((eb, ek, em)) => {
                    let k = match ek.or_else(|| keys::get_key(&state.data_dir, p).ok()) {
                        Some(k) => k,
                        None => return err_response("No API key found"),
                    };
                    (eb, k, em.unwrap_or_else(|| m.to_string()))
                }
                None => {
                    let b = match keys::get_base_url(&state.data_dir, p) {
                        Ok(u) => u,
                        Err(_) => {
                            return err_response(
                                "No custom base URL saved — set it in Settings → AI",
                            )
                        }
                    };
                    let k = match keys::get_key(&state.data_dir, p) {
                        Ok(k) => k,
                        Err(_) => return err_response("No API key found"),
                    };
                    (b, k, m.to_string())
                }
            };
            match agent::validated_custom_addrs(&b, false) {
                Ok(resolution) => custom_resolution = Some(resolution),
                Err(e) => return err_response(&e),
            }
            agent::Agent::new(p, &model, &key, &b)
        }
        (p, m) if !p.is_empty() && !m.is_empty() && !base_url.is_empty() => {
            if let Err(e) = agent::validate_provider_base_url(p, &base_url) {
                return err_response(&e);
            }
            let key = match keys::get_key(&state.data_dir, p) {
                Ok(k) => k,
                Err(_) => return err_response("No API key found"),
            };
            agent::Agent::new(p, m, &key, &base_url)
        }
        _ => return err_response("Provider, model, and base URL are required"),
    };

    state.ai_cancel.store(false, Ordering::SeqCst);
    let started = std::time::Instant::now();
    let mut client_builder = reqwest::Client::builder()
        // SSRF: never follow redirects — the validated host is the ONLY target the key may reach.
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(120));
    if let Some((host, addrs)) = &custom_resolution {
        client_builder = client_builder.resolve_to_addrs(host, addrs);
    }
    let client = match client_builder.build() {
        Ok(c) => c,
        Err(e) => return err_response(&format!("Client error: {}", e)),
    };

    let mut body_obj = match serde_json::from_str::<Value>(&messages) {
        Ok(msgs) => json!({ "model": agent_cfg.model, "messages": msgs, "stream": true }),
        Err(_) => return err_response("Invalid messages"),
    };
    if let Some(ref tools_str) = tools {
        if let Ok(tools_val) = serde_json::from_str::<Value>(tools_str) {
            if let Some(arr) = tools_val.as_array() {
                if !arr.is_empty() {
                    body_obj["tools"] = tools_val;
                    // "auto", NOT "required": thinking-mode models reject tool_choice:"required"
                    // with HTTP 400 ("Thinking mode does not support this tool_choice").
                    body_obj["tool_choice"] = json!("auto");
                }
            }
        }
    }

    let url = format!(
        "{}/chat/completions",
        agent_cfg.base_url.trim_end_matches('/')
    );
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, axum::Error>>(64);

    tokio::spawn(async move {
        let _ai_slot = ai_slot;
        let req = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", agent_cfg.api_key));
        let response = match tokio::time::timeout(
            std::time::Duration::from_secs(30),
            req.json(&body_obj).send(),
        )
        .await
        {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                tracing::warn!(event = "ai_request_failure", provider = %agent_cfg.provider, model = %agent_cfg.model, duration_ms = started.elapsed().as_millis() as u64, body_bytes = 0_u64, error_category = "send");
                let _ = tx
                    .send(Ok(Event::default()
                        .event("error")
                        .data(sanitize_ai_error(&e.to_string()))))
                    .await;
                return;
            }
            Err(_) => {
                tracing::warn!(event = "ai_request_failure", provider = %agent_cfg.provider, model = %agent_cfg.model, duration_ms = started.elapsed().as_millis() as u64, body_bytes = 0_u64, error_category = "send_timeout");
                let _ = tx
                    .send(Ok(Event::default()
                        .event("error")
                        .data("AI provider did not respond — try again")))
                    .await;
                return;
            }
        };
        let status = response.status();
        if !status.is_success() {
            let body_bytes = response.bytes().await.map(|body| body.len()).unwrap_or(0);
            tracing::warn!(event = "ai_request_failure", provider = %agent_cfg.provider, model = %agent_cfg.model, status = status.as_u16(), duration_ms = started.elapsed().as_millis() as u64, body_bytes, error_category = "provider_http");
            let _ = tx
                .send(Ok(Event::default()
                    .event("error")
                    .data("AI provider error (HTTP {status})")))
                .await;
            return;
        }
        let mut stream = response;
        // First-chunk budget (P1): a provider that accepts the request but never
        // sends data gets 30s, not the 120s stall timeout. After the first chunk
        // arrives, inter-chunk stalls keep the 120s read_timeout.
        let first = match tokio::time::timeout(std::time::Duration::from_secs(30), stream.chunk())
            .await
        {
            Ok(Ok(Some(c))) => c,
            Ok(Ok(None)) => {
                let _ = tx
                    .send(Ok(Event::default()
                        .event("error")
                        .data("AI provider returned an empty response")))
                    .await;
                return;
            }
            Ok(Err(e)) => {
                let _ = tx
                    .send(Ok(Event::default()
                        .event("error")
                        .data(sanitize_ai_error(&e.to_string()))))
                    .await;
                return;
            }
            Err(_) => {
                tracing::warn!(event = "ai_request_failure", provider = %agent_cfg.provider, model = %agent_cfg.model, status = status.as_u16(), duration_ms = started.elapsed().as_millis() as u64, body_bytes = 0_u64, error_category = "first_chunk_timeout");
                let _ = tx
                    .send(Ok(Event::default()
                        .event("error")
                        .data("AI provider did not respond — try again")))
                    .await;
                return;
            }
        };
        let mut full = String::new();
        let mut tool_calls: Vec<(i64, String, String, String)> = Vec::new();
        let mut byte_buf: Vec<u8> = Vec::new();
        let mut truncated = false;
        let mut first_chunk = Some(first);
        loop {
            let chunk = match first_chunk.take() {
                Some(c) => Ok(Some(c)),
                None => stream.chunk().await,
            };
            match chunk {
                Ok(Some(chunk)) => {
                    if state.ai_cancel.load(Ordering::SeqCst) {
                        break;
                    }
                    // Total generation budget (per attempt): the per-chunk
                    // read_timeout only catches STALLS — a model that trickles
                    // tokens forever never trips it, so bound the whole run.
                    if started.elapsed().as_secs() >= AI_MAX_SECONDS {
                        let _ = tx
                            .send(Ok(Event::default().event("error").data(format!(
                                "AI generation exceeded {}s — try again or use a stronger model",
                                AI_MAX_SECONDS
                            ))))
                            .await;
                        return;
                    }
                    byte_buf.extend_from_slice(&chunk);
                    if byte_buf.len() > MAX_AI_BUFFER {
                        let _ = tx
                            .send(Ok(Event::default()
                                .event("error")
                                .data("AI response too large")))
                            .await;
                        return;
                    }
                    let mut start = 0;
                    while let Some(pos) = byte_buf[start..].iter().position(|&b| b == b'\n') {
                        let line_end = start + pos;
                        let line = String::from_utf8_lossy(&byte_buf[start..line_end]);
                        let data = line
                            .trim_end_matches('\r')
                            .strip_prefix("data: ")
                            .unwrap_or("");
                        if !data.is_empty() {
                            let out = process_sse_data(data, &mut full, &mut tool_calls, &tx).await;
                            if let Err(e) = out {
                                let _ = tx.send(Ok(Event::default().event("error").data(e))).await;
                                return;
                            }
                            if full.len() >= MAX_AI_BUFFER {
                                truncated = true;
                                break;
                            }
                        }
                        start = line_end + 1;
                    }
                    byte_buf.drain(..start);
                    if truncated {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    tracing::warn!(event = "ai_request_failure", provider = %agent_cfg.provider, model = %agent_cfg.model, status = status.as_u16(), duration_ms = started.elapsed().as_millis() as u64, body_bytes = full.len(), error_category = "stream_read");
                    let _ = tx
                        .send(Ok(Event::default()
                            .event("error")
                            .data(sanitize_ai_error(&e.to_string()))))
                        .await;
                    return;
                }
            }
        }
        if !byte_buf.is_empty() {
            let line = String::from_utf8_lossy(&byte_buf);
            let data = line
                .trim_end_matches('\r')
                .strip_prefix("data: ")
                .unwrap_or("");
            if !data.is_empty() {
                if let Err(e) = process_sse_data(data, &mut full, &mut tool_calls, &tx).await {
                    let _ = tx.send(Ok(Event::default().event("error").data(e))).await;
                    return;
                }
            }
        }
        for (index, (_, provider_id, name, args_json)) in tool_calls.iter().enumerate() {
            if !provider_id.is_empty() && !name.is_empty() {
                let input: Value = serde_json::from_str(args_json).unwrap_or(Value::Null);
                let _ = tx
                    .send(Ok(Event::default().event("ai:tool_call").data(
                        json!({
                            "toolCallId": agent::local_tool_call_id(index), "toolName": name, "input": input,
                        })
                        .to_string(),
                    )))
                    .await;
            }
        }
        let _ = tx
            .send(Ok(Event::default().event("ai:tools_done").data("\"\"")))
            .await;
        if full.is_empty() && tool_calls.is_empty() {
            let _ = tx
                .send(Ok(Event::default()
                    .event("error")
                    .data("AI returned empty response")))
                .await;
            return;
        }
        tracing::info!(event = "ai_request_complete", provider = %agent_cfg.provider, model = %agent_cfg.model, status = status.as_u16(), duration_ms = started.elapsed().as_millis() as u64, body_bytes = full.len(), error_category = "none");
        let _ = tx
            .send(Ok(Event::default().event("ai:done").data(
                json!({ "provider": agent_cfg.provider, "truncated": truncated }).to_string(),
            )))
            .await;
    });

    Sse::new(ReceiverStream::new(rx))
        .keep_alive(KeepAlive::default())
        .into_response()
}

type SseTx = tokio::sync::mpsc::Sender<Result<Event, axum::Error>>;

/** One complete SSE `data:` payload from the provider → forward as events. */
pub(crate) async fn process_sse_data(
    data: &str,
    full: &mut String,
    tool_calls: &mut Vec<(i64, String, String, String)>,
    tx: &SseTx,
) -> Result<(), String> {
    if data == "[DONE]" {
        return Ok(());
    }
    let Ok(val) = serde_json::from_str::<Value>(data) else {
        return Ok(());
    };
    let content = val["choices"][0]["delta"]["content"].as_str();
    if full
        .len()
        .checked_add(content.map_or(0, str::len))
        .filter(|size| *size <= MAX_AI_BUFFER)
        .is_none()
    {
        return Err("AI response too large".into());
    }
    let mut next_tool_calls = tool_calls.clone();
    if let Some(tcs) = val["choices"][0]["delta"]["tool_calls"].as_array() {
        for tc in tcs {
            let idx = tc["index"].as_i64().unwrap_or(0);
            let id = tc["id"].as_str().unwrap_or("").to_string();
            let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
            let args = tc["function"]["arguments"]
                .as_str()
                .unwrap_or("")
                .to_string();
            if let Some(pos) = next_tool_calls.iter().position(|(i, _, _, _)| *i == idx) {
                if !id.is_empty() {
                    next_tool_calls[pos].1 = id;
                }
                if !name.is_empty() {
                    next_tool_calls[pos].2 = name;
                }
                next_tool_calls[pos].3.push_str(&args);
            } else {
                next_tool_calls.push((idx, id, name, args));
            }
        }
    }
    let tool_args_size = next_tool_calls
        .iter()
        .try_fold(0usize, |total, (_, _, _, args)| {
            total.checked_add(args.len())
        })
        .ok_or_else(|| "AI response too large".to_string())?;
    if next_tool_calls.len() > MAX_TOOL_CALLS_PER_REQUEST || tool_args_size > MAX_TOOL_ARGS_SIZE {
        return Err("AI response too large".into());
    }
    *tool_calls = next_tool_calls;
    if let Some(content) = content {
        full.push_str(content);
        let _ = tx
            .send(Ok(Event::default().event("ai:token").data(
                serde_json::to_string(content).map_err(|e| e.to_string())?,
            )))
            .await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool_delta(index: i64, args: &str) -> String {
        json!({ "choices": [{ "delta": { "tool_calls": [{ "index": index, "id": format!("call-{index}"), "function": { "name": "test", "arguments": args } }] } }] }).to_string()
    }

    #[tokio::test]
    async fn process_sse_data_enforces_text_limit_before_append() {
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let mut full = "x".repeat(MAX_AI_BUFFER);
        let mut tools = Vec::new();
        let data = json!({ "choices": [{ "delta": { "content": "y" } }] }).to_string();
        assert_eq!(
            process_sse_data(&data, &mut full, &mut tools, &tx)
                .await
                .unwrap_err(),
            "AI response too large"
        );
        assert_eq!(full.len(), MAX_AI_BUFFER);
    }

    #[tokio::test]
    async fn process_sse_data_enforces_tool_limits_transactionally() {
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let mut full = String::new();
        let mut tools = Vec::new();
        for index in 0..MAX_TOOL_CALLS_PER_REQUEST {
            process_sse_data(&tool_delta(index as i64, "{}"), &mut full, &mut tools, &tx)
                .await
                .unwrap();
        }
        let before = tools.clone();
        assert_eq!(
            process_sse_data(
                &tool_delta(MAX_TOOL_CALLS_PER_REQUEST as i64, "{}"),
                &mut full,
                &mut tools,
                &tx
            )
            .await
            .unwrap_err(),
            "AI response too large"
        );
        assert_eq!(tools, before);

        tools = vec![(
            0,
            "call-0".into(),
            "test".into(),
            "x".repeat(MAX_TOOL_ARGS_SIZE),
        )];
        let before = tools.clone();
        assert_eq!(
            process_sse_data(&tool_delta(0, "y"), &mut full, &mut tools, &tx)
                .await
                .unwrap_err(),
            "AI response too large"
        );
        assert_eq!(tools, before);
    }
}
