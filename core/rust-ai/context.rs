use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

pub const MAX_DISCOVERED_TOOLS: usize = 64;
pub const MAX_CONTEXT_RESULT_BYTES: usize = 256 * 1024;
pub const MAX_CONTEXT_ITEMS: usize = 64;
pub const CONTEXT_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
pub const UNTRUSTED_REFERENCE_TYPE: &str = "untrusted_reference_data";

#[derive(Debug, Clone, Deserialize)]
pub struct ContextServer {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub read_only_tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContextTool {
    pub server_id: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub read_only: bool,
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
    if server.id.is_empty()
        || server.id.len() > 128
        || !server
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        || server.url.len() > 2048
    {
        return Err("Invalid MCP server identity or URL".into());
    }
    let url = reqwest::Url::parse(&server.url).map_err(|_| "Invalid MCP server URL".to_string())?;
    if url.scheme() != "https" || url.username() != "" || url.password().is_some() {
        return Err("MCP servers must use HTTPS without URL credentials".into());
    }
    crate::rust_ai::provider::validated_custom_addrs(&server.url, false).map(|_| ())
}

fn client(server: &ContextServer) -> Result<reqwest::Client, String> {
    let (_, addrs) = crate::rust_ai::provider::validated_custom_addrs(&server.url, false)?;
    let host = reqwest::Url::parse(&server.url)
        .map_err(|_| "Invalid MCP server URL".to_string())?
        .host_str()
        .unwrap_or_default()
        .to_string();
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONTEXT_REQUEST_TIMEOUT)
        .timeout(CONTEXT_REQUEST_TIMEOUT)
        .resolve_to_addrs(&host, &addrs)
        .build()
        .map_err(|error| format!("MCP client error: {error}"))
}

async fn post(server: &ContextServer, method: &str, params: Value) -> Result<Value, String> {
    let request = json!({"jsonrpc":"2.0","id":"docubook","method":method,"params":params});
    let mut call = client(server)?.post(&server.url).json(&request);
    if let Some(token) = &server.token {
        call = call.bearer_auth(token);
    }
    let response = call
        .send()
        .await
        .map_err(|_| "MCP request failed".to_string())?;
    if !response.status().is_success() {
        return Err(format!("MCP server returned HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length as usize > MAX_CONTEXT_RESULT_BYTES)
    {
        return Err("MCP response exceeds the context result limit".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "MCP response could not be read".to_string())?;
        if bytes.len() + chunk.len() > MAX_CONTEXT_RESULT_BYTES {
            return Err("MCP response exceeds the context result limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let envelope: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid MCP JSON response".to_string())?;
    if envelope.get("error").is_some() {
        return Err("MCP server returned an error".into());
    }
    if envelope.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || envelope.get("id").and_then(Value::as_str) != Some("docubook")
    {
        return Err("Malformed MCP JSON-RPC response".into());
    }
    Ok(envelope.get("result").cloned().unwrap_or(Value::Null))
}

pub async fn discover() -> Result<Vec<ContextTool>, String> {
    discover_from(server_config()?).await
}

fn server_config() -> Result<Vec<ContextServer>, String> {
    let raw = std::env::var("DOCUBOOK_MCP_SERVERS").unwrap_or_default();
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let servers: Vec<ContextServer> = serde_json::from_str(&raw)
        .map_err(|_| "DOCUBOOK_MCP_SERVERS must be a JSON array".to_string())?;
    if servers.len() > 16 {
        return Err("Too many MCP servers".into());
    }
    for server in &servers {
        validate_server(server)?;
    }
    Ok(servers)
}

async fn discover_from(servers: Vec<ContextServer>) -> Result<Vec<ContextTool>, String> {
    let mut output = Vec::new();
    for server in servers {
        let result = post(&server, "tools/list", json!({})).await?;
        let listed: ToolListResult = serde_json::from_value(result)
            .map_err(|_| "Malformed MCP discovery response".to_string())?;
        for tool in listed.tools {
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
            let qualified = format!("{}:{}", server.id, tool.name);
            let read_only = server
                .read_only_tools
                .iter()
                .any(|allowed| allowed == &qualified);
            output.push(ContextTool {
                server_id: server.id.clone(),
                name: qualified,
                description: tool.description,
                input_schema: tool.input_schema,
                read_only,
            });
        }
    }
    Ok(output)
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

pub async fn invoke(name: &str, input: Value) -> Result<String, String> {
    let servers = server_config()?;
    let tools = discover_from(servers.clone()).await?;
    let tool = tools
        .iter()
        .find(|tool| tool.name == name)
        .ok_or_else(|| "Context tool is not available".to_string())?;
    if !tool.read_only {
        return Err("Context tool requires user confirmation".into());
    }
    let server = servers
        .into_iter()
        .find(|server| server.id == tool.server_id)
        .ok_or_else(|| "MCP server is not configured".to_string())?;
    frame_result(
        &post(
            &server,
            "tools/call",
            json!({"name": name.split_once(':').map(|(_, tool)| tool).unwrap_or(name), "arguments": input}),
        )
        .await?,
    )
}

pub fn is_document_tool(name: &str) -> bool {
    name == crate::rust_ai::tool_schema::DOCUMENT_OPERATION_TOOL
}

pub fn native_search_supported(capability: Option<bool>) -> bool {
    capability == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn native_search_fails_closed_when_capability_is_unknown() {
        assert!(!native_search_supported(None));
        assert!(!native_search_supported(Some(false)));
        assert!(native_search_supported(Some(true)));
    }

    #[test]
    fn context_tool_names_are_server_qualified() {
        let name = format!("{}:{}", "research", "search");
        let (server, tool) = name.split_once(':').unwrap();
        assert_eq!(server, "research");
        assert_eq!(tool, "search");
    }
}
