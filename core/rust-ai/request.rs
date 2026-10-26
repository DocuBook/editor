use super::tool_schema;
use serde_json::{json, Value};

/// One chat request to an OpenAI-compatible provider.
///
/// The messages are forwarded verbatim: the frontend compiles the whole
/// prompt (system policy, grounding rules, document state, reference data)
/// in one place (`frontend/utils/aiPrompt.ts`, `aiGrounding.ts`), so the
/// backend adds no policy of its own that could drift from it.
#[derive(Debug, Clone)]
pub struct AiRequest {
    pub model: String,
    pub api_key: String,
    pub base_url: String,
    pub messages: Value,
    pub tools: Option<Value>,
}

impl AiRequest {
    pub fn body(&self) -> Value {
        let messages = self.messages.as_array().cloned().unwrap_or_default();
        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "stream": true,
        });
        if let Some(tools) = &self.tools {
            if let Some(items) = tools.as_array().filter(|items| !items.is_empty()) {
                let mut definitions = vec![tool_schema::openai_document_operation_tool()];
                definitions.extend(
                    items
                        .iter()
                        .filter(|tool| {
                            tool["type"] == "function"
                                && tool["function"]["name"].as_str().is_some_and(|name| {
                                    name != tool_schema::DOCUMENT_OPERATION_TOOL
                                })
                                && tool["function"]["parameters"].is_object()
                        })
                        .cloned(),
                );
                body["tools"] = json!(definitions);
                debug_assert_eq!(
                    tool_schema::DOCUMENT_OPERATION_TOOL,
                    "applyDocumentOperations"
                );
                // Thinking-mode gateways reject tool_choice:"required". Auto
                // preserves tool-capable and text-capable provider behavior.
                body["tool_choice"] = json!("auto");
            }
        }
        body
    }

    pub fn url(&self) -> String {
        format!("{}/chat/completions", self.base_url.trim_end_matches('/'))
    }

    pub fn from_json(
        model: impl Into<String>,
        api_key: impl Into<String>,
        base_url: impl Into<String>,
        messages: &str,
        tools: Option<&str>,
    ) -> Result<Self, String> {
        let messages: Value =
            serde_json::from_str(messages).map_err(|_| "Invalid messages".to_string())?;
        // Older desktop/web adapters ignored malformed or non-array tools and
        // continued with text-only streaming. Keep that compatibility here.
        let tools = tools.and_then(|value| serde_json::from_str(value).ok());
        Ok(Self {
            model: model.into(),
            api_key: api_key.into(),
            base_url: base_url.into(),
            messages,
            tools,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::AiRequest;
    use serde_json::json;

    #[test]
    fn builds_streaming_openai_compatible_body() {
        let request = AiRequest::from_json(
            "model",
            "key",
            "https://example.test/v1",
            "[{\"role\":\"user\",\"content\":\"hi\"}]",
            Some("[{\"type\":\"function\"}]"),
        )
        .unwrap();
        assert_eq!(request.url(), "https://example.test/v1/chat/completions");
        assert_eq!(request.body()["stream"], true);
        assert_eq!(request.body()["tool_choice"], json!("auto"));
    }

    #[test]
    fn preserves_model_tool_call_and_result_messages() {
        let request = AiRequest::from_json(
            "model",
            "key",
            "https://example.test/v1",
            r#"[{"role":"assistant","content":null,"tool_calls":[{"id":"provider-call-1","type":"function","function":{"name":"lookup_context","arguments":"{\"query\":\"rates\"}"}}]},{"role":"tool","tool_call_id":"provider-call-1","content":"reference result"}]"#,
            None,
        )
        .unwrap();
        let messages = request.body()["messages"].as_array().unwrap().clone();
        let assistant = messages
            .iter()
            .find(|message| message["role"] == "assistant")
            .unwrap();
        let tool = messages
            .iter()
            .find(|message| message["role"] == "tool")
            .unwrap();
        assert_eq!(assistant["tool_calls"][0]["id"], "provider-call-1");
        assert_eq!(tool["tool_call_id"], "provider-call-1");
        assert_eq!(tool["content"], "reference result");
    }

    #[test]
    fn preserves_context_tool_schemas_alongside_canonical_document_tool() {
        let request = AiRequest::from_json(
            "model",
            "key",
            "https://example.test/v1",
            "[]",
            Some(r#"[{"type":"function","function":{"name":"lookup_context","description":"Look up context","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}}]"#),
        )
        .unwrap();
        let tools = request.body()["tools"].as_array().unwrap().clone();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["function"]["name"], "applyDocumentOperations");
        assert_eq!(tools[1]["function"]["name"], "lookup_context");
    }

    #[test]
    fn omits_invalid_tools_for_text_fallback() {
        let request = AiRequest::from_json(
            "model",
            "key",
            "https://example.test/v1",
            "[]",
            Some("not-json"),
        )
        .unwrap();
        assert!(request.body().get("tools").is_none());
        assert!(request.body().get("tool_choice").is_none());
    }

    #[test]
    fn omits_empty_tools() {
        let request =
            AiRequest::from_json("model", "key", "https://example.test/v1", "[]", Some("[]"))
                .unwrap();
        assert!(request.body().get("tools").is_none());
        assert!(request.body().get("tool_choice").is_none());
    }

    #[test]
    fn forwards_the_compiled_prompt_without_adding_policy() {
        // The frontend owns the prompt; a second policy added here would drift
        // from it (it did: this module used to inject its own system prompt
        // and document-state messages, which the frontend's always overrode).
        let request = AiRequest::from_json(
            "model",
            "key",
            "https://example.test/v1",
            r#"[{"role":"system","content":"policy"},{"role":"assistant","content":"state"},{"role":"user","content":"hi"}]"#,
            None,
        )
        .unwrap();
        let body = request.body();
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["content"], "policy");
        assert_eq!(messages[1]["content"], "state");
        assert_eq!(messages[2]["content"], "hi");
    }
}
