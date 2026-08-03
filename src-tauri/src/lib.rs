
mod vault;
mod wiki;
mod git;
mod search;
mod agent;
mod keychain;

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{State, Manager};

struct AppState {
    vault: Mutex<Option<vault::Vault>>,
    wiki: Mutex<Option<wiki::WikiIndex>>,
    git: Mutex<Option<git::Git>>,
    ai_cancel: AtomicBool,
}

#[tauri::command]
fn open_vault(path: &str, state: State<AppState>) -> Result<String, String> {
    let v = vault::Vault::new(path)?;
    let name = v.name();
    let mut w = wiki::WikiIndex::new(v.root()); w.scan();
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
fn vault_info(state: State<AppState>) -> Result<String, String> {
    match state.vault.lock().expect("lock").as_ref() {
        Some(v) => Ok(format!(r#"{{"name":"{}"}}"#, v.name())),
        None => Ok(r#"{"name":""}"#.to_string()),
    }
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
fn wiki_backlinks(path: &str, state: State<AppState>) -> Result<String, String> {
    match state.wiki.lock().expect("lock").as_ref() {
        Some(w) => serde_json::to_string(&w.backlinks(path)).map_err(|e| e.to_string()),
        None => Ok("[]".to_string()),
    }
}

#[tauri::command]
fn wiki_suggest(query: &str, state: State<AppState>) -> Result<String, String> {
    match state.wiki.lock().expect("lock").as_ref() {
        Some(w) => serde_json::to_string(&w.suggest(query)).map_err(|e| e.to_string()),
        None => Ok("[]".to_string()),
    }
}

// ── Search ──
#[tauri::command]
fn search_vault(query: &str, state: State<AppState>) -> Result<String, String> {
    let guard = state.vault.lock().expect("lock");
    match guard.as_ref() {
        Some(v) => serde_json::to_string(&search::search_vault(v.root(), query)).map_err(|e| e.to_string()),
        None => Ok("[]".to_string()),
    }
}

// ── Git ──
#[tauri::command]
fn git_stage(state: State<AppState>) -> Result<(), String> {
    let guard = state.git.lock().expect("lock");
    match guard.as_ref() {
        Some(g) => g.add_all().map_err(|e| e.to_string()),
        None => Err("No vault".to_string()),
    }
}

#[tauri::command]
fn git_push(message: String, state: State<AppState>) -> Result<String, String> {
    let guard = state.git.lock().expect("lock");
    match guard.as_ref() {
        Some(g) => serde_json::to_string(&g.push_full(&message)).map_err(|e| e.to_string()),
        None => Ok(r#"{"error":"No vault"}"#.to_string()),
    }
}

#[tauri::command]
fn git_status(state: State<AppState>) -> Result<String, String> {
    let guard = state.git.lock().expect("lock");
    match guard.as_ref() {
        Some(g) if g.is_repo() => {
            let branch = std::process::Command::new("git").args(["rev-parse", "--abbrev-ref", "HEAD"]).current_dir(&g.repo_path).output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
            let status = g.status().unwrap_or_default();
            Ok(serde_json::json!({ "branch": branch, "status": status.trim() }).to_string())
        }
        _ => Ok(r#"{"branch":"","status":""}"#.to_string()),
    }
}

// ── Preview ──
#[tauri::command]
fn markdown_preview(content: &str) -> String {
    let parser = pulldown_cmark::Parser::new(content);
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, parser);
    format!(r#"<div class="prose prose-invert max-w-none px-4 py-4 text-sm">{}</div>"#, html)
}

/// Convert markdown to clean HTML (no wrapper) for TipTap display.
#[tauri::command]
fn md_to_html(content: &str) -> String {
    let parser = pulldown_cmark::Parser::new(content);
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, parser);
    html
}

// ── Agent ──
#[tauri::command]
fn get_api_key(provider: &str) -> Result<String, String> {
    keychain::get_key(provider)
}

#[tauri::command]
fn set_api_key(provider: &str, key: &str) -> Result<(), String> {
    keychain::set_key(provider, key)
}

#[tauri::command]
fn delete_api_key(provider: &str) -> Result<(), String> {
    keychain::delete_key(provider)
}


#[tauri::command]
async fn test_connection(_provider: String, model: String, base_url: String, api_key: String) -> Result<String, String> {
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

    // Test 2: tool call support — send a dummy tool definition
    let tool_body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "call the test_tool"}],
        "tools": [{
            "type": "function",
            "function": {
                "name": "test_tool",
                "description": "A test tool",
                "parameters": {
                    "type": "object",
                    "properties": { "ok": { "type": "boolean" } }
                }
            }
        }],
        "tool_choice": "required",
        "max_tokens": 50,
    });
    let tool_res = client.post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&tool_body)
        .send()
        .await
        .map_err(|e| format!("Tool test failed: {}", e))?;
    if !tool_res.status().is_success() {
        // Tool call not supported — ignore error, just report no tools
        return Ok("connection ok".to_string());
    }
    let text = tool_res.text().await.map_err(|e| e.to_string())?;
    let supports_tools = text.contains("tool_calls") || text.contains("test_tool");
    Ok(format!(r#"{{"status":"ok","tools":{}}}"#, supports_tools))
}

#[tauri::command]
async fn ask_ai(messages: String, app: tauri::AppHandle, provider: Option<String>, model: Option<String>, base_url: Option<String>, api_key: Option<String>, tools: Option<String>) -> Result<(), String> {
    let agent = match (&provider, &model, &base_url) {
        (Some(p), Some(m), Some(b)) => {
            let key = api_key.clone().or_else(|| keychain::get_key(p).ok()).ok_or("No API key found")?;
            agent::Agent::new(p, m, &key, b)
        }
        _ => return Err("Provider, model, and base URL are required".to_string()),
    };
    let state = app.state::<AppState>();
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
                    // Force model to call applyDocumentOperations so xl-ai creates suggestions
                    body_obj["tool_choice"] = serde_json::json!("required");
                }
            }
        }
    }
    let body = body_obj;
    let url = format!("{}/chat/completions", agent.base_url.trim_end_matches('/'));
    // Mirror PI: opencode gateways route better when the client + session are identified.
    let mut req = client.post(&url).header("Authorization", format!("Bearer {}", agent.api_key));
    if agent.provider == "opencode-go" || agent.provider == "opencode" {
        req = req
            .header("x-opencode-client", "pi")
            .header("x-opencode-session", format!("docubook-{}", std::process::id()));
    }
    let response = req.json(&body).send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    if !status.is_success() {
        let err_text = response.text().await.map_err(|e| e.to_string())?;
        return Err(format!("API error ({}): {}", status, err_text));
    }
    let mut stream = response;
    
    use tauri::Emitter;
    let mut full = String::new();
    let mut tool_calls: Vec<(i64, String, String, String)> = Vec::new();

    // Byte-buffered SSE parse (mirrors PI's streaming UTF-8 decoder):
    // buffer RAW bytes across chunks, split on \n (0x0A), decode each COMPLETE line.
    // Per-chunk String::from_utf8_lossy corrupts multi-byte UTF-8 chars split across chunks,
    // and partial SSE lines (JSON split mid-event) are dropped.
    let mut byte_buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.chunk().await.map_err(|e| e.to_string())? {
        if state.ai_cancel.load(Ordering::SeqCst) { break }
        byte_buf.extend_from_slice(&chunk);
        let mut start = 0;
        while let Some(pos) = byte_buf[start..].iter().position(|&b| b == b'\n') {
            let line_end = start + pos;
            let line = String::from_utf8_lossy(&byte_buf[start..line_end]);
            let data = line.trim_end_matches('\r').strip_prefix("data: ").unwrap_or("");
            if !data.is_empty() {
                process_sse_data(data, &mut full, &mut tool_calls, &app);
            }
            start = line_end + 1;
        }
        // Drop processed bytes; keep the partial tail for the next chunk.
        byte_buf.drain(..start);
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
    let _ = app.emit("ai:done", serde_json::json!({ "provider": agent.provider }));
    Ok(())
}

/// Cancel the in-flight AI request (frontend abort). Stream loop checks the flag between chunks.
#[tauri::command]
fn cancel_ai(state: State<AppState>) {
    state.ai_cancel.store(true, Ordering::SeqCst);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { vault: Mutex::new(None), wiki: Mutex::new(None), git: Mutex::new(None), ai_cancel: AtomicBool::new(false) })
        .invoke_handler(tauri::generate_handler![
            open_vault, close_vault, create_vault, vault_info, list_tree, read_file, write_file, create_file, delete_file, rename_file, create_directory,
            wiki_backlinks, wiki_suggest, search_vault, git_stage, git_push, git_status,
            markdown_preview, md_to_html, ask_ai, cancel_ai, get_api_key, set_api_key, delete_api_key, test_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
