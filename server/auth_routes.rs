// Auth routes (isolated).
use super::*;

pub(crate) fn cookie_value(cookie: &str, name: &str) -> Option<String> {
    cookie.split(';').find_map(|part| {
        let mut it = part.trim().splitn(2, '=');
        match (it.next(), it.next()) {
            (Some(k), Some(v)) if k == name => Some(v.to_string()),
            _ => None,
        }
    })
}

/// The client reached us over HTTPS, as reported by the TLS-terminating proxy.
/// Only the cookie flag reads this: a client that spoofs it over plain HTTP just
/// gets a cookie its own browser refuses to store.
pub(crate) fn request_uses_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("https"))
}

pub(crate) fn session_cookie(state: &AuthState, token: &str, headers: &HeaderMap) -> String {
    let ttl = state.config.lock().expect("lock").session_ttl_hours * 3600;
    // DB_SECURE_COOKIE forces the flag either way; unset follows the request.
    let secure_flag = state.secure_cookie.unwrap_or_else(|| request_uses_https(headers));
    let secure = if secure_flag { "; Secure" } else { "" };
    format!("db_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={ttl}{secure}")
}

pub(crate) async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(args): Json<Value>,
) -> Response {
    let email = args
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let password = args
        .get("password")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let ip = addr.ip().to_string();
    let admin = state.auth.config.lock().expect("lock").admin.clone();
    let admin = match admin {
        Some(a) => a,
        None => {
            tracing::warn!(event = "auth_login_failure", reason = "setup_required", client_ip = %ip);
            return err_response("Setup required");
        }
    };
    if let Err(e) = state.auth.limiter.check(&ip) {
        tracing::warn!(event = "auth_login_rate_limited", client_ip = %ip);
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": e }))).into_response();
    }
    if !admin.email.eq_ignore_ascii_case(&email)
        || !auth::verify_password(&admin.password_hash, &password)
    {
        tracing::warn!(event = "auth_login_failure", reason = "invalid_credentials", client_ip = %ip);
        return err_response("Invalid email or password");
    }
    state.auth.limiter.clear(&ip);
    let token = match state.auth.sessions.create(state.auth.session_ttl()) {
        Ok(token) => token,
        Err(e) => {
            tracing::error!(event = "auth_login_failure", reason = "session_creation", client_ip = %ip);
            return err_response(&e);
        }
    };
    tracing::info!(event = "auth_login_success", client_ip = %ip);
    (
        StatusCode::OK,
        [(header::SET_COOKIE, session_cookie(&state.auth, &token, &headers))],
        Json(json!({ "result": "null" })),
    )
        .into_response()
}

pub(crate) async fn logout(State(state): State<AppState>, req: Request) -> Response {
    let mut session_revoked = false;
    if let Some(t) = req
        .headers()
        .get(header::COOKIE)
        .and_then(|c| c.to_str().ok())
        .and_then(|c| cookie_value(c, "db_session"))
    {
        state.auth.sessions.revoke(&t);
        session_revoked = true;
    }
    tracing::info!(event = "auth_logout", session_revoked);
    (
        StatusCode::OK,
        [(
            header::SET_COOKIE,
            "db_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        )],
        Json(json!({ "result": "null" })),
    )
        .into_response()
}

pub(crate) async fn setup_admin(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(args): Json<Value>,
) -> Response {
    let email = args
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // Password is never defaulted to a literal: a missing or EMPTY password is
    // rejected outright, so no blank/hard-coded credential can be hashed into
    // an admin account.
    let password = match args.get("password").and_then(|v| v.as_str()) {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => return err_response("Email and password are required"),
    };
    let token = args
        .get("token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let ip = addr.ip().to_string();
    if email.is_empty() {
        return err_response("Email and password are required");
    }
    // Rate-limit the pre-auth claim window: 6 failed attempts / minute
    // per IP — blocked on the 7th (limiter blocks when count > MAX_ATTEMPTS).
    if let Err(e) = state.auth.limiter.check(&ip) {
        tracing::warn!(event = "auth_setup_rate_limited", client_ip = %ip);
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": e }))).into_response();
    }
    let mut cfg = state.auth.config.lock().expect("lock");
    // Without DB_SETUP_TOKEN only a loopback client may claim the account: the
    // server listens on all interfaces, so anyone else could take it first.
    if cfg.setup_token.is_none() && !addr.ip().to_canonical().is_loopback() {
        drop(cfg);
        tracing::warn!(event = "auth_setup_failure", reason = "setup_token_missing", client_ip = %ip);
        return err_response("Set DB_SETUP_TOKEN before creating the admin account from another machine");
    }
    let res = cfg.setup_admin(&email, &password, token.as_deref());
    drop(cfg); // never call session_ttl/session_cookie while holding the config lock (std Mutex is not reentrant)
    match res {
        Ok(()) => {
            state.auth.limiter.clear(&ip);
            let token = match state.auth.sessions.create(state.auth.session_ttl()) {
                Ok(token) => token,
                Err(e) => {
                    tracing::error!(event = "auth_setup_failure", reason = "session_creation", client_ip = %ip);
                    return err_response(&e);
                }
            };
            tracing::info!(event = "auth_setup_success", client_ip = %ip);
            (
                StatusCode::OK,
                [(header::SET_COOKIE, session_cookie(&state.auth, &token, &headers))],
                Json(json!({ "result": "null" })),
            )
                .into_response()
        }
        Err(e) => {
            tracing::warn!(event = "auth_setup_failure", reason = "validation", client_ip = %ip);
            err_response(&e)
        }
    }
}
