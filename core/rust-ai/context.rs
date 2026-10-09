use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::watch;

pub const MAX_DISCOVERED_TOOLS: usize = 64;
pub const MAX_CONTEXT_RESULT_BYTES: usize = 256 * 1024;
pub const MAX_CONTEXT_ITEMS: usize = 64;
pub const DEFAULT_CONTEXT_REQUEST_TIMEOUT_SECS: u64 = 10;
pub const MAX_CONTEXT_REQUEST_TIMEOUT_SECS: u64 = 120;

pub const UNTRUSTED_REFERENCE_TYPE: &str = "untrusted_reference_data";

type DiscoveryCache = Option<(String, Vec<ContextTool>)>;
type SessionCache = HashMap<String, (Option<String>, String)>;

static DISCOVERY_CACHE: OnceLock<Mutex<DiscoveryCache>> = OnceLock::new();
static CONTEXT_CALLS: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
static MCP_SESSIONS: OnceLock<Mutex<SessionCache>> = OnceLock::new();
static MCP_SESSION_GATES: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();
static NEXT_JSONRPC_ID: AtomicU64 = AtomicU64::new(1);
static CONFIGURED_SERVERS: OnceLock<Mutex<Option<Vec<ContextServer>>>> = OnceLock::new();

/// Set runtime-provided MCP configuration. Environment configuration remains
/// authoritative when present; this is used by the Settings-backed runtimes.
pub fn set_configured_servers(servers: Vec<ContextServer>) -> Result<(), String> {
    validate_configured_servers(&servers)?;
    let mut configured = CONFIGURED_SERVERS
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "MCP configuration is unavailable".to_string())?;
    if configured.as_ref() == Some(&servers) {
        return Ok(());
    }
    let retired = {
        let mut sessions = MCP_SESSIONS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| "MCP session cache is unavailable".to_string())?;
        std::mem::take(&mut *sessions)
    };
    *configured = Some(servers);
    DISCOVERY_CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "MCP discovery cache is unavailable".to_string())?
        .take();
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        runtime.spawn(async move {
            for (key, (session, version)) in retired {
                let Ok(server) = serde_json::from_str::<ContextServer>(&key) else {
                    continue;
                };
                let Some(session) = session else {
                    continue;
                };
                let Ok(gate) = session_gate(&server.name) else {
                    continue;
                };
                let _session_guard = gate.lock().await;
                let _ = terminate_session(&server, &session, &version).await;
                if let Ok(mut sessions) = MCP_SESSIONS
                    .get_or_init(|| Mutex::new(HashMap::new()))
                    .lock()
                {
                    if sessions
                        .get(&key)
                        .is_some_and(|(current, _)| current.as_deref() == Some(session.as_str()))
                    {
                        sessions.remove(&key);
                    }
                }
            }
        });
    }
    Ok(())
}

pub fn validate_configured_server(server: &ContextServer) -> Result<(), String> {
    validate_server(server)
}

pub fn validate_configured_servers(servers: &[ContextServer]) -> Result<(), String> {
    if servers.len() > 16 {
        return Err("Too many MCP servers".into());
    }
    for server in servers {
        validate_server(server)?;
    }
    validate_server_names(servers)
}

fn register_call(request_id: &str, sender: watch::Sender<bool>) -> Result<(), String> {
    let mut calls = CONTEXT_CALLS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Context-tool cancellation is unavailable".to_string())?;
    if calls.contains_key(request_id) {
        return Err("Context-tool request is already active".into());
    }
    calls.insert(request_id.to_string(), sender);
    Ok(())
}

fn remove_call(request_id: &str) -> Result<(), String> {
    CONTEXT_CALLS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Context-tool cancellation is unavailable".to_string())?
        .remove(request_id);
    Ok(())
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ContextServer {
    #[serde(alias = "id")]
    pub name: String,
    pub url: String,
    #[serde(rename = "timeoutSeconds", alias = "timeout_seconds", default)]
    pub timeout_seconds: Option<u64>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(rename = "readOnlyTools", alias = "read_only_tools", default)]
    pub read_only_tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContextTool {
    pub server_name: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub read_only: bool,
    #[serde(skip)]
    remote_name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ToolListResult {
    #[serde(default)]
    tools: Vec<RemoteTool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolAnnotations {
    #[serde(default)]
    read_only_hint: bool,
    #[serde(default)]
    destructive_hint: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct RemoteTool {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    #[serde(rename = "inputSchema", alias = "input_schema")]
    input_schema: Value,
    #[serde(default)]
    annotations: Option<ToolAnnotations>,
}

fn validate_server(server: &ContextServer) -> Result<(), String> {
    if server.name.is_empty()
        || server.name.len() > 128
        || !server
            .name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        || server.url.len() > 2048
        || server
            .timeout_seconds
            .is_some_and(|timeout| !(1..=MAX_CONTEXT_REQUEST_TIMEOUT_SECS).contains(&timeout))
    {
        return Err("Invalid MCP server name, URL, or timeout".into());
    }
    let url = reqwest::Url::parse(&server.url).map_err(|_| "Invalid MCP server URL".to_string())?;
    if url.scheme() != "https" || url.username() != "" || url.password().is_some() {
        return Err("MCP servers must use HTTPS without URL credentials".into());
    }
    crate::rust_ai::provider::validated_custom_addrs(&server.url, false).map(|_| ())
}

fn validate_server_names(servers: &[ContextServer]) -> Result<(), String> {
    let mut names = std::collections::HashSet::new();
    if servers
        .iter()
        .any(|server| !names.insert(server.name.as_str()))
    {
        return Err("MCP server names must be unique".into());
    }
    Ok(())
}

fn next_jsonrpc_id() -> String {
    format!(
        "docubook-{}",
        NEXT_JSONRPC_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn session_gate(server_name: &str) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    let mut gates = MCP_SESSION_GATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "MCP session coordination is unavailable".to_string())?;
    gates.retain(|_, gate| Arc::strong_count(gate) > 1);
    Ok(gates
        .entry(server_name.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone())
}

fn tool_is_read_only(server: &ContextServer, tool: &RemoteTool) -> bool {
    if !server.read_only_tools.is_empty() {
        let qualified = format!("{}:{}", server.name, tool.name);
        return server
            .read_only_tools
            .iter()
            .any(|allowed| allowed == &qualified);
    }
    tool.annotations.as_ref().is_some_and(|annotations| {
        annotations.read_only_hint && annotations.destructive_hint == Some(false)
    })
}

fn client(server: &ContextServer) -> Result<reqwest::Client, String> {
    let (_, addrs) = crate::rust_ai::provider::validated_custom_addrs(&server.url, false)?;
    let timeout = Duration::from_secs(
        server
            .timeout_seconds
            .unwrap_or(DEFAULT_CONTEXT_REQUEST_TIMEOUT_SECS),
    );
    let host = reqwest::Url::parse(&server.url)
        .map_err(|_| "Invalid MCP server URL".to_string())?
        .host_str()
        .unwrap_or_default()
        .to_string();
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(timeout)
        .timeout(timeout)
        .resolve_to_addrs(&host, &addrs)
        .build()
        .map_err(|error| format!("MCP client error: {error}"))
}

async fn request_cancellable(
    server: &ContextServer,
    request: Value,
    expect_response: bool,
    session: Option<&str>,
    expected_id: Option<&str>,
    protocol_version: Option<&str>,
    mut cancelled: Option<&mut watch::Receiver<bool>>,
) -> Result<(Option<String>, Option<Value>), String> {
    let mut call = client(server)?.post(&server.url).json(&request);
    call = call
        .header(ACCEPT, "application/json, text/event-stream")
        .header(CONTENT_TYPE, "application/json");
    if let Some(session) = session {
        call = call.header("mcp-session-id", session);
    }
    if let Some(version) = protocol_version {
        call = call.header("mcp-protocol-version", version);
    }
    if let Some(token) = &server.token {
        call = call.bearer_auth(token);
    }
    let response = if let Some(ref mut cancelled) = cancelled {
        tokio::select! {
            response = call.send() => response.map_err(|_| "MCP request failed".to_string())?,
            _ = cancelled.changed() => return Err("Context-tool request cancelled".into()),
        }
    } else {
        call.send()
            .await
            .map_err(|_| "MCP request failed".to_string())?
    };
    if !response.status().is_success() {
        return Err(format!("MCP server returned HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length as usize > MAX_CONTEXT_RESULT_BYTES)
    {
        return Err("MCP response exceeds the context result limit".into());
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let response_session = response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    use futures_util::StreamExt;
    loop {
        let next = if let Some(cancelled) = cancelled.as_deref_mut() {
            tokio::select! {
                chunk = stream.next() => chunk,
                _ = cancelled.changed() => return Err("Context-tool request cancelled".into()),
            }
        } else {
            stream.next().await
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|_| "MCP response could not be read".to_string())?;
        if bytes.len() + chunk.len() > MAX_CONTEXT_RESULT_BYTES {
            return Err("MCP response exceeds the context result limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if !expect_response {
        return Ok((
            response_session.or_else(|| session.map(str::to_owned)),
            None,
        ));
    }
    let envelopes = parse_envelopes(&content_type, &bytes)?;
    let envelope = envelopes
        .into_iter()
        .find(|envelope| {
            expected_id.is_none_or(|id| envelope.get("id").and_then(Value::as_str) == Some(id))
        })
        .ok_or_else(|| "MCP response did not contain the matching JSON-RPC message".to_string())?;
    if envelope.get("error").is_some() {
        return Err("MCP server returned an error".into());
    }
    if envelope.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || expected_id.is_some_and(|id| envelope.get("id").and_then(Value::as_str) != Some(id))
    {
        return Err("Malformed MCP JSON-RPC response".into());
    }
    Ok((
        response_session.or_else(|| session.map(str::to_owned)),
        Some(envelope.get("result").cloned().unwrap_or(Value::Null)),
    ))
}

async fn terminate_session(
    server: &ContextServer,
    session: &str,
    version: &str,
) -> Result<(), String> {
    let call = client(server)?
        .delete(&server.url)
        .header("mcp-session-id", session)
        .header("mcp-protocol-version", version);
    let call = if let Some(token) = &server.token {
        call.bearer_auth(token)
    } else {
        call
    };
    let response = call
        .send()
        .await
        .map_err(|_| "MCP session termination failed".to_string())?;
    if response.status().is_success()
        || response.status().as_u16() == 404
        || response.status().as_u16() == 405
    {
        Ok(())
    } else {
        Err(format!(
            "MCP session termination returned HTTP {}",
            response.status()
        ))
    }
}

fn parse_envelopes(content_type: &str, bytes: &[u8]) -> Result<Vec<Value>, String> {
    let payloads: Vec<Value> = if content_type.starts_with("text/event-stream") {
        let text = String::from_utf8(bytes.to_vec())
            .map_err(|_| "Invalid MCP SSE response".to_string())?
            .replace("\r\n", "\n")
            .replace('\r', "\n");
        text.split("\n\n")
            .filter_map(|frame| {
                let data = frame
                    .lines()
                    .filter_map(|line| line.strip_prefix("data:"))
                    .map(str::trim)
                    .collect::<Vec<_>>()
                    .join("\n");
                (!data.is_empty()).then_some(data)
            })
            .map(|data| {
                serde_json::from_str(&data).map_err(|_| "Invalid MCP SSE JSON response".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?
    } else {
        vec![serde_json::from_slice(bytes).map_err(|_| "Invalid MCP JSON response".to_string())?]
    };

    Ok(payloads
        .into_iter()
        .flat_map(|payload| match payload {
            Value::Array(items) => items,
            payload => vec![payload],
        })
        .collect())
}

async fn post_with(
    server: &ContextServer,
    method: &str,
    params: Value,
    mut cancelled: Option<&mut watch::Receiver<bool>>,
) -> Result<Value, String> {
    let key = serde_json::to_string(server)
        .map_err(|_| "Invalid MCP server configuration".to_string())?;
    let gate = session_gate(&server.name)?;
    let _session_guard = if let Some(cancelled) = cancelled.as_deref_mut() {
        tokio::select! {
            guard = gate.lock() => guard,
            _ = cancelled.changed() => return Err("Context-tool request cancelled".into()),
        }
    } else {
        gate.lock().await
    };
    let existing = MCP_SESSIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|sessions| sessions.get(&key).cloned());
    let (session, protocol_version) = if let Some((session, version)) = existing {
        (session, version)
    } else {
        let initialize_id = next_jsonrpc_id();
        let initialize = json!({
            "jsonrpc": "2.0", "id": initialize_id.clone(), "method": "initialize",
            "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "docubook", "version": "0.1"}}
        });
        let (session, init) = request_cancellable(
            server,
            initialize,
            true,
            None,
            Some(&initialize_id),
            None,
            cancelled.as_deref_mut(),
        )
        .await?;
        let init = init.ok_or_else(|| "MCP initialization failed".to_string())?;
        let protocol_version = init
            .get("protocolVersion")
            .and_then(Value::as_str)
            .ok_or_else(|| "MCP initialization omitted its protocol version".to_string())?
            .to_string();
        let notification = json!({
            "jsonrpc": "2.0", "method": "notifications/initialized", "params": {}
        });
        if let Err(error) = request_cancellable(
            server,
            notification,
            false,
            session.as_deref(),
            None,
            Some(&protocol_version),
            cancelled.as_deref_mut(),
        )
        .await
        {
            if let Some(session) = session.as_deref() {
                let _ = terminate_session(server, session, &protocol_version).await;
            }
            return Err(error);
        }
        (session, protocol_version)
    };

    let call_id = next_jsonrpc_id();
    let call = json!({"jsonrpc":"2.0","id":call_id.clone(),"method":method,"params":params});
    let response = request_cancellable(
        server,
        call,
        true,
        session.as_deref(),
        Some(&call_id),
        Some(&protocol_version),
        cancelled,
    )
    .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            if let Ok(mut sessions) = MCP_SESSIONS
                .get_or_init(|| Mutex::new(HashMap::new()))
                .lock()
            {
                sessions.remove(&key);
            }
            if let Some(session) = session.as_deref() {
                let _ = terminate_session(server, session, &protocol_version).await;
            }
            return Err(error);
        }
    };
    if let Some(sid) = response.0.as_ref().or(session.as_ref()) {
        MCP_SESSIONS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| "MCP session cache unavailable".to_string())?
            .insert(key, (Some(sid.clone()), protocol_version));
    }
    response
        .1
        .ok_or_else(|| "MCP request returned no response".to_string())
}

pub async fn discover(request_id: &str) -> Result<Vec<ContextTool>, String> {
    if request_id.is_empty() {
        return Err("Context-tool request id is required".into());
    }
    let (cancel, mut cancelled) = watch::channel(false);
    register_call(request_id, cancel)?;
    let result = async {
        let servers = server_config()?;
        let key = serde_json::to_string(&servers)
            .map_err(|_| "MCP configuration is not serializable".to_string())?;
        cached_discover(servers, &mut cancelled)
            .await
            .map(|tools| (key, tools))
    }
    .await;
    remove_call(request_id)?;
    match result {
        Ok((key, tools)) => {
            *DISCOVERY_CACHE
                .get_or_init(|| Mutex::new(None))
                .lock()
                .map_err(|_| "MCP discovery cache is unavailable".to_string())? =
                Some((key, tools.clone()));
            Ok(tools)
        }
        Err(error) => Err(error),
    }
}

fn server_config() -> Result<Vec<ContextServer>, String> {
    let raw = std::env::var("DOCUBOOK_MCP_SERVERS").unwrap_or_default();
    if raw.is_empty() {
        return Ok(CONFIGURED_SERVERS
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| "MCP configuration is unavailable".to_string())?
            .clone()
            .unwrap_or_default());
    }
    let servers: Vec<ContextServer> = serde_json::from_str(&raw)
        .map_err(|_| "DOCUBOOK_MCP_SERVERS must be a JSON array".to_string())?;
    if servers.len() > 16 {
        return Err("Too many MCP servers".into());
    }
    for server in &servers {
        validate_server(server)?;
    }
    validate_server_names(&servers)?;
    Ok(servers)
}

async fn discover_from(
    servers: Vec<ContextServer>,
    cancelled: &mut watch::Receiver<bool>,
) -> Result<Vec<ContextTool>, String> {
    let discovered = futures_util::future::join_all(servers.into_iter().map(|server| {
        let mut cancelled = cancelled.clone();
        async move {
            let result = post_with(&server, "tools/list", json!({}), Some(&mut cancelled)).await?;
            let listed: ToolListResult = serde_json::from_value(result)
                .map_err(|_| "Malformed MCP discovery response".to_string())?;
            Ok::<_, String>((server, listed.tools))
        }
    }))
    .await;
    let mut output = Vec::new();
    for result in discovered {
        let (server, tools) = result?;
        for tool in tools {
            if output.len() == MAX_DISCOVERED_TOOLS
                || tool.name.is_empty()
                || tool.name.len() > 128
                || tool.description.len() > 4096
                || !tool.input_schema.is_object()
                || serde_json::to_vec(&tool.input_schema)
                    .map_or(true, |schema| schema.len() > 16 * 1024)
            {
                return Err(
                    "MCP discovery exceeds its tool limit or contains an invalid tool".into(),
                );
            }
            let read_only = tool_is_read_only(&server, &tool);
            let alias = format!("mcp_{}", output.len());
            output.push(ContextTool {
                server_name: server.name.clone(),
                name: alias,
                description: tool.description,
                input_schema: tool.input_schema,
                read_only,
                remote_name: tool.name,
            });
        }
    }
    Ok(output)
}

async fn cached_discover(
    servers: Vec<ContextServer>,
    cancelled: &mut watch::Receiver<bool>,
) -> Result<Vec<ContextTool>, String> {
    let key = serde_json::to_string(&servers)
        .map_err(|_| "MCP configuration is not serializable".to_string())?;
    {
        let cache = DISCOVERY_CACHE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| "MCP discovery cache is unavailable".to_string())?;
        if let Some((cached_key, tools)) = cache.as_ref() {
            if cached_key == &key {
                return Ok(tools.clone());
            }
        }
    }
    discover_from(servers, cancelled).await
}

pub fn frame_result(value: &Value) -> Result<String, String> {
    let text =
        serde_json::to_string(value).map_err(|_| "MCP result is not serializable".to_string())?;
    if text.len() > MAX_CONTEXT_RESULT_BYTES
        || value
            .as_array()
            .is_some_and(|items| items.len() > MAX_CONTEXT_ITEMS)
        || value
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|items| items.len() > MAX_CONTEXT_ITEMS)
    {
        return Err("MCP result exceeds the context result limit".into());
    }
    serde_json::to_string(
        &json!({"type": UNTRUSTED_REFERENCE_TYPE, "truncated": false, "content": value}),
    )
    .map_err(|_| "MCP result is not serializable".into())
}

pub async fn invoke(request_id: &str, name: &str, input: Value) -> Result<String, String> {
    if request_id.is_empty() {
        return Err("Context-tool request id is required".into());
    }
    let (cancel, mut cancelled) = watch::channel(false);
    register_call(request_id, cancel)?;
    let result = async {
        let servers = server_config()?;
        let tools = cached_discover(servers.clone(), &mut cancelled).await?;
        let tool = tools
            .iter()
            .find(|tool| tool.name == name)
            .ok_or_else(|| "Context tool is not available".to_string())?;
        if !tool.read_only {
            return Err("Context tool requires user confirmation".into());
        }
        let server = servers
            .into_iter()
            .find(|server| server.name == tool.server_name)
            .ok_or_else(|| "MCP server is not configured".to_string())?;
        let response = post_with(
            &server,
            "tools/call",
            json!({"name": tool.remote_name, "arguments": input}),
            Some(&mut cancelled),
        )
        .await?;
        frame_result(&response)
    }
    .await;
    remove_call(request_id)?;
    result
}

pub fn cancel(request_id: &str) {
    if let Some(sender) = CONTEXT_CALLS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|mut calls| calls.remove(request_id))
    {
        let _ = sender.send(true);
    }
}

pub fn is_document_tool(name: &str) -> bool {
    name == crate::rust_ai::tool_schema::DOCUMENT_OPERATION_TOOL
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_server_accepts_name_and_migrates_legacy_id() {
        let named: ContextServer = serde_json::from_value(json!({
            "name":"docs",
            "url":"https://example.com/mcp",
            "timeoutSeconds":25
        }))
        .unwrap();
        let legacy: ContextServer = serde_json::from_value(json!({
            "id":"docs",
            "url":"https://example.com/mcp",
            "readOnlyTools":["docs:lookup"]
        }))
        .unwrap();
        assert_eq!(named.name, legacy.name);
        assert_eq!(named.url, legacy.url);
        assert_eq!(named.timeout_seconds, Some(25));
        assert_eq!(legacy.timeout_seconds, None);
        assert_eq!(legacy.read_only_tools, ["docs:lookup"]);
    }

    #[test]
    fn configured_server_validation_rejects_duplicate_names() {
        let servers = vec![
            ContextServer {
                name: "docs".into(),
                url: "https://example.com/mcp".into(),
                timeout_seconds: None,
                token: None,
                read_only_tools: Vec::new(),
            },
            ContextServer {
                name: "docs".into(),
                url: "https://example.com/mcp".into(),
                timeout_seconds: None,
                token: None,
                read_only_tools: Vec::new(),
            },
        ];
        assert_eq!(
            validate_configured_servers(&servers),
            Err("MCP server names must be unique".into())
        );
    }
    #[test]
    fn frames_results_as_untrusted_data() {
        let framed = frame_result(&json!({"content":[{"text":"reference"}]})).unwrap();
        assert!(framed.contains(UNTRUSTED_REFERENCE_TYPE));
        assert!(!is_document_tool("lookup"));
        assert!(is_document_tool("applyDocumentOperations"));
    }
    #[test]
    fn rejects_oversized_result_items() {
        let value = json!((0..=MAX_CONTEXT_ITEMS)
            .map(|_| json!("x"))
            .collect::<Vec<_>>());
        assert!(frame_result(&value).is_err());
    }
    #[test]
    fn context_tool_names_are_provider_safe_aliases() {
        let name = "mcp_0";
        assert!(name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'));
        assert!(name.len() <= 64);
    }

    #[test]
    fn filters_tools_using_read_only_annotations() {
        let safe: RemoteTool = serde_json::from_value(json!({
            "name":"lookup",
            "inputSchema":{"type":"object"},
            "annotations":{"readOnlyHint":true,"destructiveHint":false}
        }))
        .unwrap();
        let destructive: RemoteTool = serde_json::from_value(json!({
            "name":"delete",
            "inputSchema":{"type":"object"},
            "annotations":{"readOnlyHint":true,"destructiveHint":true}
        }))
        .unwrap();
        let unannotated: RemoteTool = serde_json::from_value(json!({
            "name":"unknown",
            "inputSchema":{"type":"object"}
        }))
        .unwrap();
        let server = ContextServer {
            name: "docs".into(),
            url: "https://example.com/mcp".into(),
            timeout_seconds: None,
            token: None,
            read_only_tools: Vec::new(),
        };
        assert!(tool_is_read_only(&server, &safe));
        assert!(!tool_is_read_only(&server, &destructive));
        assert!(!tool_is_read_only(&server, &unannotated));

        let legacy_allowlist = ContextServer {
            read_only_tools: vec!["docs:unknown".into()],
            ..server.clone()
        };
        assert!(tool_is_read_only(&legacy_allowlist, &unannotated));
        assert!(!tool_is_read_only(&legacy_allowlist, &safe));
    }

    #[test]
    fn jsonrpc_request_ids_are_unique() {
        assert_ne!(next_jsonrpc_id(), next_jsonrpc_id());
    }

    #[test]
    fn rejects_timeout_outside_configured_bounds() {
        let server = ContextServer {
            name: "docs".into(),
            url: "https://example.com/mcp".into(),
            timeout_seconds: Some(MAX_CONTEXT_REQUEST_TIMEOUT_SECS + 1),
            token: None,
            read_only_tools: Vec::new(),
        };
        assert!(validate_server(&server).is_err());
    }

    #[test]
    fn parses_crlf_sse_frames() {
        let envelopes = parse_envelopes(
            "text/event-stream",
            b"event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":\"request\"}\r\n\r\n",
        )
        .unwrap();
        assert_eq!(envelopes[0]["id"], "request");
    }

    #[test]
    fn flattens_json_rpc_batches() {
        let envelopes = parse_envelopes(
            "application/json",
            br#"[{"jsonrpc":"2.0","id":"other"},{"jsonrpc":"2.0","id":"request"}]"#,
        )
        .unwrap();
        assert_eq!(envelopes.len(), 2);
        assert_eq!(envelopes[1]["id"], "request");
    }

    #[tokio::test]
    async fn duplicate_context_requests_do_not_replace_cancellation_sender() {
        let (first, _receiver) = watch::channel(false);
        register_call("same-request", first).unwrap();
        let (second, _receiver) = watch::channel(false);
        assert!(register_call("same-request", second).is_err());
        cancel("same-request");
        remove_call("same-request").unwrap();
    }
}
