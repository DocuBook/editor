use std::net::ToSocketAddrs;

/// AI agent configuration for API calls.
pub struct Agent {
    /// Provider label emitted with completed responses.
    pub provider: String,
    pub model: String,
    pub api_key: String,
    pub base_url: String,
}

impl Agent {
    pub fn new(provider: &str, model: &str, api_key: &str, base_url: &str) -> Self {
        Self {
            provider: provider.to_string(),
            model: model.to_string(),
            api_key: api_key.to_string(),
            base_url: base_url.to_string(),
        }
    }
}

/// Hosts allowed as AI API base URLs from the provider catalog.
pub const ALLOWED_API_HOSTS: &[&str] = &["127.0.0.1", "localhost", "opencode.ai", "api.deepseek.com"];

/// Synthetic provider ID for user-configured OpenAI-compatible endpoints.
pub const CUSTOM_PROVIDER_ID: &str = "openai-compatible";

/** OpenCode Go rejects traffic that does not identify the calling product
 *  explicitly, so every request we send carries our own name. */
pub const AI_USER_AGENT: &str = "DocuBook/1.0";

/** OpenCode Go routes by conversation and returns a hard 400
 *  (`MissingSessionID`) without this header. Only that gateway needs it, so the
 *  header is keyed off the provider id rather than sent to everyone. */
pub const SESSION_PROVIDER_ID: &str = "opencode-go";

/// Process-stable session id. The chat layer currently does not expose a
/// conversation id, so this preserves one identity across turns in a running
/// app without adding a vendor-specific transport abstraction.
pub fn session_id() -> &'static str {
    use std::sync::OnceLock;
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("docubook-{nanos:x}-{:x}", std::process::id())
    })
}

/// Catalog provider IDs, in the same order as the frontend provider list.
/// Kept here because the web server must decide which providers have a key
/// without trusting a client-supplied list.
pub const PROVIDER_IDS: [&str; 2] = ["opencode-go", "deepseek"];

/// Canonical OpenAI-compatible base URL for a catalog provider. The web server
/// resolves base URLs from config.json; this is the fallback default so the
/// catalog does not have to be duplicated in the server.
pub fn catalog_base_url(provider: &str) -> Option<&'static str> {
    match provider {
        "opencode-go" => Some("https://opencode.ai/zen/go/v1"),
        "deepseek" => Some("https://api.deepseek.com"),
        _ => None,
    }
}

fn is_loopback(host: &str) -> bool {
    host == "localhost"
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

fn validate_scheme_and_host(url: &reqwest::Url) -> Result<String, String> {
    let host = url.host_str().unwrap_or("").to_lowercase();
    if !url.username().is_empty() {
        return Err("Base URL must not contain credentials (user:pass@)".into());
    }
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(&host) => {}
        "http" => {
            return Err("HTTP base URLs are only allowed for local (localhost) servers".into())
        }
        _ => return Err("Base URL must use http(s)".into()),
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        let internal_non_loopback = match ip {
            std::net::IpAddr::V4(v) => {
                !v.is_loopback()
                    && (v.is_private()
                        || v.is_link_local()
                        || v.is_unspecified()
                        || v.is_multicast())
            }
            std::net::IpAddr::V6(v) => !v.is_loopback() && (v.is_unspecified() || v.is_multicast()),
        };
        if internal_non_loopback {
            return Err("Internal network addresses are not allowed".into());
        }
    }
    Ok(host)
}

/// Validate and resolve a custom endpoint once. Consumers pin their HTTP client
/// to these addresses so DNS cannot change between validation and connection.
pub fn validated_custom_addrs(
    base_url: &str,
    allow_loopback: bool,
) -> Result<(String, Vec<std::net::SocketAddr>), String> {
    let url = reqwest::Url::parse(base_url).map_err(|_| format!("Invalid base URL: {base_url}"))?;
    let host = validate_scheme_and_host(&url)?;
    if is_loopback(&host) && !allow_loopback {
        return Err("Loopback addresses are not allowed on the server".into());
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<std::net::SocketAddr> = if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        vec![std::net::SocketAddr::new(ip, port)]
    } else {
        (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|_| format!("Could not resolve host \"{host}\" — DNS lookup failed"))?
            .collect()
    };
    if addrs.is_empty() {
        return Err(format!("Could not resolve host \"{host}\""));
    }
    for address in &addrs {
        let ip = address.ip();
        let internal = match ip {
            std::net::IpAddr::V4(v) => {
                v.is_private()
                    || v.is_link_local()
                    || v.is_unspecified()
                    || v.is_multicast()
                    || v.is_loopback()
            }
            std::net::IpAddr::V6(v) => {
                v.is_unspecified() || v.is_multicast() || v.is_loopback() || v.is_unique_local()
            }
        };
        if internal && !(allow_loopback && ip.is_loopback()) {
            return Err(format!(
                "Host \"{host}\" resolves to an internal address ({ip}) — not allowed"
            ));
        }
    }
    Ok((host, addrs))
}

/// How long a chat request reuses a custom endpoint's validated addresses. Each
/// model round of a turn resolved the host again: a blocking lookup (musl in the
/// Docker image keeps no resolver cache) and, whenever the answer came back in a
/// different set, a newly pinned client paying TCP and TLS setup again.
const CHAT_RESOLUTION_TTL: std::time::Duration = std::time::Duration::from_secs(30);
const MAX_CHAT_RESOLUTIONS: usize = 8;

type Resolution = (String, Vec<std::net::SocketAddr>);
type ResolutionKey = (String, bool);
static CHAT_RESOLUTIONS: std::sync::Mutex<Vec<(ResolutionKey, std::time::Instant, Resolution)>> =
    std::sync::Mutex::new(Vec::new());

/// `resolve` behind the chat cache. Only an answer that passed validation is
/// kept, so the cache can only replay addresses that were allowed; a refusal or
/// a failed lookup is retried on the next round.
fn cached_chat_resolution(
    key: ResolutionKey,
    now: std::time::Instant,
    resolve: impl FnOnce() -> Result<Resolution, String>,
) -> Result<Resolution, String> {
    let fresh = |at: &std::time::Instant| now.saturating_duration_since(*at) < CHAT_RESOLUTION_TTL;
    {
        let mut cached = CHAT_RESOLUTIONS.lock().unwrap_or_else(|e| e.into_inner());
        cached.retain(|(_, at, _)| fresh(at));
        if let Some((_, _, resolution)) = cached.iter().find(|(k, _, _)| *k == key) {
            return Ok(resolution.clone());
        }
    }
    let resolution = resolve()?;
    let mut cached = CHAT_RESOLUTIONS.lock().unwrap_or_else(|e| e.into_inner());
    cached.retain(|(k, _, _)| *k != key);
    if cached.len() >= MAX_CHAT_RESOLUTIONS {
        cached.remove(0);
    }
    cached.push((key, now, resolution.clone()));
    Ok(resolution)
}

/// `validated_custom_addrs` for a chat request, reused across the rounds of a
/// turn (see `CHAT_RESOLUTION_TTL`). Saving or probing an endpoint in Settings
/// resolves it afresh through `validated_custom_addrs`.
pub fn validated_custom_addrs_for_chat(
    base_url: &str,
    allow_loopback: bool,
) -> Result<Resolution, String> {
    cached_chat_resolution(
        (base_url.to_string(), allow_loopback),
        std::time::Instant::now(),
        || validated_custom_addrs(base_url, allow_loopback),
    )
}

/// Validate a user-supplied OpenAI-compatible endpoint.
pub fn validate_custom_base_url(base_url: &str, allow_loopback: bool) -> Result<(), String> {
    validated_custom_addrs(base_url, allow_loopback).map(|_| ())
}

/// Validate a catalog provider endpoint before sending its stored key.
///
/// This is the SINGLE validation for ALL catalog providers: it checks the scheme
/// and host (no credentials, no odd schemes), caps the resolved host at the
/// allowlist, and — crucially — rejects a base URL whose HOST is not the catalog
/// host for `provider`. Result: provider A's key can never be sent to provider
/// B's host. Exact host equality (not a suffix match) is what stops
/// `api.deepseek.com.evil.test` from passing.
pub fn validate_base_url(provider: &str, base_url: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(base_url).map_err(|_| format!("Invalid base URL: {base_url}"))?;
    let host = validate_scheme_and_host(&url)?;
    if !ALLOWED_API_HOSTS.contains(&host.as_str()) && !is_loopback(&host) {
        return Err(format!(
            "Base URL host \"{host}\" is not an allowed provider endpoint"
        ));
    }
    let canonical = catalog_base_url(provider).ok_or("Unknown provider")?;
    let expected = reqwest::Url::parse(canonical)
        .map_err(|_| "Invalid catalog base URL".to_string())?
        .host_str()
        .unwrap_or("")
        .to_ascii_lowercase();
    if host != expected {
        return Err("Base URL does not match provider".into());
    }
    Ok(())
}

/// `test_connection` reply when the tool request told nothing about tool
/// support. The frontend stores only a boolean `tools`, so this one is retried
/// later instead of being recorded.
pub const PROBE_INCONCLUSIVE: &str = r#"{"status":"ok","tools":null}"#;

/// Whether a tool-probe response status says nothing about tool support: the
/// gateway was rate limiting, timing out or failing. Recording `tools:false`
/// for these demoted a tool-capable model to text-only for good, since a
/// measured model is never probed again.
pub fn probe_status_is_inconclusive(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

/// Fetch model metadata from an OpenAI-compatible endpoint.
pub async fn fetch_models(
    client: &reqwest::Client,
    provider: &str,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let mut request = client
        .get(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("User-Agent", AI_USER_AGENT);
    if provider == SESSION_PROVIDER_ID {
        request = request.header("x-opencode-session", session_id());
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Models request failed: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Models read failed: {error}"))?;
    if !status.is_success() {
        return Err(format!("Models endpoint returned {status}"));
    }
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| "Invalid models response".to_string())?;
    let entries: Vec<&serde_json::Value> = value
        .get("data")
        .and_then(serde_json::Value::as_array)
        .map(|items| items.iter().collect())
        .or_else(|| value.as_array().map(|items| items.iter().collect()))
        .unwrap_or_default();
    Ok(entries
        .into_iter()
        .filter_map(|model| {
            let id = model.get("id")?.as_str()?.to_string();
            let name = model
                .get("name")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| id.clone());
            Some(serde_json::json!({ "id": id, "name": name }))
        })
        .collect())
}

#[cfg(test)]
mod tests {

    fn resolution(port: u16) -> Resolution {
        (
            "llm.example.test".into(),
            vec![std::net::SocketAddr::from(([203, 0, 113, 7], port))],
        )
    }

    #[test]
    fn chat_resolution_is_reused_within_its_window_and_refreshed_after() {
        let key = ("https://reuse.example.test/v1".to_string(), false);
        let start = std::time::Instant::now();
        let mut lookups = 0;
        let mut lookup = |port| {
            lookups += 1;
            Ok(resolution(port))
        };
        assert_eq!(
            cached_chat_resolution(key.clone(), start, || lookup(1)).unwrap(),
            resolution(1)
        );
        let inside = start + CHAT_RESOLUTION_TTL - std::time::Duration::from_secs(1);
        assert_eq!(
            cached_chat_resolution(key.clone(), inside, || lookup(2)).unwrap(),
            resolution(1)
        );
        let after = start + CHAT_RESOLUTION_TTL;
        assert_eq!(
            cached_chat_resolution(key, after, || lookup(2)).unwrap(),
            resolution(2)
        );
        assert_eq!(lookups, 2);
    }

    #[test]
    fn a_refused_chat_resolution_is_not_cached() {
        let key = ("https://refused.example.test/v1".to_string(), false);
        let now = std::time::Instant::now();
        assert!(
            cached_chat_resolution(key.clone(), now, || Err("internal address".into())).is_err()
        );
        assert_eq!(
            cached_chat_resolution(key, now, || Ok(resolution(3))).unwrap(),
            resolution(3)
        );
    }

    #[test]
    fn loopback_permission_is_part_of_the_chat_resolution_key() {
        // Desktop allows loopback, the server never does: an answer validated
        // under one rule must not be replayed under the other.
        let url = "https://rule.example.test/v1".to_string();
        let now = std::time::Instant::now();
        cached_chat_resolution((url.clone(), true), now, || Ok(resolution(4))).unwrap();
        assert!(cached_chat_resolution((url, false), now, || Err("refused".into())).is_err());
    }
    use super::*;

    #[test]
    fn only_rate_limits_and_outages_make_a_tool_probe_inconclusive() {
        use reqwest::StatusCode;
        for status in [StatusCode::TOO_MANY_REQUESTS, StatusCode::REQUEST_TIMEOUT, StatusCode::BAD_GATEWAY, StatusCode::SERVICE_UNAVAILABLE] {
            assert!(probe_status_is_inconclusive(status), "{status}");
        }
        // A gateway that rejects the tool payload has answered: no tool support.
        for status in [StatusCode::BAD_REQUEST, StatusCode::UNPROCESSABLE_ENTITY, StatusCode::NOT_FOUND] {
            assert!(!probe_status_is_inconclusive(status), "{status}");
        }
    }

    #[test]
    fn agent_new_constructs_struct() {
        let agent = Agent::new(
            "test-provider",
            "test-model",
            "sk-test-key",
            "https://test.com/v1",
        );
        assert_eq!(agent.provider, "test-provider");
        assert_eq!(agent.model, "test-model");
        assert_eq!(agent.api_key, "sk-test-key");
        assert_eq!(agent.base_url, "https://test.com/v1");
    }

    #[test]
    fn validate_base_url_allows_catalog_providers() {
        assert!(validate_base_url("deepseek", "https://api.deepseek.com/v1").is_ok());
        assert!(validate_base_url("opencode-go", "https://opencode.ai/zen/go/v1").is_ok());
    }

    #[test]
    fn validate_base_url_still_binds_a_loopback_host_to_the_provider() {
        // Loopback is allowlisted, but a catalog provider has no loopback catalog
        // host, so setting one must FAIL rather than silently send the key there.
        assert!(validate_base_url("deepseek", "http://localhost:11434/v1").is_err());
        assert!(validate_base_url("deepseek", "http://127.0.0.1:8080/v1").is_err());
        // A user-hosted endpoint belongs on the Custom provider, which accepts any
        // public/loopback host through `validate_custom_base_url`.
        assert!(validate_custom_base_url("http://localhost:11434/v1", true).is_ok());
    }

    #[test]
    fn validate_base_url_binds_key_to_catalog_host() {
        assert!(validate_base_url("deepseek", "https://api.deepseek.com/v1").is_ok());
        assert!(validate_base_url("opencode-go", "https://opencode.ai/zen/go/v1").is_ok());
        assert!(validate_base_url("deepseek", "https://opencode.ai/zen/go/v1").is_err());
        assert!(validate_base_url("unknown", "https://api.deepseek.com/v1").is_err());
    }

    #[test]
    fn validate_base_url_binds_host_exactly_not_by_suffix() {
        // A suffix match would accept `api.deepseek.com.evil.test`; exact host
        // equality is what keeps the key on the provider's own host.
        assert!(validate_base_url("deepseek", "https://api.deepseek.com.evil.test/v1").is_err());
    }

    #[test]
    fn validate_base_url_rejects_ssrf_and_exfiltration() {
        assert!(validate_base_url("deepseek", "http://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_base_url("deepseek", "https://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_base_url("deepseek", "http://10.0.0.1/v1").is_err());
        assert!(validate_base_url("deepseek", "https://evil.example.com/v1").is_err());
        assert!(validate_base_url("deepseek", "ftp://x/v1").is_err());
        assert!(validate_base_url("deepseek", "not-a-url").is_err());
    }

    #[test]
    fn validate_custom_base_url_respects_desktop_and_web_loopback_policy() {
        assert!(validate_custom_base_url("http://localhost:11434/v1", true).is_ok());
        assert!(validate_custom_base_url("https://api.openai.com/v1", true).is_ok());
        assert!(validate_custom_base_url("http://localhost:11434/v1", false).is_err());
        assert!(validate_custom_base_url("http://127.0.0.1:8080/v1", false).is_err());
    }

    #[test]
    fn validate_custom_base_url_blocks_ssrf_classes() {
        assert!(validate_custom_base_url("http://llm-proxy.example.com/v1", true).is_err());
        assert!(
            validate_custom_base_url("https://169.254.169.254/latest/meta-data", true).is_err()
        );
        assert!(validate_custom_base_url("https://10.0.0.5/v1", true).is_err());
        assert!(validate_custom_base_url("https://user:pass@proxy.example.com/v1", true).is_err());
        assert!(validate_custom_base_url("ftp://proxy.example.com/v1", true).is_err());
        assert!(validate_custom_base_url("https://never-resolves.invalid/v1", true).is_err());
    }
}
