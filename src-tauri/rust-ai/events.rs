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
