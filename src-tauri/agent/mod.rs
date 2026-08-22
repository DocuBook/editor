use std::net::ToSocketAddrs;

/// AI agent configuration for API calls.
pub struct Agent {
    /* used in UI to label which provider served the response */
    pub provider: String,
    pub model: String,
    pub api_key: String,
    pub base_url: String,
}

impl Agent {
    /** Create a new AI agent with explicit config. */
    pub fn new(provider: &str, model: &str, api_key: &str, base_url: &str) -> Self {
        Self {
            provider: provider.to_string(),
            model: model.to_string(),
            api_key: api_key.to_string(),
            base_url: base_url.to_string(),
        }
    }
}

/** Hosts allowed as AI API base URLs — mirrors the models.dev provider catalog
 *  (src/data/providers.ts `api` field, auto-extracted). Loopback hosts
 *  (localhost/127.0.0.1/::1) are accepted for local LLM servers. */
pub const ALLOWED_API_HOSTS: &[&str] = &[
    // Loopback — local OpenAI-compatible gateways.
    "127.0.0.1",
    "localhost",
    "opencode.ai",
    // First-party endpoints only — mirrors the frontend catalog
    // (frontend/data/providers.ts); every host is a verified provider on

    // provider (validate_custom_base_url skips this list).
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    "api.deepseek.com",
];

/** True if the host is a loopback address (localhost, 127.0.0.1, ::1). */
fn is_loopback(host: &str) -> bool {
    host == "localhost"
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

/** Synthetic provider id for user-configured OpenAI-compatible endpoints.
 *  Shared with the frontend (SettingsModal) — custom base URL + model + key are
 *  bound server-side instead of coming from the generated provider catalog. */
pub const CUSTOM_PROVIDER_ID: &str = "openai-compatible";

/** Request-local tool ID for frontend protocol events; provider IDs stay backend-only. */
pub fn local_tool_call_id(index: usize) -> String {
    format!("tool-{index}")
}

/** Scheme + host sanitization shared by both validators. Returns the lowercased host. */
fn validate_scheme_and_host(url: &reqwest::Url) -> Result<String, String> {
    let host = url.host_str().unwrap_or("").to_lowercase();
    if !url.username().is_empty() {
        return Err("Base URL must not contain credentials (user:pass@)".into());
    }
    match url.scheme() {
        "https" => {}
        "http" => {
            if !is_loopback(&host) {
                return Err("HTTP base URLs are only allowed for local (localhost) servers".into());
            }
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

/** Validate a user-supplied OpenAI-compatible base URL (custom provider).
 *  Any public https host is allowed — the allowlist does not apply, that is the
 *  point of custom endpoints — but SSRF classes are still blocked: private/
 *  link-local/reserved IP literals, credentials in the URL, non-http(s)
 *  schemes, and http to non-loopback.
 *
 *  `allow_loopback` — true on the desktop build (local LLM servers on the
 *  user's own machine, e.g. Ollama/LM Studio); false on the web build where
 *  loopback is the SERVER's own machine and must not be reachable by users.
 *
 *  Hostnames are DNS-resolved here and rejected when they point at internal
 *  addresses — closes the hostname-resolves-to-private-IP SSRF class.
 *  Unresolvable hosts fail closed. The key is bound to this URL server-side
 *  (keychain/keys `{provider}:base_url`), so a webview-provided URL can never
 *  redirect the stored key elsewhere. */
pub fn validate_custom_base_url(base_url: &str, allow_loopback: bool) -> Result<(), String> {
    validated_custom_addrs(base_url, allow_loopback).map(|_| ())
}

/** Validate and resolve a custom endpoint once. Server callers pin reqwest to
 *  these addresses so DNS cannot change between validation and connection. */
pub fn validated_custom_addrs(
    base_url: &str,
    allow_loopback: bool,
) -> Result<(String, Vec<std::net::SocketAddr>), String> {
    let url =
        reqwest::Url::parse(base_url).map_err(|_| format!("Invalid base URL: {}", base_url))?;
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
            .map_err(|_| format!("Could not resolve host \"{}\" — DNS lookup failed", host))?
            .collect()
    };
    if addrs.is_empty() {
        return Err(format!("Could not resolve host \"{}\"", host));
    }
    for a in &addrs {
        let ip = a.ip();
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
                "Host \"{}\" resolves to an internal address ({}) — not allowed",
                host, ip
            ));
        }
    }
    Ok((host, addrs))
}

/** Fetch the model list from an OpenAI-compatible endpoint (GET /models).
 *  Used for runtime model discovery — the frontend catalog carries NO model list.
 *  Caller must pass a client WITHOUT redirects (SSRF) and a resolved API key. */
pub async fn fetch_models(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let res = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("Models request failed: {}", e))?;
    let status = res.status();
    let body = res
        .text()
        .await
        .map_err(|e| format!("Models read failed: {}", e))?;
    if !status.is_success() {
        return Err(format!("Models endpoint returned {}", status));
    }
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| "Invalid models response".to_string())?;
    // Tolerate the two common OpenAI-compatible /models shapes:
    // { "data": [...] } or a bare array. Returns (id, name).
    let entries: Vec<&serde_json::Value> = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|a| a.iter().collect())
        .or_else(|| v.as_array().map(|a| a.iter().collect()))
        .unwrap_or_default();
    Ok(entries
        .into_iter()
        .filter_map(|m| {
            let id = if let Some(s) = m.get("id").and_then(|x| x.as_str()) {
                s.to_string()
            } else {
                return None;
            };
            let name = m
                .get("name")
                .and_then(|n| n.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| id.clone());
            Some(serde_json::json!({ "id": id, "name": name }))
        })
        .collect())
}

/** Validate a base URL for the AI transport — SSRF / API-key exfiltration guard.\n *  Rules: scheme must be https (or http to loopback only); host must be in\n *  ALLOWED_API_HOSTS (provider catalog) or loopback; IP literals in\n *  private/link-local/reserved ranges are rejected. */
pub fn validate_base_url(base_url: &str) -> Result<(), String> {
    let url =
        reqwest::Url::parse(base_url).map_err(|_| format!("Invalid base URL: {}", base_url))?;
    let host = validate_scheme_and_host(&url)?;
    if !ALLOWED_API_HOSTS.contains(&host.as_str()) && !is_loopback(&host) {
        return Err(format!(
            "Base URL host \"{}\" is not an allowed provider endpoint",
            host
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_tool_call_ids_are_stable_and_distinct() {
        assert_eq!(local_tool_call_id(0), "tool-0");
        assert_ne!(local_tool_call_id(0), local_tool_call_id(1));
    }

    #[test]
    fn agent_new_constructs_struct() {
        let a = Agent::new(
            "test-provider",
            "test-model",
            "sk-test-key",
            "https://test.com/v1",
        );
        assert_eq!(a.provider, "test-provider");
        assert_eq!(a.model, "test-model");
        assert_eq!(a.api_key, "sk-test-key");
        assert_eq!(a.base_url, "https://test.com/v1");
    }

    #[test]
    fn agent_supports_all_providers() {
        for (provider, model) in [
            ("openai", "gpt-4o"),
            ("anthropic", "claude-sonnet-4-20250514"),
            ("google", "gemini-2.0-flash"),
            ("groq", "llama-3.3-70b-versatile"),
        ] {
            let cfg = Agent::new(provider, model, "key", "");
            assert_eq!(cfg.provider, provider);
            assert_eq!(cfg.model, model);
            assert_eq!(cfg.api_key, "key");
        }
    }

    #[test]
    fn validate_base_url_allows_providers_and_loopback() {
        assert!(validate_base_url("https://api.anthropic.com/v1").is_ok());
        assert!(validate_base_url("https://api.deepseek.com/v1").is_ok());
        assert!(validate_base_url("https://api.deepseek.com/v1").is_ok());
        assert!(validate_base_url("http://localhost:11434/v1").is_ok());
        assert!(validate_base_url("http://127.0.0.1:8080/v1").is_ok());
    }

    #[test]
    fn validate_base_url_rejects_ssrf_and_exfil() {
        // metadata / internal IPs
        assert!(validate_base_url("http://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_base_url("https://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_base_url("http://10.0.0.1/v1").is_err());
        assert!(validate_base_url("http://192.168.1.1/v1").is_err());
        // arbitrary hosts (exfiltration target)
        assert!(validate_base_url("https://evil.example.com/v1").is_err());
        assert!(validate_base_url("http://evil.example.com/v1").is_err());
        // bad schemes / malformed
        assert!(validate_base_url("ftp://x/v1").is_err());
        assert!(validate_base_url("not-a-url").is_err());
    }

    #[test]
    fn validate_custom_base_url_allows_public_https_and_loopback() {
        // local LLM servers (desktop only) — loopback resolves offline-safe
        assert!(validate_custom_base_url("http://localhost:11434/v1", true).is_ok());
        assert!(validate_custom_base_url("http://127.0.0.1:8080/v1", true).is_ok());
        assert!(validate_custom_base_url("https://localhost/v1", true).is_ok());
        // any public https host is the point of the custom provider
        assert!(validate_custom_base_url("https://api.openai.com/v1", true).is_ok());
    }

    #[test]
    fn validate_custom_base_url_blocks_loopback_on_web() {
        // on the web build loopback is the SERVER's own machine — never allowed
        assert!(validate_custom_base_url("http://localhost:11434/v1", false).is_err());
        assert!(validate_custom_base_url("http://127.0.0.1:8080/v1", false).is_err());
        assert!(validate_custom_base_url("https://localhost/v1", false).is_err());
    }

    #[test]
    fn validate_custom_base_url_blocks_ssrf_classes() {
        // http to non-loopback (cleartext key transport)
        assert!(validate_custom_base_url("http://llm-proxy.example.com/v1", true).is_err());
        // metadata / internal IPs
        assert!(validate_custom_base_url("http://169.254.169.254/latest/meta-data", true).is_err());
        assert!(
            validate_custom_base_url("https://169.254.169.254/latest/meta-data", true).is_err()
        );
        assert!(validate_custom_base_url("https://10.0.0.5/v1", true).is_err());
        assert!(validate_custom_base_url("https://192.168.1.10/v1", true).is_err());
        // credentials in the URL
        assert!(validate_custom_base_url("https://user:pass@proxy.example.com/v1", true).is_err());
        // bad schemes / malformed
        assert!(validate_custom_base_url("ftp://proxy.example.com/v1", true).is_err());
        assert!(validate_custom_base_url("not-a-url", true).is_err());
        // unresolvable hostname fails closed (RFC 2606 .invalid never resolves)
        assert!(validate_custom_base_url("https://never-resolves.invalid/v1", true).is_err());
    }
}
