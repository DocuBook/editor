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
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio_stream::wrappers::ReceiverStream;
use tower_http::request_id::{
    MakeRequestId, PropagateRequestIdLayer, RequestId, SetRequestIdLayer,
};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing::{info, warn, Span};
use tracing_subscriber::EnvFilter;

const REQUEST_ID_HEADER: HeaderName = HeaderName::from_static("x-request-id");

#[derive(Clone)]
struct MakeRequestUuid;

impl MakeRequestId for MakeRequestUuid {
    fn make_request_id<B>(&mut self, request: &axum::http::Request<B>) -> Option<RequestId> {
        let valid_inbound = request
            .headers()
            .get(&REQUEST_ID_HEADER)
            .and_then(|value| value.to_str().ok())
            .filter(|value| is_uuid(value));
        let value = valid_inbound
            .map(str::to_owned)
            .unwrap_or_else(new_request_id);
        HeaderValue::from_str(&value).ok().map(RequestId::new)
    }
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

fn new_request_id() -> String {
    let mut bytes = [0_u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        return format!("fallback-{}", std::process::id());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

#[derive(Clone)]
struct AppState {
    vault: Arc<Mutex<Option<vault::Vault>>>,
    wiki: Arc<Mutex<Option<wiki::WikiIndex>>>,
    git: Arc<Mutex<Option<git::Git>>>,
    ai_cancel: Arc<AtomicBool>,
    ai_slots: Arc<tokio::sync::Semaphore>,
    auth: Arc<AuthState>,
    data_dir: PathBuf,
}

/** Cap runaway AI responses (memory-exhaustion guard) — mirrors lib.rs. */
const MAX_AI_BUFFER: usize = 8 * 1024 * 1024;
const MAX_TOOL_ARGS_SIZE: usize = 2 * 1024 * 1024;
const MAX_TOOL_CALLS_PER_REQUEST: usize = 64;
const MAX_CONCURRENT_AI_REQUESTS: usize = 1;
/** Total AI generation budget per attempt (seconds) — a pure backstop.
 *  Failure detection is the PI pattern: 30s first-chunk + 120s per-chunk stall
 *  timeout kill hung streams fast, and the user can always Abort (cancel_ai).
 *  A model that streams slowly but steadily (weak/thinking models) is allowed
 *  to finish; this cap only guards against a runaway generation. */
const AI_MAX_SECONDS: u64 = 900;
fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("docubook_server=info,tower_http=info")),
        )
        .init();

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
        warn!(event = "data_dir_not_writable", data_dir = %data_dir, "data directory is not writable");
    }

    let state = AppState {
        vault: Arc::new(Mutex::new(None)),
        wiki: Arc::new(Mutex::new(None)),
        git: Arc::new(Mutex::new(None)),
        ai_cancel: Arc::new(AtomicBool::new(false)),
        ai_slots: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_AI_REQUESTS)),
        auth: Arc::new(AuthState::new(Path::new(&data_dir))),
        data_dir: data_dir.clone().into(),
    };

    let app = build_router(state, PathBuf::from(&www_dir));

    let addr = format!("[::]:{port}");
    info!(event = "server_listening", address = %addr, data_dir = %data_dir, www_dir = %www_dir);
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
        .layer(PropagateRequestIdLayer::new(REQUEST_ID_HEADER.clone()))
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(|request: &Request| {
                    let request_id = request
                        .extensions()
                        .get::<RequestId>()
                        .and_then(|id| id.header_value().to_str().ok())
                        .unwrap_or("unknown");
                    tracing::info_span!(
                        "http_request",
                        request_id,
                        method = %request.method(),
                        status = tracing::field::Empty,
                        duration_ms = tracing::field::Empty
                    )
                })
                .on_request(())
                .on_response(|response: &Response, latency: std::time::Duration, span: &Span| {
                    span.record("status", response.status().as_u16());
                    span.record("duration_ms", latency.as_millis() as u64);
                    info!(parent: span, event = "http_request_complete");
                })
                .on_failure(|failure: tower_http::classify::ServerErrorsFailureClass, latency: std::time::Duration, span: &Span| {
                    warn!(parent: span, event = "http_request_failure", error_category = %failure, duration_ms = latency.as_millis() as u64);
                }),
        )
        .layer(SetRequestIdLayer::new(
            REQUEST_ID_HEADER.clone(),
            MakeRequestUuid,
        ))
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
