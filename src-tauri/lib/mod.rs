//! Tauri command layer — one module per responsibility.
//! Each module holds its commands, private helpers, and unit tests
//! (`#[cfg(test)] mod tests` at the bottom of the file).

pub(crate) mod agent;   // LLM: API keys, model discovery, test_connection, ask_ai/cancel_ai + SSE parse
pub(crate) mod app;     // lifecycle: app_ready_to_close, health
pub(crate) mod git;     // git: clone/init/settings/remote/identity/stage/push/status
pub(crate) mod markdown;// preview & safe-HTML rendering commands
pub(crate) mod search;  // vault file search
pub(crate) mod vault;   // vault lifecycle + file operations
pub(crate) mod wiki;    // wikilink suggest/backlinks/resolve
