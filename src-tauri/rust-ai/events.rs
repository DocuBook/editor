use serde_json::Value;

pub const TOKEN_EVENT: &str = "ai:token";
pub const TOOL_CALL_EVENT: &str = "ai:tool_call";
pub const TOOLS_DONE_EVENT: &str = "ai:tools_done";
pub const DONE_EVENT: &str = "ai:done";
#[allow(dead_code)]
pub const ERROR_EVENT: &str = "error";

pub const MAX_AI_BUFFER: usize = 8 * 1024 * 1024;
pub const MAX_TOOL_ARGS_SIZE: usize = 2 * 1024 * 1024;
pub const MAX_TOOL_CALLS_PER_REQUEST: usize = 64;
pub const AI_MAX_SECONDS: u64 = 900;

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub index: i64,
    pub provider_id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AiEvent {
    Token(String),
    ToolCall {
        tool_call_id: String,
        tool_name: String,
        input: Value,
    },
    ToolsDone,
    Done {
        provider: String,
        truncated: bool,
    },
}

impl AiEvent {
    /// Wire form for one event: the event name plus its JSON payload, tagged
    /// with the request that produced it. Desktop (`app.emit`) and web (SSE)
    /// both use this so a listener can drop events from a request it no longer
    /// owns instead of folding a stale stream into the current turn.
    pub fn to_wire(&self, request_id: &str) -> (&'static str, Value) {
        match self {
            AiEvent::Token(token) => (
                TOKEN_EVENT,
                serde_json::json!({ "requestId": request_id, "token": token }),
            ),
            AiEvent::ToolCall {
                tool_call_id,
                tool_name,
                input,
            } => (
                TOOL_CALL_EVENT,
                serde_json::json!({
                    "requestId": request_id,
                    "toolCallId": tool_call_id,
                    "toolName": tool_name,
                    "input": input,
                }),
            ),
            AiEvent::ToolsDone => (
                TOOLS_DONE_EVENT,
                serde_json::json!({ "requestId": request_id }),
            ),
            AiEvent::Done {
                provider,
                truncated,
            } => (
                DONE_EVENT,
                serde_json::json!({
                    "requestId": request_id,
                    "provider": provider,
                    "truncated": truncated,
                }),
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StreamSummary {
    pub provider: String,
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub truncated: bool,
}

pub fn local_tool_call_id(index: usize) -> String {
    format!("tool-{index}")
}

#[cfg(test)]
mod wire_tests {
    use super::*;

    #[test]
    fn every_event_carries_the_request_id() {
        // Request identity is the contract that lets the frontend ignore a
        // superseded stream; a payload without it silently reopens the bug.
        let events = [
            AiEvent::Token("hi".into()),
            AiEvent::ToolCall {
                tool_call_id: "call-1".into(),
                tool_name: "applyDocumentOperations".into(),
                input: serde_json::json!({ "operations": [] }),
            },
            AiEvent::ToolsDone,
            AiEvent::Done {
                provider: "deepseek".into(),
                truncated: false,
            },
        ];
        for event in &events {
            let (name, payload) = event.to_wire("req-1");
            assert!(!name.is_empty());
            assert_eq!(payload["requestId"], "req-1");
        }
    }

    #[test]
    fn token_payload_carries_both_id_and_text() {
        let (name, payload) = AiEvent::Token("café".into()).to_wire("req-2");
        assert_eq!(name, TOKEN_EVENT);
        assert_eq!(payload["token"], "café");
        assert_eq!(payload["requestId"], "req-2");
    }
}
