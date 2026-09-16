use super::{prompt, tool_schema};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct AiRequest {
    pub model: String,
    pub api_key: String,
    pub base_url: String,
    pub messages: Value,
    pub tools: Option<Value>,
    pub document_state: Option<Value>,
}

impl AiRequest {
    pub fn body(&self) -> Value {
        let mut messages = self.messages.clone();
        if let Some(document_state) = &self.document_state {
            if let Some(messages) = messages.as_array_mut() {
                prompt::attach_document_state(messages, document_state.clone());
            }
        }
        let messages = messages
            .as_array()
            .map(|messages| prompt::assemble_messages(messages))
            .unwrap_or_default();
        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "stream": true,
        });
        if let Some(tools) = &self.tools {
            if tools.as_array().is_some_and(|items| !items.is_empty()) {
                body["tools"] = json!([tool_schema::openai_document_operation_tool()]);
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
        let document_state = messages.as_array().and_then(|items| {
            items.iter().rev().find_map(|message| {
                (message.get("role").and_then(Value::as_str) == Some("user"))
                    .then(|| message.get("metadata")?.get(prompt::DOCUMENT_STATE_FIELD))
                    .flatten()
                    .cloned()
            })
        });
        Ok(Self {
            model: model.into(),
            api_key: api_key.into(),
            base_url: base_url.into(),
            messages,
            tools,
            document_state,
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
    fn extracts_document_state_and_keeps_it_out_of_system_policy() {
        let request = AiRequest::from_json(
            "model",
            "key",
            "https://example.test/v1",
            r#"[{"role":"user","content":"hi","metadata":{"documentState":{"selection":false,"isEmptyDocument":false,"blocks":[{"id":"b$"}]}}}]"#,
            None,
        )
        .unwrap();
        let body = request.body();
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages[0]["role"], "system");
        assert!(messages[0]["content"]
            .as_str()
            .unwrap()
            .contains("applyDocumentOperations"));
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[2]["role"], "user");
        assert_eq!(
            messages[2]["metadata"]["documentState"]["blocks"][0]["id"],
            "b$"
        );
    }
}
