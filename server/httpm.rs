// HTTP middleware — security headers, auth, file serving (isolated).
use super::*;
use tokio::io::AsyncReadExt;

pub(crate) const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

pub(crate) async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"));
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    res
}

pub(crate) async fn health_route(state: State<AppState>) -> Response {
    Json(json!({ "result": super::cmds::health(&state) })).into_response()
}

/**
 * Serve a vault file (images, etc) to the browser. Path must live under the
 * data dir; auth is handled by the shared auth_mw (the /api route gate). Binary files
 * can't go through the JSON read_file command, so this is the web counterpart
 * of Tauri's asset protocol.
 */
pub(crate) async fn file_route(
    state: State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(path) = params.get("path") else {
        return (StatusCode::BAD_REQUEST, "missing path").into_response();
    };
    let root = match state.vault.lock().expect("lock").as_ref() {
        Some(vault) => vault.root().to_path_buf(),
        None => return (StatusCode::BAD_REQUEST, "no vault open").into_response(),
    };
    let Ok(root) = root.canonicalize() else {
        return (StatusCode::NOT_FOUND, "vault not found").into_response();
    };
    let Ok(abs) = std::path::Path::new(path).canonicalize() else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    if !abs.starts_with(&root) || !abs.is_file() {
        return (StatusCode::FORBIDDEN, "path outside active vault").into_response();
    }
    let Ok(file) = tokio::fs::File::open(&abs).await else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    // Bound allocation even if an authenticated user requests a huge vault file.
    // Read one extra byte so files growing after metadata validation are rejected.
    let mut bytes = Vec::new();
    if file
        .take(MAX_FILE_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .await
        .is_err()
    {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, "file too large").into_response();
    }
    let mime = mime_guess::from_path(&abs).first_or_octet_stream();
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, mime.as_ref())],
        bytes,
    )
        .into_response()
}

// ── auth: setup wizard + safe login ──
// Gates: setup_required (no admin yet) → open (backward compat: existing
// deployments keep working until the wizard runs). no_auth → always open
// (DB_NO_AUTH=1 / wizard "skip"). Otherwise session cookie required.

pub(crate) async fn auth_mw(State(state): State<AppState>, req: Request, next: Next) -> Response {
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
    let always_public = matches!(
        path.as_str(),
        "/api/setup_status" | "/api/login" | "/api/logout" | "/api/setup_admin" | "/api/health"
    );
    let setup_public = matches!(
        path.as_str(),
        "/api/setup_status" | "/api/setup_admin" | "/api/health"
    );
    if no_auth || (setup_required && setup_public) || (!setup_required && always_public) {
        return next.run(req).await;
    }
    let token = req
        .headers()
        .get(header::COOKIE)
        .and_then(|c| c.to_str().ok())
        .and_then(|c| super::auth_routes::cookie_value(c, "db_session"));
    if let Some(t) = token {
        if state.auth.sessions.valid(&t, state.auth.session_ttl()) {
            return next.run(req).await;
        }
    }
    tracing::warn!(event = "auth_unauthorized_api_access");
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Unauthorized" })),
    )
        .into_response()
}
