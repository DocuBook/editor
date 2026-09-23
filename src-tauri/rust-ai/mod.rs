//! Framework-neutral AI transport shared by desktop Tauri and web Axum.
//!
//! Consumer adapters own credentials, endpoint policy, rate limits, cancellation
//! state, and presentation. This module owns request assembly, SSE decoding,
//! provider-safe errors, limits, and stable AI events.

pub mod error;
pub mod events;
pub mod prompt;
pub mod provider;
pub mod request;
pub mod requests;
pub mod sse;
pub mod tool_schema;
