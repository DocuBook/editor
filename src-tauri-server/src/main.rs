//! DocuBook web server — the same codebase, served over HTTP.
//!
//! Reuses the pure-Rust modules from the desktop app (vault, wiki, git,
//! search, agent) via `#[path]` includes — zero logic duplication. Exposes
//! the same command surface as the Tauri IPC (`POST /api/<cmd>`), streams AI
//! over SSE, and serves the built frontend (`dist/`) with SPA fallback.
//!
//! Run: `WWW_DIR=dist DATA_DIR=./data cargo run --release` (after `npm run build`).
//! Docker: see ../Dockerfile (multi-stage, single binary, non-root).

#[path = "../../src-tauri/src/vault/mod.rs"] mod vault;
#[path = "../../src-tauri/src/git/mod.rs"] mod git;
#[path = "../../src-tauri/src/wiki/mod.rs"] mod wiki;
#[path = "../../src-tauri/src/search/mod.rs"] mod search;
#[path = "../../src-tauri/src/agent/mod.rs"] mod agent;
mod keys;
mod auth;
mod config;

use config::AuthState;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::{ConnectInfo, Path as AxPath, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::extract::Request;
use axum::{Json, Router};
use serde_json::{json, Value};
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

fn main() {
    let data_dir = std::env::var("DATA_DIR").unwrap_or_else(|_| "./data".into());
    let www_dir = std::env::var("WWW_DIR").unwrap_or_else(|_| "./dist".into());
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    std::fs::create_dir_all(&data_dir).expect("data dir");

    let state = AppState {
        vault: Arc::new(Mutex::new(None)),
        wiki: Arc::new(Mutex::new(None)),
        git: Arc::new(Mutex::new(None)),
        ai_cancel: Arc::new(AtomicBool::new(false)),
        auth: Arc::new(AuthState::new(Path::new(&data_dir))),
        data_dir: data_dir.clone().into(),
    };

    let index = std::path::PathBuf::from(&www_dir).join("index.html");
    let app = Router::new()
        .route("/api/health", get(health_route))
        .route("/api/ask_ai", post(ask_ai))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/setup_admin", post(setup_admin))
        .route("/api/{cmd}", post(api))
        .layer(middleware::from_fn(security_headers))
        .layer(middleware::from_fn_with_state(state.clone(), auth_mw))
        // axum 0.8: .layer() does NOT wrap fallback_service — wrap the static
        // service explicitly so security headers apply to / and /assets too.
        .fallback_service(
            tower::ServiceBuilder::new()
                .layer(middleware::from_fn(security_headers))
                .service(ServeDir::new(&www_dir).fallback(ServeFile::new(index))),
        )
        .with_state(state);

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
            Err(_) => tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await.expect("bind"),
        };
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
            .expect("serve");
    });
}

/** Shared command dispatcher — same surface as tauri's generate_handler. */
async fn dispatch(state: &AppState, cmd: &str, args: Value) -> Result<String, String> {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let st = state.clone();
    match cmd {
        // File scan / network ops run off the async thread — mirrors spawn_blocking in lib.rs.
        "open_vault" => {
            let p = ensure_within_data(&st, &s("path"))?;
            tokio::task::spawn_blocking(move || open_vault(&st, &p)).await.map_err(|e| e.to_string())?
        }
        "create_vault" => {
            let (name, parent) = (s("name"), s("parent"));
            let parent = ensure_within_data(&st, &parent)?;
            tokio::task::spawn_blocking(move || create_vault(&st, &parent, &name)).await.map_err(|e| e.to_string())?
        }
        "git_clone" => {
            let (url, parent) = (s("url"), s("parent"));
            let parent = ensure_within_data(&st, &parent)?;
            tokio::task::spawn_blocking(move || git_clone(&st, &url, &parent)).await.map_err(|e| e.to_string())?
        }
        "search_vault" => {
            let q = s("query");
            tokio::task::spawn_blocking(move || search_vault(&st, &q)).await.map_err(|e| e.to_string())?
        }
        "git_push" => {
            let m = s("message");
            tokio::task::spawn_blocking(move || git_push(&st, &m)).await.map_err(|e| e.to_string())?
        }
        "close_vault" => sync(state, cmd, args),
        "list_tree" => sb(state, cmd, args).await,
        "read_file" => sync(state, cmd, args),
        "write_file" => sync(state, cmd, args),
        "create_file" => sync(state, cmd, args),
        "create_directory" => sync(state, cmd, args),
        "delete_file" => sb(state, cmd, args).await,
        "rename_file" => sync(state, cmd, args),
        "git_settings" => sb(state, cmd, args).await,
        "git_add_remote" => sb(state, cmd, args).await,
        "git_remove_remote" => sb(state, cmd, args).await,
        "git_set_identity" => sb(state, cmd, args).await,
        "git_init" => sb(state, cmd, args).await,
        "git_stage" => sb(state, cmd, args).await,
        "git_status" => sb(state, cmd, args).await,
        "wiki_backlinks" => sync(state, cmd, args),
        "wiki_suggest" => sync(state, cmd, args),
        "markdown_preview" => sync(state, cmd, args),
        "md_to_html" => sync(state, cmd, args),
        "cancel_ai" => sync(state, cmd, args),
        "set_api_key" => sync(state, cmd, args),
        "delete_api_key" => sync(state, cmd, args),
        "list_api_keys" => sync(state, cmd, args),
        "web_vaults" => sync(state, cmd, args),
        "web_vault_root" => sync(state, cmd, args),
        "setup_status" => sync(state, cmd, args),
        "account_get" => sync(state, cmd, args),
        "change_password" => sync(state, cmd, args),
        "config_get" => sync(state, cmd, args),
        "config_set" => sync(state, cmd, args),
        "health" => Ok(health(state).to_string()),
        "test_connection" => test_connection(state, &s("provider"), &s("model"), &s("base_url"), &s("api_key")).await,
        _ => Err(format!("Unknown command: {cmd}")),
    }
}

/** Run a cheap sync command body on the current thread. */
fn sync(state: &AppState, cmd: &str, args: Value) -> Result<String, String> {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    match cmd {
        "close_vault" => {
            *state.vault.lock().expect("lock") = None;
            *state.wiki.lock().expect("lock") = None;
            *state.git.lock().expect("lock") = None;
            Ok("null".into())
        }
        "list_tree" => match state.vault.lock().expect("lock").as_ref() {
            Some(v) => serde_json::to_string(&v.tree(&s("subpath"))).map_err(|e| e.to_string()),
            None => Ok("[]".into()),
        },
        "read_file" => match state.vault.lock().expect("lock").as_ref() {
            Some(v) => v.read_file(&s("path")),
            None => Err("No vault".into()),
        },
        "write_file" => match state.vault.lock().expect("lock").as_ref() {
            Some(v) => v.write_file(&s("path"), &s("content")).map(|_| "null".into()),
            None => Err("No vault".into()),
        },
        "create_file" => match state.vault.lock().expect("lock").as_ref() {
            Some(v) => v.create_file(&s("path")),
            None => Err("No vault".into()),
        },
        "create_directory" => match state.vault.lock().expect("lock").as_ref() {
            Some(v) => v.create_directory(&s("path")).map(|_| "null".into()),
            None => Err("No vault".into()),
        },
        "delete_file" => match state.vault.lock().expect("lock").as_ref() {
            Some(v) => v.delete_file(&s("path")).map(|_| "null".into()),
            None => Err("No vault".into()),
        },
        "rename_file" => match state.vault.lock().expect("lock").as_ref() {
            Some(v) => v.rename_file(&s("from"), &s("to")).map(|_| "null".into()),
            None => Err("No vault".into()),
        },
        "git_settings" => git_settings(state),
        "git_add_remote" => match state.git.lock().expect("lock").as_ref() {
            Some(g) => g.add_remote(&s("name"), &s("url")).map(|_| "null".into()),
            None => Err("No vault".into()),
        },
        "git_remove_remote" => match state.git.lock().expect("lock").as_ref() {
            Some(g) => g.remove_remote(&s("name")).map(|_| "null".into()),
            None => Err("No vault".into()),
        },
        "git_set_identity" => match state.git.lock().expect("lock").as_ref() {
            Some(g) => g.set_identity(&s("name"), &s("email")).map(|_| "null".into()),
            None => Err("No vault".into()),
        },
        "git_init" => match state.git.lock().expect("lock").as_ref() {
            Some(g) => g.init().map(|_| "null".into()),
            None => Err("No vault".into()),
        },
        "git_stage" => match state.git.lock().expect("lock").as_ref() {
            Some(g) => g.add_all().map_err(|e| e.to_string()).map(|_| "null".into()),
            None => Err("No vault".to_string()),
        },
        "git_status" => {
            let guard = state.git.lock().expect("lock");
            match guard.as_ref() {
                Some(g) if g.is_repo() => {
                    let (branch, status) = g.status_with_branch().unwrap_or_default();
                    Ok(json!({ "branch": branch, "status": status.trim() }).to_string())
                }
                _ => Ok(r#"{"branch":"","status":""}"#.to_string()),
            }
        }
        "wiki_backlinks" => match state.wiki.lock().expect("lock").as_ref() {
            Some(w) => serde_json::to_string(&w.backlinks(&s("path"))).map_err(|e| e.to_string()),
            None => Ok("[]".to_string()),
        },
        "wiki_suggest" => match state.wiki.lock().expect("lock").as_ref() {
            Some(w) => serde_json::to_string(&w.suggest(&s("query"))).map_err(|e| e.to_string()),
            None => Ok("[]".to_string()),
        },
        "markdown_preview" => Ok(format!(
            r#"<div class="prose prose-invert max-w-none px-4 py-4 text-sm">{}</div>"#,
            markdown_to_safe_html(&s("content"))
        )),
        "md_to_html" => Ok(markdown_to_safe_html(&s("content"))),
        "cancel_ai" => {
            state.ai_cancel.store(true, Ordering::SeqCst);
            Ok("null".into())
        }
        "set_api_key" => keys::set_key(&state.data_dir, &s("provider"), &s("key")).map(|_| "null".into()),
        "delete_api_key" => keys::delete_key(&state.data_dir, &s("provider")).map(|_| "null".into()),
        "list_api_keys" => {
            let providers: Vec<String> = args
                .get("providers")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(|x| x.to_string())).collect())
                .unwrap_or_default();
            Ok(serde_json::to_string(&keys::list_keys(&state.data_dir, &providers)).map_err(|e| e.to_string())?)
        }
        "web_vaults" => web_vaults(state),
        "web_vault_root" => Ok(state.data_dir.join("vaults").to_string_lossy().to_string()),
        // ── account / system ──
        "setup_status" => {
            let cfg = state.auth.config.lock().expect("lock");
            Ok(json!({ "setupRequired": cfg.admin.is_none(), "noAuth": cfg.no_auth }).to_string())
        },
        "account_get" => {
            let cfg = state.auth.config.lock().expect("lock");
            match &cfg.admin {
                Some(a) => Ok(json!({ "email": a.email }).to_string()),
                None => Err("No admin account".into()),
            }
        },
        "change_password" => state
            .auth
            .config
            .lock()
            .expect("lock")
            .change_password(&s("old"), &s("new"))
            .map(|_| "null".into()),
        "config_get" => Ok(state.auth.config.lock().expect("lock").view(&state.data_dir).to_string()),
        "config_set" => {
            let key = s("key");
            let value = args.get("value").cloned().unwrap_or(Value::Null);
            state.auth.config.lock().expect("lock").set(&key, &value).map(|_| "null".into())
        },
        _ => Err(format!("Unknown command: {cmd}")),
    }
}

/** Run a blocking command body off the async runtime (spawn_blocking). */
async fn sb(state: &AppState, cmd: &str, args: Value) -> Result<String, String> {
    let st = state.clone();
    let c = cmd.to_string();
    let a = args;
    tokio::task::spawn_blocking(move || sync(&st, &c, a)).await.map_err(|e| e.to_string())?
}

// ── command bodies (mirror src-tauri/src/lib.rs) ──

fn open_vault(state: &AppState, path: &str) -> Result<String, String> {
    let v = vault::Vault::new(path)?;
    let name = v.name();
    let mut w = wiki::WikiIndex::new(v.root());
    w.scan();
    eprintln!("[docubook] open_vault: {} (git repo: {})", path, std::path::Path::new(path).join(".git").exists());
    let g = git::Git::open(path);
    *state.vault.lock().expect("lock") = Some(v);
    *state.wiki.lock().expect("lock") = Some(w);
    *state.git.lock().expect("lock") = Some(g);
    Ok(json!({ "name": name }).to_string())
}

fn valid_vault_name(name: &str) -> bool {
    !name.is_empty() && name != "." && !name.contains("..") && !name.contains('/') && !name.contains('\\')
}

fn create_vault(state: &AppState, parent: &str, name: &str) -> Result<String, String> {
    if !valid_vault_name(name) {
        return Err("Invalid vault name".to_string());
    }
    let dir = std::path::Path::new(parent).join(name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    open_vault(state, dir.to_str().ok_or("Invalid path")?)
}

fn git_clone(state: &AppState, url: &str, parent: &str) -> Result<String, String> {
    let dir = git::Git::clone_repo(url, parent)?;
    let resp = open_vault(state, &dir)?;
    let mut v: Value = serde_json::from_str(&resp).map_err(|e| e.to_string())?;
    v["path"] = Value::String(dir);
    Ok(v.to_string())
}

fn search_vault(state: &AppState, query: &str) -> Result<String, String> {
    let root = match state.vault.lock().expect("lock").as_ref() {
        Some(v) => v.root().to_path_buf(),
        None => return Ok("[]".to_string()),
    };
    serde_json::to_string(&search::search_vault(&root, query)).map_err(|e| e.to_string())
}

fn git_push(state: &AppState, message: &str) -> Result<String, String> {
    let repo_path = match state.git.lock().expect("lock").as_ref() {
        Some(g) => g.repo_path.clone(),
        None => return Ok(r#"{"error":"No vault"}"#.to_string()),
    };
    Ok(serde_json::to_string(&git::Git::open(&repo_path).push_full(message)).map_err(|e| e.to_string())?)
}

fn git_settings(state: &AppState) -> Result<String, String> {
    match state.git.lock().expect("lock").as_ref() {
        Some(g) if g.is_repo() => {
            let (name, email) = g.identity()?;
            let remotes = g.remotes()?;
            Ok(json!({
                "isRepo": true, "name": name, "email": email,
                "remotes": remotes.iter().map(|(n, u)| json!({ "name": n, "url": u })).collect::<Vec<_>>(),
            }).to_string())
        }
        Some(_) => Ok(r#"{"isRepo":false,"noVault":false,"name":"","email":"","remotes":[]}"#.to_string()),
        None => Ok(r#"{"isRepo":false,"noVault":true,"name":"","email":"","remotes":[]}"#.to_string()),
    }
}

/** Server-side vault folders under DATA_DIR/vaults — the web "open folder" dialog. */
fn web_vaults(state: &AppState) -> Result<String, String> {
    let root = state.data_dir.join("vaults");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            out.push(json!({ "name": entry.file_name().to_string_lossy().to_string(), "path": path.to_string_lossy().to_string() }));
        }
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

fn health(state: &AppState) -> String {
    let vault_open = state.vault.lock().expect("lock").is_some();
    let git_repo = state.git.lock().expect("lock").as_ref().map(|g| g.is_repo()).unwrap_or(false);
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "vaultOpen": vault_open,
        "gitRepo": git_repo,
    }).to_string()
}

fn markdown_to_safe_html(content: &str) -> String {
    let mut options = pulldown_cmark::Options::empty();
    options.insert(pulldown_cmark::Options::ENABLE_STRIKETHROUGH);
    options.insert(pulldown_cmark::Options::ENABLE_TABLES);
    options.insert(pulldown_cmark::Options::ENABLE_TASKLISTS);
    let parser = pulldown_cmark::Parser::new_ext(content, options);
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, parser);
    ammonia::clean(&html)
}

// ── HTTP handlers ──

async fn api(State(state): State<AppState>, AxPath(cmd): AxPath<String>, Json(args): Json<Value>) -> Response {
    match dispatch(&state, &cmd, args).await {
        Ok(s) => Json(json!({ "result": s })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

/** F2: web server only — vault paths must stay inside DATA_DIR. Desktop is
 *  unaffected (it opens any local folder by design). All normal UI flows use
 *  paths under DATA_DIR/vaults, so this only blocks the arbitrary-read vector.
 *  Tolerates not-yet-existing children (first create_vault on a fresh data dir)
 *  by canonicalizing the nearest existing ancestor, then appending the tail. */
fn ensure_within_data(state: &AppState, path: &str) -> Result<String, String> {
    let data = state.data_dir.canonicalize().map_err(|e| e.to_string())?;
    let p = std::path::Path::new(path);
    let mut existing = p;
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name.to_os_string());
                existing = parent;
            }
            _ => break,
        }
    }
    let mut canon = existing.canonicalize().map_err(|_| "Path does not exist".to_string())?;
    for part in tail.iter().rev() {
        canon.push(part);
    }
    if canon.starts_with(&data) {
        Ok(canon.to_string_lossy().to_string())
    } else {
        Err("Path is outside the server data directory".into())
    }
}

/** F3: security headers on every response (CSP keeps the app self-contained;
 *  img-src https: preserves external images in markdown previews). */
async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; connect-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"));
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    res
}

async fn health_route(state: State<AppState>) -> Response {
    Json(json!({ "result": health(&state) })).into_response()
}

// ── auth: setup wizard + safe login ──
// Gates: setup_required (no admin yet) → open (backward compat: existing
// deployments keep working until the wizard runs). no_auth → always open
// (DB_NO_AUTH=1 / wizard "skip"). Otherwise session cookie required.

async fn auth_mw(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    // Static frontend + non-API paths are always public (the app shell loads
    // for everyone; data access is gated via the /api routes below).
    if !path.starts_with("/api/") {
        return next.run(req).await;
    }
    let (setup_required, no_auth) = {
        let cfg = state.auth.config.lock().expect("lock");
        (cfg.admin.is_none(), cfg.no_auth)
    };
    let exempt = matches!(
        path.as_str(),
        "/api/setup_status" | "/api/login" | "/api/logout" | "/api/setup_admin" | "/api/health"
    );
    if no_auth || setup_required || exempt {
        return next.run(req).await;
    }
    let token = req
        .headers()
        .get(header::COOKIE)
        .and_then(|c| c.to_str().ok())
        .and_then(|c| cookie_value(c, "db_session"));
    if let Some(t) = token {
        if state.auth.sessions.valid(&t, state.auth.session_ttl()) {
            return next.run(req).await;
        }
    }
    (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Unauthorized" }))).into_response()
}

fn cookie_value(cookie: &str, name: &str) -> Option<String> {
    cookie.split(';').find_map(|part| {
        let mut it = part.trim().splitn(2, '=');
        match (it.next(), it.next()) {
            (Some(k), Some(v)) if k == name => Some(v.to_string()),
            _ => None,
        }
    })
}

fn session_cookie(state: &AuthState, token: &str) -> String {
    let ttl = state.config.lock().expect("lock").session_ttl_hours * 3600;
    let secure = if state.secure_cookie { "; Secure" } else { "" };
    format!("db_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={ttl}{secure}")
}


async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    Json(args): Json<Value>,
) -> Response {
    let email = args.get("email").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let password = args.get("password").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let ip = addr.ip().to_string();
    let (admin, no_auth) = {
        let cfg = state.auth.config.lock().expect("lock");
        (cfg.admin.clone(), cfg.no_auth)
    };
    if no_auth {
        return err_response("Login is disabled (no_auth mode)");
    }
    let admin = match admin {
        Some(a) => a,
        None => return err_response("Setup required"),
    };
    if let Err(e) = state.auth.limiter.check(&ip) {
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": e }))).into_response();
    }
    if !admin.email.eq_ignore_ascii_case(&email) || !auth::verify_password(&admin.password_hash, &password) {
        state.auth.limiter.fail(&ip);
        return err_response("Invalid email or password");
    }
    state.auth.limiter.clear(&ip);
    let token = state.auth.sessions.create(state.auth.session_ttl());
    (
        StatusCode::OK,
        [(header::SET_COOKIE, session_cookie(&state.auth, &token))],
        Json(json!({ "result": "null" })),
    )
        .into_response()
}

async fn logout(State(state): State<AppState>, req: Request) -> Response {
    if let Some(t) = req
        .headers()
        .get(header::COOKIE)
        .and_then(|c| c.to_str().ok())
        .and_then(|c| cookie_value(c, "db_session"))
    {
        state.auth.sessions.revoke(&t);
    }
    (
        StatusCode::OK,
        [(header::SET_COOKIE, "db_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0")],
        Json(json!({ "result": "null" })),
    )
        .into_response()
}

async fn setup_admin(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    Json(args): Json<Value>,
) -> Response {
    let email = args.get("email").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let password = args.get("password").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let token = args.get("token").and_then(|v| v.as_str()).map(|s| s.to_string());
    let ip = addr.ip().to_string();
    // Rate-limit the pre-auth claim window (F1): 5 attempts / minute per IP.
    if let Err(e) = state.auth.limiter.check(&ip) {
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": e }))).into_response();
    }
    let mut cfg = state.auth.config.lock().expect("lock");
    let res = cfg.setup_admin(&email, &password, token.as_deref());
    drop(cfg); // never call session_ttl/session_cookie while holding the config lock (std Mutex is not reentrant)
    match res {
        Ok(()) => {
            state.auth.limiter.clear(&ip);
            let token = state.auth.sessions.create(state.auth.session_ttl());
            (
                StatusCode::OK,
                [(header::SET_COOKIE, session_cookie(&state.auth, &token))],
                Json(json!({ "result": "null" })),
            )
                .into_response()
        }
        Err(e) => {
            state.auth.limiter.fail(&ip);
            err_response(&e)
        }
    }
}

/** Mirrors lib.rs ask_ai + test_connection — streams SSE events to the browser. */
async fn test_connection(state: &AppState, _provider: &str, model: &str, base_url: &str, api_key: &str) -> Result<String, String> {
    let _ = state;
    agent::validate_base_url(base_url)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Client error: {}", e))?;
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let basic_body = json!({ "model": model, "messages": [{ "role": "user", "content": "say ok" }], "max_tokens": 8 });
    let res = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&basic_body)
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("API error ({}): {}", res.status(), res.text().await.unwrap_or_default()));
    }

    let tool_body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": "call the test_tool" }],
        "tools": [{
            "type": "function",
            "function": {
                "name": "test_tool",
                "description": "A test tool",
                "parameters": { "type": "object", "properties": { "ok": { "type": "boolean" } } }
            }
        }],
        "tool_choice": "required",
        "max_tokens": 50,
    });
    let tool_res = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&tool_body)
        .send()
        .await
        .map_err(|e| format!("Tool test failed: {}", e))?;
    if !tool_res.status().is_success() {
        return Ok("connection ok".to_string());
    }
    let text = tool_res.text().await.map_err(|e| e.to_string())?;
    let supports_tools = text.contains("tool_calls") || text.contains("test_tool");
    Ok(format!(r#"{{"status":"ok","tools":{}}}"#, supports_tools))
}

/** Map transport errors to user-safe messages — mirrors lib.rs. */
fn sanitize_ai_error(err: &str) -> String {
    let e = err.to_lowercase();
    if e.contains("dns") || e.contains("resolve") || e.contains("connection") || e.contains("refused") || e.contains("connect") {
        "Could not reach the AI provider — check your connection".into()
    } else if e.contains("timeout") || e.contains("timed out") {
        "The AI provider timed out".into()
    } else if e.contains("tls") || e.contains("ssl") || e.contains("certificate") {
        "Secure connection to the AI provider failed".into()
    } else if e.contains("body") || e.contains("json") || e.contains("parse") {
        "The AI provider returned an unreadable response".into()
    } else {
        "AI request failed".into()
    }
}

async fn ask_ai(State(state): State<AppState>, Json(args): Json<Value>) -> Response {
    eprintln!("[ask_ai] handler entry");
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let provider = s("provider");
    let model = s("model");
    let base_url = s("baseUrl");
    let messages = s("messages");
    let tools = args.get("tools").and_then(|v| v.as_str()).map(|t| t.to_string());

    let agent_cfg = match (provider.as_str(), model.as_str(), base_url.as_str()) {
        (p, m, b) if !p.is_empty() && !m.is_empty() && !b.is_empty() => {
            if let Err(e) = agent::validate_base_url(b) {
                return err_response(&e);
            }
            let key = match keys::get_key(&state.data_dir, p) {
                Ok(k) => k,
                Err(_) => return err_response("No API key found"),
            };
            agent::Agent::new(p, m, &key, b)
        }
        _ => return err_response("Provider, model, and base URL are required"),
    };

    state.ai_cancel.store(false, Ordering::SeqCst);
    let started = std::time::Instant::now();
    let client = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(120))
        .build()
    {
        Ok(c) => c,
        Err(e) => return err_response(&format!("Client error: {}", e)),
    };

    let mut body_obj = match serde_json::from_str::<Value>(&messages) {
        Ok(msgs) => json!({ "model": agent_cfg.model, "messages": msgs, "stream": true }),
        Err(_) => return err_response("Invalid messages"),
    };
    if let Some(ref tools_str) = tools {
        if let Ok(tools_val) = serde_json::from_str::<Value>(tools_str) {
            if let Some(arr) = tools_val.as_array() {
                if !arr.is_empty() {
                    body_obj["tools"] = tools_val;
                    body_obj["tool_choice"] = json!("required");
                }
            }
        }
    }

    let url = format!("{}/chat/completions", agent_cfg.base_url.trim_end_matches('/'));
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, axum::Error>>(64);

    tokio::spawn(async move {
        let mut req = client.post(&url).header("Authorization", format!("Bearer {}", agent_cfg.api_key));
        if agent_cfg.provider == "opencode-go" || agent_cfg.provider == "opencode" {
            req = req
                .header("x-opencode-client", "docubook")
                .header("x-opencode-session", format!("docubook-{}", std::process::id()));
        }
        let response = match tokio::time::timeout(std::time::Duration::from_secs(30), req.json(&body_obj).send()).await {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                eprintln!("[ask_ai] send error at {:.0}s: {}", started.elapsed().as_secs_f32(), e);
                let _ = tx.send(Ok(Event::default().event("error").data(sanitize_ai_error(&e.to_string())))).await;
                return;
            }
            Err(_) => {
                eprintln!("[ask_ai] send timeout at {:.0}s — provider never responded", started.elapsed().as_secs_f32());
                let _ = tx.send(Ok(Event::default().event("error").data("AI provider did not respond — try again"))).await;
                return;
            }
        };
        let status = response.status();
        if !status.is_success() {
            let _ = tx.send(Ok(Event::default().event("error").data("AI provider error (HTTP {status})"))).await;
            return;
        }
        let mut stream = response;
        // First-chunk budget (P1): a provider that accepts the request but never
        // sends data gets 30s, not the 120s stall timeout. After the first chunk
        // arrives, inter-chunk stalls keep the 120s read_timeout.
        let first = match tokio::time::timeout(std::time::Duration::from_secs(30), stream.chunk()).await {
            Ok(Ok(Some(c))) => c,
            Ok(Ok(None)) => {
                let _ = tx.send(Ok(Event::default().event("error").data("AI provider returned an empty response"))).await;
                return;
            }
            Ok(Err(e)) => {
                let _ = tx.send(Ok(Event::default().event("error").data(sanitize_ai_error(&e.to_string())))).await;
                return;
            }
            Err(_) => {
                eprintln!("[ask_ai] P1 first-chunk timeout fired at {:.0}s", started.elapsed().as_secs_f32());
                let _ = tx.send(Ok(Event::default().event("error").data("AI provider did not respond — try again"))).await;
                return;
            }
        };
        let mut full = String::new();
        let mut tool_calls: Vec<(i64, String, String, String)> = Vec::new();
        let mut byte_buf: Vec<u8> = Vec::new();
        let mut truncated = false;
        let mut first_chunk = Some(first);
        loop {
            let chunk = match first_chunk.take() {
                Some(c) => Ok(Some(c)),
                None => stream.chunk().await,
            };
            match chunk {
                Ok(Some(chunk)) => {
                    if state.ai_cancel.load(Ordering::SeqCst) {
                        break;
                    }
                    byte_buf.extend_from_slice(&chunk);
                    let mut start = 0;
                    while let Some(pos) = byte_buf[start..].iter().position(|&b| b == b'\n') {
                        let line_end = start + pos;
                        let line = String::from_utf8_lossy(&byte_buf[start..line_end]);
                        let data = line.trim_end_matches('\r').strip_prefix("data: ").unwrap_or("");
                        if !data.is_empty() {
                            let out = process_sse_data(data, &mut full, &mut tool_calls, &tx).await;
                            if let Err(e) = out {
                                let _ = tx.send(Ok(Event::default().event("error").data(e))).await;
                                return;
                            }
                            if full.len() >= MAX_AI_BUFFER {
                                truncated = true;
                                break;
                            }
                        }
                        start = line_end + 1;
                    }
                    byte_buf.drain(..start);
                    if truncated {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    eprintln!("[ask_ai] stream read error at {:.0}s: {}", started.elapsed().as_secs_f32(), e);
                    let _ = tx.send(Ok(Event::default().event("error").data(sanitize_ai_error(&e.to_string())))).await;
                    return;
                }
            }
        }
        if !byte_buf.is_empty() {
            let line = String::from_utf8_lossy(&byte_buf);
            let data = line.trim_end_matches('\r').strip_prefix("data: ").unwrap_or("");
            if !data.is_empty() {
                let _ = process_sse_data(data, &mut full, &mut tool_calls, &tx).await;
            }
        }
        for (_, id, name, args_json) in &tool_calls {
            if !id.is_empty() && !name.is_empty() {
                let input: Value = serde_json::from_str(args_json).unwrap_or(Value::Null);
                let _ = tx.send(Ok(Event::default().event("ai:tool_call").data(json!({
                    "toolCallId": id, "toolName": name, "input": input,
                }).to_string()))).await;
            }
        }
        let _ = tx.send(Ok(Event::default().event("ai:tools_done").data("\"\""))).await;
        if full.is_empty() && tool_calls.is_empty() {
            let _ = tx.send(Ok(Event::default().event("error").data("AI returned empty response"))).await;
            return;
        }
        eprintln!("[docubook] ask_ai done: elapsed={:.1}s chars={} tools={} truncated={}", started.elapsed().as_secs_f32(), full.len(), tool_calls.len(), truncated);
        let _ = tx.send(Ok(Event::default().event("ai:done").data(json!({ "provider": agent_cfg.provider, "truncated": truncated }).to_string()))).await;
    });

    Sse::new(ReceiverStream::new(rx)).keep_alive(KeepAlive::default()).into_response()
}

type SseTx = tokio::sync::mpsc::Sender<Result<Event, axum::Error>>;

/** One complete SSE `data:` payload from the provider → forward as events. */
async fn process_sse_data(data: &str, full: &mut String, tool_calls: &mut Vec<(i64, String, String, String)>, tx: &SseTx) -> Result<(), String> {
    if data == "[DONE]" {
        return Ok(());
    }
    let Ok(val) = serde_json::from_str::<Value>(data) else {
        return Ok(());
    };
    if let Some(content) = val["choices"][0]["delta"]["content"].as_str() {
        full.push_str(content);
        let _ = tx.send(Ok(Event::default().event("ai:token").data(serde_json::to_string(content).map_err(|e| e.to_string())?))).await;
    }
    if let Some(tcs) = val["choices"][0]["delta"]["tool_calls"].as_array() {
        for tc in tcs {
            let idx = tc["index"].as_i64().unwrap_or(0);
            let id = tc["id"].as_str().unwrap_or("").to_string();
            let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
            let args = tc["function"]["arguments"].as_str().unwrap_or("").to_string();
            if let Some(pos) = tool_calls.iter().position(|(i, _, _, _)| *i == idx) {
                if !id.is_empty() {
                    tool_calls[pos].1 = id;
                }
                if !name.is_empty() {
                    tool_calls[pos].2 = name;
                }
                tool_calls[pos].3.push_str(&args);
            } else {
                tool_calls.push((idx, id, name, args));
            }
        }
    }
    Ok(())
}

fn err_response(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}
