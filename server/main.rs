//! DocuBook web server — the same codebase, served over HTTP.
//!
//! Reuses the pure-Rust modules from the desktop app (vault, wiki, git,
//! search, agent) via `#[path]` includes — zero logic duplication. Exposes
//! the same command surface as the Tauri IPC (`POST /api/<cmd>`), streams AI
//! over SSE, and serves the built frontend (`dist/`) with SPA fallback.
//!
//! Run: `WWW_DIR=dist DATA_DIR=./data cargo run --release` (after `npm run build`).
//! Docker: see ../Dockerfile (multi-stage, single binary, non-root).
#[path = "../src-tauri/agent/mod.rs"]
mod agent;
mod ai;
mod auth;
mod auth_routes;
mod cmds;
mod config;
#[path = "../src-tauri/git/mod.rs"]
mod git;
mod handlers;
mod httpm;
mod keys;
#[path = "../src-tauri/markdown.rs"]
mod markdown;
mod probe;
#[path = "../src-tauri/search/mod.rs"]
mod search;
#[path = "../src-tauri/vault/mod.rs"]
mod vault;
#[path = "../src-tauri/wiki/mod.rs"]
mod wiki;

use config::AuthState;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::Request;
use axum::extract::{ConnectInfo, Path as AxPath, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio_stream::wrappers::ReceiverStream;
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
struct AppState {
    vault: Arc<Mutex<Option<vault::Vault>>>,
    wiki: Arc<Mutex<Option<wiki::WikiIndex>>>,
    git: Arc<Mutex<Option<git::Git>>>,
    ai_cancel: Arc<AtomicBool>,
    auth: Arc<AuthState>,
    data_dir: PathBuf,
}

/** Cap runaway AI responses (memory-exhaustion guard) — mirrors lib.rs. */
const MAX_AI_BUFFER: usize = 8 * 1024 * 1024;
/** Total AI generation budget per attempt (seconds) — a pure backstop.
 *  Failure detection is the PI pattern: 30s first-chunk + 120s per-chunk stall
 *  timeout kill hung streams fast, and the user can always Abort (cancel_ai).
 *  A model that streams slowly but steadily (weak/thinking models) is allowed
 *  to finish; this cap only guards against a runaway generation. */
const AI_MAX_SECONDS: u64 = 900;
fn main() {
    let data_dir = std::env::var("DATA_DIR").unwrap_or_else(|_| "./data".into());
    let www_dir = std::env::var("WWW_DIR").unwrap_or_else(|_| "./dist".into());
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    std::fs::create_dir_all(&data_dir).expect("data dir");

    // Diagnose a root-owned /data volume at boot (EACCES would otherwise only
    // surface as a confusing error at admin creation). Probe + clean up.
    let probe = std::path::Path::new(&data_dir).join(".write-probe");
    let writable = std::fs::write(&probe, b"")
        .map(|_| {
            let _ = std::fs::remove_file(&probe);
            true
        })
        .unwrap_or(false);
    if !writable {
        eprintln!("[docubook] {data_dir} is NOT writable — /data volume ownership problem.");
        eprintln!(
            "[docubook] fix: docker run --rm -v <volume>:/data alpine chown -R 1000:1000 /data"
        );
    }

    let state = AppState {
        vault: Arc::new(Mutex::new(None)),
        wiki: Arc::new(Mutex::new(None)),
        git: Arc::new(Mutex::new(None)),
        ai_cancel: Arc::new(AtomicBool::new(false)),
        auth: Arc::new(AuthState::new(Path::new(&data_dir))),
        data_dir: data_dir.clone().into(),
    };

    let app = build_router(state, PathBuf::from(&www_dir));

    let addr = format!("[::]:{port}");
    println!("[docubook] listening on http://{addr} (data={data_dir} www={www_dir})");
    let rt = tokio::runtime::Runtime::new().expect("tokio");
    rt.block_on(async {
        // Dual-stack ([::]): IPv4 + IPv6. Health checks (Coolify/Docker) probe
        // `localhost`, which resolves to ::1 inside containers — an IPv4-only
        // 0.0.0.0 bind makes them get "connection refused". Fall back to IPv4
        // only if the host has no IPv6 stack.
        let listener = match tokio::net::TcpListener::bind(&addr).await {
            Ok(l) => l,
            Err(_) => tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
                .await
                .expect("bind"),
        };
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .expect("serve");
    });
}

/** Router factory — main() builds via env; tests build with a temp data dir.
 *  Extracted so the HTTP surface (routes, middleware, auth gate, fallback) is
 *  integration-testable via tower::ServiceExt::oneshot. */
fn build_router(state: AppState, www_dir: PathBuf) -> Router {
    let index = www_dir.join("index.html");
    Router::new()
        .route("/api/health", get(httpm::health_route))
        .route("/api/file", get(httpm::file_route))
        .route("/api/ask_ai", post(ai::ask_ai))
        .route("/api/login", post(auth_routes::login))
        .route("/api/logout", post(auth_routes::logout))
        .route("/api/setup_admin", post(auth_routes::setup_admin))
        .route("/api/{cmd}", post(handlers::api))
        .layer(axum::extract::DefaultBodyLimit::max(8 * 1024 * 1024))
        .layer(middleware::from_fn(httpm::security_headers))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            httpm::auth_mw,
        ))
        // axum 0.8: .layer() does NOT wrap fallback_service — wrap the static
        // service explicitly so security headers apply to / and /assets too.
        .fallback_service(
            tower::ServiceBuilder::new()
                .layer(middleware::from_fn(httpm::security_headers))
                .service(ServeDir::new(&www_dir).fallback(ServeFile::new(index))),
        )
        .with_state(state)
}

/** Shared command dispatcher — same surface as tauri's generate_handler. */
fn err_response(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

#[cfg(test)]
mod tests;
