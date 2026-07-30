
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
        Self { provider: provider.to_string(), model: model.to_string(), api_key: api_key.to_string(), base_url: base_url.to_string() }
    }

/** Create an agent from macOS Keychain. */
    pub fn from_env() -> Option<Self> {
        let keychain_key = |provider: &str| -> Option<String> {
            keyring::Entry::new("com.docubook.editor", provider).ok()?.get_password().ok()
        };
        if let Some(key) = keychain_key("openai") {
            return Some(Self::new("openai", "gpt-4o", &key, "https://api.openai.com/v1"));
        }
        if let Some(key) = keychain_key("anthropic") {
            return Some(Self::new("anthropic", "claude-sonnet-4-20250514", &key, "https://api.anthropic.com"));
        }
        if let Some(key) = keychain_key("google") {
            return Some(Self::new("google", "gemini-2.0-flash", &key, "https://generativelanguage.googleapis.com/v1beta"));
        }
        if let Some(key) = keychain_key("openrouter") {
            return Some(Self::new("openrouter", "openai/gpt-4o", &key, "https://openrouter.ai/api/v1"));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_new_constructs_struct() {
        let a = Agent::new("test-provider", "test-model", "sk-test-key", "https://test.com/v1");
        assert_eq!(a.provider, "test-provider");
        assert_eq!(a.model, "test-model");
        assert_eq!(a.api_key, "sk-test-key");
        assert_eq!(a.base_url, "https://test.com/v1");
    }

    #[test]
    fn from_env_returns_none_without_keys() {
        assert!(Agent::from_env().is_none());
    }

    #[test]
    fn agent_supports_all_providers() {
        for (provider, model) in [
            ("openai", "gpt-4o"),
            ("anthropic", "claude-sonnet-4-20250514"),
            ("google", "gemini-2.0-flash"),
            ("openrouter", "openai/gpt-4o"),
        ] {
            let cfg = Agent::new(provider, model, "key", "");
            assert_eq!(cfg.provider, provider);
            assert_eq!(cfg.model, model);
            assert_eq!(cfg.api_key, "key");
        }
    }
}
