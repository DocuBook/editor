use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::watch;

pub const MAX_DISCOVERED_TOOLS: usize = 64;
/// Hard transport cap per MCP response. This bounds memory only; results below
/// it are paged to the model instead of being rejected.
pub const MAX_CONTEXT_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// Results whose serialized form exceeds this are paged via `read_context_result`.
pub const CONTEXT_PAGE_BYTES: usize = 8 * 1024;
/// Upper bound for one framed page. Stays below the frontend per-result slice
/// (12k UTF-16 units; UTF-8 bytes >= UTF-16 units) so page metadata survives.
const MAX_FRAMED_PAGE_BYTES: usize = 11_000;
const MAX_STORED_RESULTS: usize = 16;
const MAX_STORED_RESULT_BYTES: usize = 16 * 1024 * 1024;
const STORED_RESULT_TTL: Duration = Duration::from_secs(15 * 60);
/// Built-in read-only tool that returns later pages of a large context result.
pub const READ_CONTEXT_RESULT_TOOL: &str = "read_context_result";
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
static STORED_RESULTS: OnceLock<Mutex<ResultStore>> = OnceLock::new();

#[derive(Default)]
struct ResultStore {
    entries: VecDeque<StoredResult>,
    bytes: usize,
}

struct StoredResult {
    handle: String,
    text: String,
    created: Instant,
}

impl ResultStore {
    fn evict_expired(&mut self) {
        while self
            .entries
            .front()
            .is_some_and(|entry| entry.created.elapsed() > STORED_RESULT_TTL)
        {
            self.pop_oldest();
        }
    }

    fn pop_oldest(&mut self) {
        if let Some(entry) = self.entries.pop_front() {
            self.bytes -= entry.text.len();
        }
    }

    fn insert(&mut self, handle: String, text: String) {
        self.evict_expired();
        while !self.entries.is_empty()
            && (self.entries.len() >= MAX_STORED_RESULTS
                || self.bytes + text.len() > MAX_STORED_RESULT_BYTES)
        {
            self.pop_oldest();
        }
        self.bytes += text.len();
        self.entries.push_back(StoredResult {
            handle,
            text,
            created: Instant::now(),
        });
    }
}

/// Lock the result store, recovering from poisoning (entries are always whole).
fn stored_results() -> MutexGuard<'static, ResultStore> {
    STORED_RESULTS
        .get_or_init(|| Mutex::new(ResultStore::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Random handle so callers sharing a process cannot feasibly guess each other's results.
fn new_result_handle() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("operating system random source is unavailable");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Set runtime-provided MCP configuration. Environment configuration remains
/// authoritative when present; this is used by the Settings-backed runtimes.
pub fn set_configured_servers(servers: Vec<ContextServer>) -> Result<(), String> {
    validate_configured_servers(&servers)?;
    let mut configured = CONFIGURED_SERVERS
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "MCP configuration is unavailable".to_string())?;
    let current_keys = servers
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(|_| "Invalid MCP server configuration".to_string())?;
    let retired = {
        let sessions = MCP_SESSIONS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| "MCP session cache is unavailable".to_string())?;
        sessions
            .iter()
            .filter(|(key, (session, _))| {
                session.is_some() && !current_keys.contains(*key)
            })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<Vec<_>>()
    };
    if !retired.is_empty() && tokio::runtime::Handle::try_current().is_err() {
        return Err("MCP session cleanup requires an active Tokio runtime; configuration unchanged".into());
    }
    if configured.as_ref() == Some(&servers) && retired.is_empty() {
        return Ok(());
    }
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
                    tracing::error!(event = "mcp_session_cleanup_failed", reason = "invalid_server_state");
                    continue;
                };
                let Some(session) = session else {
                    continue;
                };
                let Ok(gate) = session_gate(&server.name) else {
                    continue;
                };
                let _session_guard = gate.lock().await;
                match terminate_session(&server, &session, &version).await {
                    Ok(()) => {
                        if let Ok(mut sessions) = MCP_SESSIONS
                            .get_or_init(|| Mutex::new(HashMap::new()))
                            .lock()
                        {
                            if sessions.get(&key).is_some_and(|(current, _)| {
                                current.as_deref() == Some(session.as_str())
                            }) {
                                sessions.remove(&key);
                            }
                        }
                    }
                    Err(error) => tracing::warn!(
                        event = "mcp_session_cleanup_failed",
                        server = %server.name,
                        error = %error,
                        "MCP session remains cached for retry"
                    ),
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

/// Lock the active-call registry, recovering from poisoning. The map only ever
/// holds whole entries, so a recovered guard is still sound; returning an error
/// here would silently disable Stop for an already-running request.
fn calls() -> MutexGuard<'static, HashMap<String, watch::Sender<bool>>> {
    CONTEXT_CALLS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn register_call(request_id: &str, sender: watch::Sender<bool>) -> Result<(), String> {
    let mut calls = calls();
    if calls.contains_key(request_id) {
        return Err("Context-tool request is already active".into());
    }
    calls.insert(request_id.to_string(), sender);
    Ok(())
}

fn remove_call(request_id: &str) -> Result<(), String> {
    calls().remove(request_id);
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
struct RemoteTool {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    #[serde(rename = "inputSchema", alias = "input_schema")]
    input_schema: Value,
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

fn remove_session(key: &str, session: &str) {
    if let Ok(mut sessions) = MCP_SESSIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        if sessions
            .get(key)
            .is_some_and(|(current, _)| current.as_deref() == Some(session))
        {
            sessions.remove(key);
        }
    }
}

fn tool_is_read_only(server: &ContextServer, tool: &RemoteTool) -> bool {
    // Remote annotations are hints only; authorization comes from local configuration.
    let qualified = format!("{}:{}", server.name, tool.name);
    server
        .read_only_tools
        .iter()
        .any(|allowed| allowed == &qualified)
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
        .is_some_and(|length| length as usize > MAX_CONTEXT_RESPONSE_BYTES)
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
        if bytes.len() + chunk.len() > MAX_CONTEXT_RESPONSE_BYTES {
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
        if let (Some(session), Some(version)) = (session.as_ref(), Some(&protocol_version)) {
            MCP_SESSIONS
                .get_or_init(|| Mutex::new(HashMap::new()))
                .lock()
                .map_err(|_| "MCP session cache unavailable".to_string())?
                .insert(key.clone(), (Some(session.clone()), version.clone()));
        }
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
                match terminate_session(server, session, &protocol_version).await {
                    Ok(()) => remove_session(&key, session),
                    Err(cleanup_error) => tracing::warn!(
                        event = "mcp_session_cleanup_failed",
                        server = %server.name,
                        error = %cleanup_error,
                        "MCP session remains cached for retry"
                    ),
                }
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
            if let Some(session) = session.as_deref() {
                match terminate_session(server, session, &protocol_version).await {
                    Ok(()) => remove_session(&key, session),
                    Err(cleanup_error) => tracing::warn!(
                        event = "mcp_session_cleanup_failed",
                        server = %server.name,
                        error = %cleanup_error,
                        "MCP session remains cached for retry"
                    ),
                }
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
    append_builtin_tools(&mut output);
    Ok(output)
}

/// Offer paging only when at least one remote tool can produce a result.
fn append_builtin_tools(output: &mut Vec<ContextTool>) {
    if output.is_empty() {
        return;
    }
    output.push(ContextTool {
        server_name: String::new(),
        name: READ_CONTEXT_RESULT_TOOL.into(),
        description: "Read the next page of a large context-tool result. Call it with the `handle` and `next_offset` from a result whose `truncated` is true; repeat until `next_offset` is null. Only read as many pages as the task needs.".into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "handle": {"type": "string", "description": "page.handle from the earlier result"},
                "offset": {"type": "integer", "minimum": 0, "description": "page.next_offset from the earlier result"}
            },
            "required": ["handle", "offset"],
            "additionalProperties": false
        }),
        read_only: true,
        remote_name: String::new(),
    });
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

/// Frame a tool result as untrusted data. Small results are returned whole;
/// larger ones are stored and returned page by page instead of being rejected.
pub fn frame_result(value: &Value) -> Result<String, String> {
    let text =
        serde_json::to_string(value).map_err(|_| "MCP result is not serializable".to_string())?;
    if text.len() <= CONTEXT_PAGE_BYTES {
        return serde_json::to_string(
            &json!({"type": UNTRUSTED_REFERENCE_TYPE, "truncated": false, "content": value}),
        )
        .map_err(|_| "MCP result is not serializable".into());
    }
    let source = result_text(value)?;
    let handle = new_result_handle();
    let first = frame_page(&handle, &source, 0)?;
    stored_results().insert(handle, source);
    Ok(first)
}

/// Flatten an MCP CallToolResult into readable text so pages split prose, not
/// JSON structure. Binary payloads are replaced by a placeholder.
fn result_text(value: &Value) -> Result<String, String> {
    let serialize = |value: &Value| {
        serde_json::to_string_pretty(value)
            .map_err(|_| "MCP result is not serializable".to_string())
    };
    let Some(items) = value.get("content").and_then(Value::as_array) else {
        return match value.get("structuredContent") {
            Some(structured) => serialize(structured),
            None => serialize(value),
        };
    };
    let mut parts = Vec::with_capacity(items.len());
    for item in items {
        let text = item
            .get("text")
            .or_else(|| {
                item.get("resource")
                    .and_then(|resource| resource.get("text"))
            })
            .and_then(Value::as_str);
        match (text, item.get("type").and_then(Value::as_str)) {
            (Some(text), _) => parts.push(text.to_string()),
            (None, Some(kind @ ("image" | "audio"))) => parts.push(format!(
                "[{kind} omitted: {}]",
                item.get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown type")
            )),
            _ => parts.push(serialize(item)?),
        }
    }
    Ok(parts.join("\n\n"))
}

/// Frame one page starting at byte `offset`. Metadata precedes content so a
/// downstream character slice can never drop the handle or next offset.
fn frame_page(handle: &str, text: &str, offset: usize) -> Result<String, String> {
    if offset > text.len() || !text.is_char_boundary(offset) {
        return Err("Invalid context result offset".into());
    }
    let to_json = |value: &Value| {
        serde_json::to_string(value).map_err(|_| "MCP result is not serializable".to_string())
    };
    let mut budget = CONTEXT_PAGE_BYTES;
    loop {
        let mut end = (offset + budget).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        if end == offset && offset < text.len() {
            // Always make progress by at least one character.
            end = offset + text[offset..].chars().next().map_or(0, char::len_utf8);
        }
        let next_offset = (end < text.len()).then_some(end);
        let page = json!({
            "handle": handle,
            "offset": offset,
            "next_offset": next_offset,
            "total_bytes": text.len(),
            "continue_with": next_offset.map(|_| READ_CONTEXT_RESULT_TOOL),
        });
        let framed = format!(
            "{{\"type\":{},\"truncated\":{},\"page\":{},\"content\":{}}}",
            to_json(&json!(UNTRUSTED_REFERENCE_TYPE))?,
            next_offset.is_some(),
            to_json(&page)?,
            to_json(&json!(&text[offset..end]))?,
        );
        // JSON escaping can inflate content; shrink until the frame fits.
        if framed.len() <= MAX_FRAMED_PAGE_BYTES || end - offset <= 4 {
            return Ok(framed);
        }
        budget = (end - offset) * 3 / 4;
    }
}

/// Serve `read_context_result`: a later page of a stored large result.
fn read_stored_page(input: &Value) -> Result<String, String> {
    let handle = input
        .get("handle")
        .and_then(Value::as_str)
        .filter(|handle| handle.len() == 64 && handle.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| "Invalid context result handle".to_string())?;
    let offset = input
        .get("offset")
        .and_then(Value::as_u64)
        .and_then(|offset| usize::try_from(offset).ok())
        .ok_or_else(|| "Invalid context result offset".to_string())?;
    let mut store = stored_results();
    store.evict_expired();
    let entry = store
        .entries
        .iter()
        .find(|entry| entry.handle == handle)
        .ok_or_else(|| {
            "Context result expired or not found; call the original tool again".to_string()
        })?;
    frame_page(&entry.handle, &entry.text, offset)
}

pub async fn invoke(request_id: &str, name: &str, input: Value) -> Result<String, String> {
    if request_id.is_empty() {
        return Err("Context-tool request id is required".into());
    }
    if name == READ_CONTEXT_RESULT_TOOL {
        return read_stored_page(&input);
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
    // Recover from a poisoned lock instead of silently doing nothing: a panic
    // elsewhere must not turn Stop into a no-op for an already-running request.
    let sender = calls().remove(request_id);
    if let Some(sender) = sender {
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
    /// Read every page of a framed result and return the reassembled text.
    fn read_all_pages(first: &str) -> (String, usize) {
        let mut page: Value = serde_json::from_str(first).unwrap();
        let mut text = String::new();
        let mut pages = 0;
        loop {
            assert!(serde_json::to_string(&page).unwrap().len() <= MAX_FRAMED_PAGE_BYTES);
            text.push_str(page["content"].as_str().unwrap());
            pages += 1;
            let Some(next) = page["page"]["next_offset"].as_u64() else {
                assert_eq!(page["truncated"], false);
                return (text, pages);
            };
            assert_eq!(page["truncated"], true);
            let raw = read_stored_page(&json!({"handle": page["page"]["handle"], "offset": next}))
                .unwrap();
            page = serde_json::from_str(&raw).unwrap();
        }
    }

    #[test]
    fn pages_large_results_instead_of_rejecting() {
        let body = "lorem ipsum dolor sit amet ".repeat(4_000);
        let first = frame_result(&json!({"content":[{"type":"text","text": body}]})).unwrap();
        assert!(first.starts_with(r#"{"type":"untrusted_reference_data","truncated":true,"page":"#));
        let (text, pages) = read_all_pages(&first);
        assert_eq!(text, body);
        assert!(pages > 1);
    }

    #[test]
    fn many_result_items_are_paged_not_rejected() {
        let items: Vec<Value> = (0..500)
            .map(|index| json!({"type":"text","text": format!("row {index}")}))
            .collect();
        let first = frame_result(&json!({ "content": items })).unwrap();
        let (text, _) = read_all_pages(&first);
        assert!(text.starts_with("row 0\n\nrow 1") && text.ends_with("row 499"));
    }

    #[test]
    fn pages_respect_utf8_boundaries_and_escaping() {
        let body = "é漢🙂\u{1}\"".repeat(5_000);
        let first = frame_result(&json!({"content":[{"type":"text","text": body}]})).unwrap();
        let (text, _) = read_all_pages(&first);
        assert_eq!(text, body);
    }

    #[test]
    fn binary_content_is_replaced_by_placeholder() {
        let first = frame_result(&json!({"content":[
            {"type":"image","mimeType":"image/png","data": "A".repeat(20_000)},
            {"type":"text","text":"caption"}
        ]}))
        .unwrap();
        let (text, _) = read_all_pages(&first);
        assert_eq!(text, "[image omitted: image/png]\n\ncaption");
    }

    #[test]
    fn rejects_invalid_page_requests() {
        assert!(read_stored_page(&json!({"handle":"nope","offset":0})).is_err());
        assert!(read_stored_page(&json!({"handle": "0".repeat(32), "offset": 0})).is_err());
        let first =
            frame_result(&json!({"content":[{"type":"text","text": "é".repeat(10_000)}]})).unwrap();
        let page: Value = serde_json::from_str(&first).unwrap();
        let handle = page["page"]["handle"].clone();
        assert!(read_stored_page(&json!({"handle": handle, "offset": 1})).is_err());
        assert!(read_stored_page(&json!({"handle": handle, "offset": 1_000_000})).is_err());
    }

    #[test]
    fn builtin_paging_tool_is_offered_only_with_remote_tools() {
        let mut none = Vec::new();
        append_builtin_tools(&mut none);
        assert!(none.is_empty());
        let mut some = vec![ContextTool {
            server_name: "docs".into(),
            name: "mcp_0".into(),
            description: String::new(),
            input_schema: json!({"type":"object"}),
            read_only: true,
            remote_name: "lookup".into(),
        }];
        append_builtin_tools(&mut some);
        assert_eq!(some.len(), 2);
        assert_eq!(some[1].name, READ_CONTEXT_RESULT_TOOL);
        assert!(some[1].read_only);
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
    fn filters_tools_using_local_allow_list() {
        let safe: RemoteTool = serde_json::from_value(json!({
            "name":"lookup",
            "inputSchema":{"type":"object"},
            "annotations":{"readOnlyHint":true,"destructiveHint":false}
        }))
        .unwrap();
        let read_only_without_destructive_hint: RemoteTool = serde_json::from_value(json!({
            "name":"search",
            "inputSchema":{"type":"object"},
            "annotations":{"readOnlyHint":true}
        }))
        .unwrap();
        let destructive: RemoteTool = serde_json::from_value(json!({
            "name":"delete",
            "inputSchema":{"type":"object"},
            "annotations":{"readOnlyHint":false,"destructiveHint":true}
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
        assert!(!tool_is_read_only(&server, &safe));
        assert!(!tool_is_read_only(
            &server,
            &read_only_without_destructive_hint
        ));
        assert!(!tool_is_read_only(&server, &destructive));
        assert!(!tool_is_read_only(&server, &unannotated));

        let legacy_allowlist = ContextServer {
            read_only_tools: vec!["docs:unknown".into(), "docs:lookup".into()],
            ..server.clone()
        };
        assert!(tool_is_read_only(&legacy_allowlist, &unannotated));
        assert!(tool_is_read_only(&legacy_allowlist, &safe));
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

    #[test]
    fn cancellation_registry_survives_a_poisoned_lock() {
        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = calls();
            panic!("poison the active-call registry");
        }));
        assert!(poisoned.is_err());

        let (sender, mut receiver) = watch::channel(false);
        register_call("poison-recovery", sender).unwrap();
        cancel("poison-recovery");
        assert!(*receiver.borrow_and_update());
        remove_call("poison-recovery").unwrap();
    }
}
