//! Shared pure-Rust engine for DocuBook.
//!
//! One home for the modules that both runtimes need — the desktop app
//! (`src-tauri`) and the web server (`server`). Previously these files lived in
//! `src-tauri` and the server pulled them in through `#[path = "../src-tauri/…"]`
//! includes; as a real crate neither runtime reaches into the other's tree, and
//! rust-analyzer resolves every module without the symlink workaround.
//!
//! Nothing here depends on Tauri or axum: these modules only touch the
//! filesystem, git, Markdown rendering and the AI HTTP layer.

pub mod agent;
pub mod git;
pub mod markdown;
#[path = "rust-ai/mod.rs"]
pub mod rust_ai;
pub mod search;
pub mod vault;
pub mod wiki;
