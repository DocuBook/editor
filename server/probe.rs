// Tool-call probe + runtime model discovery (isolated).
use super::*;

pub(crate) fn custom_env_config() -> Option<(String, Option<String>, Option<String>)> {
    custom_config_from(&|k| std::env::var(k).ok().filter(|s| !s.is_empty()))
}

/** Pure variant (env-getter injectable) so the resolution logic is testable. */
pub(crate) fn custom_config_from(
    env_get: &dyn Fn(&str) -> Option<String>,
) -> Option<(String, Option<String>, Option<String>)> {
    let base = env_get("DB_OPENAI_COMPAT_BASE_URL")?;
    Some((
        base,
        env_get("DB_OPENAI_COMPAT_API_KEY"),
        env_get("DB_OPENAI_COMPAT_MODEL"),
    ))
}

pub(crate) fn custom_env_base_url() -> Option<String> {
    std::env::var("DB_OPENAI_COMPAT_BASE_URL")
        .ok()
        .filter(|s| !s.is_empty())
}

/** Mirrors lib.rs ask_ai + test_connection — streams SSE events to the browser. */
/** Runtime model discovery — GET {baseUrl}/models with the stored key (data dir),
 *  so the frontend never holds API keys. SSRF-guarded + no redirects. */
pub(crate) async fn list_models(state: &AppState, provider: &str, base_url: &str) -> Result<String, String> {
    if base_url.is_empty() {
        return Err("Base URL is required".into());
    }
    agent::validate_base_url(base_url)?;
    let api_key =
        keys::get_key(&state.data_dir, provider).map_err(|_| "No API key found".to_string())?;
    let client = reqwest::Client::builder()
        // SSRF: never follow redirects — the validated host is the ONLY target the key may reach.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Client error: {}", e))?;
    let models = agent::fetch_models(&client, base_url, &api_key).await?;
    serde_json::to_string(&models).map_err(|e| e.to_string())
}

pub(crate) async fn test_connection(
    state: &AppState,
    provider: &str,
    model: &str,
    base_url: &str,
    api_key: &str,
) -> Result<String, String> {
    // Env override: a custom endpoint controlled by the environment probes the
    // env values, not whatever the (read-only) UI happens to hold.
    let (base_url, api_key) = if provider == agent::CUSTOM_PROVIDER_ID {
        match custom_env_config() {
            Some((eb, ek, _)) => (eb, ek.unwrap_or_else(|| api_key.to_string())),
            None => (base_url.to_string(), api_key.to_string()),
        }
    } else {
        (base_url.to_string(), api_key.to_string())
    };
    // Fall back to the stored key/base URL (data dir) so auto-probe works
    // without re-entering the key in the UI — mirrors ask_ai.
    let api_key = if api_key.is_empty() {
        keys::get_key(&state.data_dir, provider).map_err(|_| "No API key found".to_string())?
    } else {
        api_key
    };
    let base_url = if base_url.is_empty() && provider == agent::CUSTOM_PROVIDER_ID {
        keys::get_base_url(&state.data_dir, provider)
            .map_err(|_| "No custom base URL saved".to_string())?
    } else {
        base_url
    };
    // Custom endpoints skip the allowlist (any public https host) but still pass
    // the generic sanitize; catalog providers stay strictly allowlisted.
    if provider == agent::CUSTOM_PROVIDER_ID {
        agent::validate_custom_base_url(&base_url, false)?;
    } else {
        agent::validate_base_url(&base_url)?;
    }
    let client = reqwest::Client::builder()
        // SSRF: never follow redirects — the validated host is the ONLY target the key may reach.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Client error: {}", e))?;
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let basic_body = json!({ "model": model, "messages": [{ "role": "user", "content": "say ok" }], "max_tokens": 8 });
    let res = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&basic_body)
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    if !res.status().is_success() {
        return Err(format!(
            "API error ({}): {}",
            res.status(),
            res.text().await.unwrap_or_default()
        ));
    }

    // Tool probe mirrors the real applyDocumentOperations payload shape
    // ($defs/$ref, anyOf, additionalProperties:false) so it measures whether
    // OUR payload passes this gateway, not just generic tool support.
    let mut tool_body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": "call the test_tool" }],
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
    let tool_req = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key));
    let tool_res = tool_req
        .json(&tool_body)
        .send()
        .await
        .map_err(|e| format!("Tool test failed: {}", e))?;
    if !tool_res.status().is_success() {
        // Some gateways REJECT forced tool_choice:"required" (HTTP 400) yet still
        // support tool calls in "auto" mode (e.g. opencode.ai, DeepSeek thinking).
        // Retry once with "auto" before concluding tools:false.
        tool_body["tool_choice"] = json!("auto");
        let auto = client.post(&url).header("Authorization", format!("Bearer {}", api_key)).json(&tool_body).send().await;
        if let Ok(r2) = auto {
            if r2.status().is_success() {
                let t2 = r2.text().await.map_err(|e| e.to_string())?;
                if t2.contains("tool_calls") || t2.contains("test_tool") {
                    return Ok(r#"{"status":"ok","tools":true}"#.to_string());
                }
            }
        }
        return Ok(r#"{"status":"ok","tools":false}"#.to_string());
    }
    let text = tool_res.text().await.map_err(|e| e.to_string())?;
    let supports_tools = text.contains("tool_calls") || text.contains("test_tool");
    Ok(format!(r#"{{"status":"ok","tools":{}}}"#, supports_tools))
}
