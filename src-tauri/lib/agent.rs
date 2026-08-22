//! AI agent commands — API keys, model discovery, connection testing, and the
//! streaming `ask_ai`/`cancel_ai` loop with its SSE parser.
//!
//! Responsibility: all LLM IPC. Security (SSRF guards, key handling) lives in
//! `crate::agent` + `crate::keychain`; this module wires them to Tauri and owns
//! the streaming byte-buffer parse + error sanitization.

use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, State};
use crate::AppState;

fn pin_custom_endpoint(builder: reqwest::ClientBuilder, provider: &str, base_url: &str) -> Result<reqwest::ClientBuilder, String> {
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
    // Keychain scan spawns ~174 `security` processes — run off the main thread
    // so opening Settings never blocks the UI.
    let keys = tauri::async_runtime::spawn_blocking(move || crate::keychain::list_keys(&providers))
        .await
        .map_err(|e| e.to_string())??;
    serde_json::to_string(&keys).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_api_key(provider: &str, key: &str) -> Result<(), String> {
    crate::keychain::set_key(provider, key)
}

/** Runtime model discovery — GET {baseUrl}/models with the stored key, so the
 *  frontend never holds API keys (SEC-5). SSRF-guarded and no redirects (same
 *  policy as ask_ai). */
#[tauri::command]
pub async fn list_models(provider: String, base_url: String) -> Result<String, String> {
    if base_url.is_empty() {
        return Err("Base URL is required".into());
    }
    let key = crate::keychain::get_key(&provider).map_err(|_| "No API key found — save one in Settings -> AI".to_string())?;
    let client = pin_custom_endpoint(reqwest::Client::builder()
        // SSRF: never follow redirects — the validated host is the ONLY target the key may reach.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10)), &provider, &base_url)?
        .build()
        .map_err(|e| format!("Client error: {}", e))?;
    let models = crate::agent::fetch_models(&client, &base_url, &key).await?;
    serde_json::to_string(&models).map_err(|e| e.to_string())
}

/** Save a custom OpenAI-compatible endpoint: base URL + key bound together
 *  server-side. The stored URL is the ONLY destination the key is ever sent to
 *  (ask_ai ignores webview-provided URLs for the custom provider), which closes
 *  the exfiltration vector a webview-controlled URL would open. */
#[tauri::command]
pub fn set_custom_endpoint(provider: &str, base_url: &str, key: &str) -> Result<(), String> {
    crate::agent::validate_custom_base_url(base_url, true)?;
    crate::keychain::set_base_url(provider, base_url)?;
    crate::keychain::set_key(provider, key)
}

/** Custom-provider config for the UI. Desktop is never env-controlled — the
 *  keychain is the source; env overrides are a Docker/web feature. */
#[tauri::command]
pub fn custom_ai_config() -> Result<String, String> {
    let base_url = crate::keychain::get_base_url(crate::agent::CUSTOM_PROVIDER_ID).ok();
    let has_key = crate::keychain::get_key(crate::agent::CUSTOM_PROVIDER_ID).is_ok();
    Ok(serde_json::json!({ "source": "file", "baseUrl": base_url, "hasKey": has_key, "model": null }).to_string())
}

#[tauri::command]
pub fn delete_api_key(provider: &str) -> Result<(), String> {
    let _ = crate::keychain::delete_base_url(provider); // best-effort — custom-endpoint entry may not exist
    crate::keychain::delete_key(provider)
}

// ── Connection test ──

#[tauri::command]
pub async fn test_connection(provider: String, model: String, base_url: String, api_key: String) -> Result<String, String> {
    // API key: prefer the explicit arg (just-entered key), fall back to the
    // stored keychain key so auto-probe works without re-typing the key
    // (mirrors ask_ai, which always resolves from the keychain). Custom
    // endpoints also fall back to the stored base URL.
    let api_key = if api_key.is_empty() {
        crate::keychain::get_key(&provider).map_err(|_| "No API key found in keychain".to_string())?
    } else {
        api_key
    };
    let base_url = if base_url.is_empty() && provider == crate::agent::CUSTOM_PROVIDER_ID {
        crate::keychain::get_base_url(&provider).map_err(|_| "No custom base URL saved — set it in Settings → AI".to_string())?
    } else {
        base_url
    };
    let client = pin_custom_endpoint(reqwest::Client::builder()
        // SSRF: never follow redirects — the validated host is the ONLY target the key may reach.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15)), &provider, &base_url)?
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
        // Some gateways REJECT forced tool_choice:"required" (HTTP 400) yet still
        // support tool calls in "auto" mode (e.g. opencode.ai, DeepSeek thinking).
        // Retry once with "auto" before concluding tools:false.
        tool_body["tool_choice"] = serde_json::json!("auto");
        let r2 = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&tool_body)
            .send().await;
        if let Ok(resp2) = r2 {
            if resp2.status().is_success() {
                let t2 = resp2.text().await.map_err(|e| e.to_string())?;
                if t2.contains("tool_calls") || t2.contains("test_tool") {
                    return Ok(r#"{"status":"ok","tools":true}"#.to_string());
                }
            }
        }
        return Ok(r#"{"status":"ok","tools":false}"#.to_string());
    }
    // Non-streaming parse: response is a single JSON object, not SSE chunks.
    let text = tool_res.text().await.map_err(|e| e.to_string())?;
    let supports_tools = text.contains("tool_calls") || text.contains("test_tool");
    Ok(format!(r#"{{"status":"ok","tools":{}}}"#, supports_tools))
}

// ── Streaming chat ──

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

#[tauri::command]
pub async fn ask_ai(messages: String, app: tauri::AppHandle, provider: Option<String>, model: Option<String>, base_url: Option<String>, _api_key: Option<String>, tools: Option<String>) -> Result<(), String> {
    let mut custom_resolution = None;
    let agent = match (&provider, &model, &base_url) {
        // Custom OpenAI-compatible endpoint: URL is bound server-side at save time,
        // the webview-provided base_url is IGNORED so the stored key can never be
        // redirected to a host the user did not explicitly bind it to.
        (Some(p), Some(m), _) if p == crate::agent::CUSTOM_PROVIDER_ID => {
            let b = crate::keychain::get_base_url(p).map_err(|_| "No custom base URL saved — set it in Settings → AI")?;
            custom_resolution = Some(crate::agent::validated_custom_addrs(&b, true)?);
            // API key is ALWAYS resolved from the keychain — a webview-provided
            // key is ignored so it can never be exfiltrated to a non-trusted host.
            let key = crate::keychain::get_key(p).map_err(|_| "No API key found in keychain")?;
            crate::agent::Agent::new(p, m, &key, &b)
        }
        (Some(p), Some(m), Some(b)) => {
            // SSRF / exfiltration guard: base URL must be an allowlisted provider
            // endpoint or a loopback (local LLM) server.
            crate::agent::validate_base_url(b)?;
            // API key is ALWAYS resolved from the keychain — a webview-provided
            // key is ignored so it can never be exfiltrated to a non-trusted host.
            let key = crate::keychain::get_key(p).map_err(|_| "No API key found in keychain")?;
            crate::agent::Agent::new(p, m, &key, b)
        }
        _ => return Err("Provider, model, and base URL are required".to_string()),
    };
    let state = app.state::<AppState>();
    eprintln!("[docubook] ask_ai: provider={} model={}", agent.provider, agent.model);
    let started = std::time::Instant::now();
    state.ai_cancel.store(false, Ordering::SeqCst);
    let mut client_builder = reqwest::Client::builder()
        // SSRF: never follow redirects — the validated host is the ONLY target the key may reach.
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        // Streaming: no total deadline (long generations) — read_timeout resets per chunk, only stalls abort.
        .read_timeout(std::time::Duration::from_secs(120));
    if let Some((host, addrs)) = &custom_resolution {
        client_builder = client_builder.resolve_to_addrs(host, addrs);
    }
    let client = client_builder.build().map_err(|e| format!("Client error: {}", e))?;
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
        // Provider bodies may contain prompts, tool arguments, or internal details.
        eprintln!("[docubook] ask_ai provider error: HTTP {}", status);
        return Err(format!("AI provider error (HTTP {})", status));
    }
    let mut stream = response;
    // First chunk budget: headers arrived but body never starts → 30s, not 120s.
    let first_chunk = tokio::time::timeout(std::time::Duration::from_secs(30), stream.chunk())
        .await
        .map_err(|_| "AI provider did not respond — try again".to_string())?
        .map_err(|e| sanitize_ai_error(&e.to_string()))?
        .ok_or_else(|| "AI provider returned an empty response".to_string())?;

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
pub fn cancel_ai(state: State<AppState>) {
    state.ai_cancel.store(true, Ordering::SeqCst);
}

// ── SSE parsing (shared by ask_ai and its tests) ──

/// Process one complete SSE `data:` payload and emit its content delta.
fn process_sse_data(data: &str, full: &mut String, tool_calls: &mut Vec<(i64, String, String, String)>, app: &tauri::AppHandle) {
    if let (Some(content), _) = parse_sse_line(data, tool_calls) {
        full.push_str(&content);
        let _ = app.emit("ai:token", content);
    }
}

/// Parse one complete SSE `data:` payload (content delta + tool call accumulation).
/// Returns (content_delta, is_done).
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
