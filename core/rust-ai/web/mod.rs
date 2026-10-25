//! Built-in web tools for rust-ai: `web_search` and `web_fetch`.
//!
//! They ride the context-tool plumbing in `context.rs` (discovery, cancellation,
//! untrusted framing, paging) and are opt-in through runtime configuration.

pub mod fetch;
pub mod ledger;
pub mod net_guard;
pub mod search;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard, OnceLock};
use tokio::sync::watch;

pub const WEB_SEARCH_TOOL: &str = "web_search";
pub const WEB_FETCH_TOOL: &str = "web_fetch";
/// Results returned by `web_search` when the model does not ask for a count.
pub const DEFAULT_MAX_RESULTS: usize = 5;
/// Upper bound for `max_results` in settings and in a single call.
pub const MAX_RESULTS_LIMIT: usize = 10;
/// Longest SearXNG base URL accepted from settings.
const MAX_SEARXNG_URL_LEN: usize = 2048;

static CONFIG: OnceLock<Mutex<WebToolsConfig>> = OnceLock::new();

/// Search backend chosen in settings; the secret travels only inside `Tavily`.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum SearchProvider {
    #[default]
    Off,
    Tavily { api_key: String },
    Searxng { base_url: String },
}

/// Runtime configuration pushed by the desktop or server adapter.
#[derive(Debug, Clone, PartialEq)]
pub struct WebToolsConfig {
    pub search: SearchProvider,
    pub fetch_enabled: bool,
    pub max_results: usize,
}

impl Default for WebToolsConfig {
    fn default() -> Self {
        Self { search: SearchProvider::Off, fetch_enabled: false, max_results: DEFAULT_MAX_RESULTS }
    }
}

/// Non-secret settings as persisted by the adapters and shown in Settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebToolsSettings {
    /// `off`, `tavily` or `searxng`.
    #[serde(default = "default_provider")]
    pub search_provider: String,
    #[serde(default)]
    pub searxng_url: String,
    #[serde(default)]
    pub fetch_enabled: bool,
    #[serde(default = "default_max_results")]
    pub max_results: usize,
}

/// Default search provider for settings that predate the field.
fn default_provider() -> String {
    "off".into()
}

/// Default result count for settings that predate the field.
fn default_max_results() -> usize {
    DEFAULT_MAX_RESULTS
}

impl Default for WebToolsSettings {
    fn default() -> Self {
        Self {
            search_provider: default_provider(),
            searxng_url: String::new(),
            fetch_enabled: false,
            max_results: DEFAULT_MAX_RESULTS,
        }
    }
}

impl WebToolsSettings {
    /// Validate the non-secret settings before they are stored.
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.search_provider.as_str(), "off" | "tavily" | "searxng") {
            return Err("Web search provider must be off, tavily or searxng".into());
        }
        if !(1..=MAX_RESULTS_LIMIT).contains(&self.max_results) {
            return Err(format!("Web search results must be between 1 and {MAX_RESULTS_LIMIT}"));
        }
        if self.search_provider == "searxng" || !self.searxng_url.is_empty() {
            validate_searxng_url(&self.searxng_url)?;
        }
        Ok(())
    }

    /// Combine the settings with the stored Tavily key into a runtime config.
    pub fn into_config(self, tavily_key: Option<String>) -> WebToolsConfig {
        let search = match self.search_provider.as_str() {
            "tavily" => tavily_key
                .filter(|key| !key.is_empty())
                .map_or(SearchProvider::Off, |api_key| SearchProvider::Tavily { api_key }),
            "searxng" if !self.searxng_url.is_empty() => SearchProvider::Searxng { base_url: self.searxng_url },
            _ => SearchProvider::Off,
        };
        WebToolsConfig {
            search,
            fetch_enabled: self.fetch_enabled,
            max_results: self.max_results.clamp(1, MAX_RESULTS_LIMIT),
        }
    }
}

/// Validate an operator-supplied SearXNG base URL.
///
/// The instance is chosen by the operator, so private and loopback hosts are
/// allowed (a compose network, a LAN box); a public host must use HTTPS.
pub fn validate_searxng_url(raw: &str) -> Result<(), String> {
    if raw.is_empty() || raw.len() > MAX_SEARXNG_URL_LEN {
        return Err("SearXNG URL is required and must be at most 2048 characters".into());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| "SearXNG URL is not a valid absolute URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("SearXNG URL must be an http or https URL".into());
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() {
        return Err("SearXNG URL must not contain credentials or a query string".into());
    }
    let host = url.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']');
    if net_guard::is_metadata_host(host) {
        return Err("SearXNG URL must not point at a link-local or cloud metadata address".into());
    }
    let local = match host.parse::<std::net::IpAddr>() {
        Ok(ip) => !net_guard::is_public_ip(ip),
        // Single-label names (compose services such as `searxng`) and mDNS names are local.
        Err(_) => !host.contains('.') || host.ends_with(".local"),
    };
    if url.scheme() == "http" && !local {
        return Err("A public SearXNG instance must use HTTPS".into());
    }
    Ok(())
}

/// Lock the runtime configuration, recovering from poisoning (it is replaced whole).
fn config() -> MutexGuard<'static, WebToolsConfig> {
    CONFIG
        .get_or_init(|| Mutex::new(WebToolsConfig::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Replace the runtime configuration used by discovery and invocation.
pub fn set_config(next: WebToolsConfig) -> Result<(), String> {
    if let SearchProvider::Searxng { base_url } = &next.search {
        validate_searxng_url(base_url)?;
    }
    *config() = next;
    Ok(())
}

/// Snapshot the runtime configuration.
pub fn current_config() -> WebToolsConfig {
    config().clone()
}

/// Report whether `name` is one of the built-in web tools.
pub fn is_web_tool(name: &str) -> bool {
    name == WEB_SEARCH_TOOL || name == WEB_FETCH_TOOL
}

/// Name, description and input schema of one ready built-in tool.
pub struct ToolSpec {
    pub name: &'static str,
    pub description: String,
    pub input_schema: Value,
}

/// List the built-in tools that are enabled and fully configured.
pub fn ready_tools() -> Vec<ToolSpec> {
    let config = current_config();
    let mut tools = Vec::new();
    if config.search != SearchProvider::Off {
        tools.push(ToolSpec {
            name: WEB_SEARCH_TOOL,
            description: format!(
                "Search the web. Returns up to {} results (title, url, snippet). Use it before editing when the task needs facts that are not in the document; cite or fetch the URLs it returns.",
                config.max_results
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query, 1-400 characters"},
                    "max_results": {"type": "integer", "minimum": 1, "maximum": config.max_results},
                    "time_range": {"type": "string", "enum": ["day", "week", "month", "year"]}
                },
                "required": ["query"],
                "additionalProperties": false
            }),
        });
    }
    if config.fetch_enabled {
        tools.push(ToolSpec {
            name: WEB_FETCH_TOOL,
            description: "Fetch one web page and return its main text. Only URLs from the user's prompt, the document, or earlier web_search/web_fetch results can be fetched; never build URLs yourself.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Absolute http(s) URL seen earlier in this conversation"}
                },
                "required": ["url"],
                "additionalProperties": false
            }),
        });
    }
    tools
}

/// Error returned to the model inside the tool result (never a request failure).
#[derive(Debug, Clone, PartialEq)]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
}

impl ToolError {
    /// Build an error with a stable code the model can act on.
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    /// The model's arguments are malformed.
    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new("invalid_input", message)
    }
    /// The URL breaks a fetch rule (scheme, port, credentials, non-public host).
    pub fn url_not_allowed(message: impl Into<String>) -> Self {
        Self::new("url_not_allowed", message)
    }
    /// The URL was not seen in this prompt turn (provenance rule).
    pub fn url_not_in_context() -> Self {
        Self::new("url_not_in_context", "the URL did not appear in the prompt, the document or an earlier web result")
    }
    /// The page could not be reached or answered with an error status.
    pub fn url_not_accessible(message: impl Into<String>) -> Self {
        Self::new("url_not_accessible", message)
    }
    /// The page is not HTML or plain text.
    pub fn unsupported_content_type(message: impl Into<String>) -> Self {
        Self::new("unsupported_content_type", message)
    }
    /// The search provider is throttling requests.
    pub fn rate_limited(message: impl Into<String>) -> Self {
        Self::new("rate_limited", message)
    }
    /// The search plan's credits are used up.
    pub fn quota_exceeded(message: impl Into<String>) -> Self {
        Self::new("quota_exceeded", message)
    }
    /// The search API key was rejected.
    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new("unauthorized", message)
    }
    /// The provider or network failed, or the call was cancelled.
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new("unavailable", message)
    }
    /// The tool is switched off in Settings.
    pub fn not_enabled(tool: &str) -> Self {
        Self::new("tool_not_enabled", format!("{tool} is not enabled in Settings"))
    }

    /// Render as the JSON value framed for the model.
    pub fn to_value(&self) -> Value {
        json!({"error": {"code": self.code, "message": self.message}})
    }
}

/// Run a built-in web tool and return its JSON result or a typed tool error.
///
/// `context_id` keys the URL-provenance ledger for the whole prompt turn.
pub async fn invoke(
    context_id: &str,
    name: &str,
    input: &Value,
    cancelled: &mut watch::Receiver<bool>,
) -> Result<Value, ToolError> {
    let config = current_config();
    match name {
        WEB_SEARCH_TOOL => {
            if config.search == SearchProvider::Off {
                return Err(ToolError::not_enabled(WEB_SEARCH_TOOL));
            }
            let request = search::SearchRequest::from_input(input, config.max_results)?;
            let hits = search::search(&config.search, &request, cancelled).await?;
            ledger::record(context_id, hits.iter().map(|hit| hit.url.as_str()));
            Ok(json!({"query": request.query, "results": hits}))
        }
        WEB_FETCH_TOOL => {
            if !config.fetch_enabled {
                return Err(ToolError::not_enabled(WEB_FETCH_TOOL));
            }
            let url = input
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolError::invalid_input("url is required"))?;
            let page = fetch::fetch(context_id, url, cancelled).await?;
            Ok(page.to_value())
        }
        _ => Err(ToolError::invalid_input("unknown web tool")),
    }
}

/// Serialise tests that replace the process-wide configuration (held across awaits).
#[cfg(test)]
pub(crate) async fn test_config_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    LOCK.lock().await
}

/// Map a cancelled watch channel to the tool error used everywhere.
pub(crate) fn cancelled_error() -> ToolError {
    ToolError::unavailable("request cancelled")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(provider: &str, searxng_url: &str) -> WebToolsSettings {
        WebToolsSettings {
            search_provider: provider.into(),
            searxng_url: searxng_url.into(),
            fetch_enabled: true,
            max_results: DEFAULT_MAX_RESULTS,
        }
    }

    #[test]
    fn searxng_urls_may_be_local_but_public_ones_need_https() {
        for ok in ["http://searxng:8080", "http://127.0.0.1:8888/", "http://192.168.1.5", "http://[::1]:8080", "http://box.local", "https://search.example.com/sx"] {
            assert!(validate_searxng_url(ok).is_ok(), "{ok} must be accepted");
        }
        for bad in [
            "", "http://search.example.com", "https://u:p@search.example.com", "ftp://searxng", "https://search.example.com/?q=x", "not a url",
            "http://169.254.169.254/latest", "http://[fe80::1]:8080", "http://[fd00:ec2::254]", "http://metadata.google.internal", "http://[::ffff:169.254.169.254]",
        ] {
            assert!(validate_searxng_url(bad).is_err(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn settings_validation_covers_provider_and_result_count() {
        assert!(settings("off", "").validate().is_ok());
        assert!(settings("tavily", "").validate().is_ok());
        assert!(settings("searxng", "").validate().is_err());
        assert!(settings("bing", "").validate().is_err());
        let mut too_many = settings("off", "");
        too_many.max_results = MAX_RESULTS_LIMIT + 1;
        assert!(too_many.validate().is_err());
        let legacy: WebToolsSettings = serde_json::from_str("{}").unwrap();
        assert_eq!((legacy.search_provider.as_str(), legacy.max_results, legacy.fetch_enabled), ("off", DEFAULT_MAX_RESULTS, false));
    }

    #[test]
    fn runtime_config_needs_the_secret_or_url_to_enable_search() {
        assert_eq!(settings("tavily", "").into_config(None).search, SearchProvider::Off);
        assert_eq!(settings("tavily", "").into_config(Some(String::new())).search, SearchProvider::Off);
        assert_eq!(settings("tavily", "").into_config(Some("tvly-x".into())).search, SearchProvider::Tavily { api_key: "tvly-x".into() });
        assert_eq!(
            settings("searxng", "http://searxng:8080").into_config(Some("ignored".into())).search,
            SearchProvider::Searxng { base_url: "http://searxng:8080".into() }
        );
    }

    #[tokio::test]
    async fn only_enabled_tools_are_listed_and_callable() {
        let _guard = test_config_lock().await;
        set_config(WebToolsConfig::default()).unwrap();
        assert!(ready_tools().is_empty());
        let (_cancel, mut cancelled) = watch::channel(false);
        for tool in [WEB_SEARCH_TOOL, WEB_FETCH_TOOL] {
            let error = invoke("turn", tool, &json!({"query": "q", "url": "https://e.example/"}), &mut cancelled).await.unwrap_err();
            assert_eq!(error.code, "tool_not_enabled");
        }
        set_config(WebToolsConfig { fetch_enabled: true, ..WebToolsConfig::default() }).unwrap();
        assert_eq!(ready_tools().iter().map(|tool| tool.name).collect::<Vec<_>>(), [WEB_FETCH_TOOL]);
        set_config(WebToolsConfig { search: SearchProvider::Tavily { api_key: "k".into() }, fetch_enabled: true, max_results: 3 }).unwrap();
        let tools = ready_tools();
        assert_eq!(tools.iter().map(|tool| tool.name).collect::<Vec<_>>(), [WEB_SEARCH_TOOL, WEB_FETCH_TOOL]);
        assert_eq!(tools[0].input_schema["properties"]["max_results"]["maximum"], 3);
        assert!(set_config(WebToolsConfig { search: SearchProvider::Searxng { base_url: "http://public.example.com".into() }, ..WebToolsConfig::default() }).is_err());
        set_config(WebToolsConfig::default()).unwrap();
    }
}
