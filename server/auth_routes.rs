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

pub(crate) fn session_cookie(state: &AuthState, token: &str) -> String {
    let ttl = state.config.lock().expect("lock").session_ttl_hours * 3600;
    let secure = if state.secure_cookie { "; Secure" } else { "" };
    format!("db_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={ttl}{secure}")
}

pub(crate) async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
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
    if !admin.email.eq_ignore_ascii_case(&email)
        || !auth::verify_password(&admin.password_hash, &password)
    {
        state.auth.limiter.fail(&ip);
        return err_response("Invalid email or password");
    }
    state.auth.limiter.clear(&ip);
    let token = match state.auth.sessions.create(state.auth.session_ttl()) {
        Ok(token) => token,
        Err(e) => return err_response(&e),
    };
    (
        StatusCode::OK,
        [(header::SET_COOKIE, session_cookie(&state.auth, &token))],
        Json(json!({ "result": "null" })),
    )
        .into_response()
}

pub(crate) async fn logout(State(state): State<AppState>, req: Request) -> Response {
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
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": e }))).into_response();
    }
    let mut cfg = state.auth.config.lock().expect("lock");
    let res = cfg.setup_admin(&email, &password, token.as_deref());
    drop(cfg); // never call session_ttl/session_cookie while holding the config lock (std Mutex is not reentrant)
    match res {
        Ok(()) => {
            state.auth.limiter.clear(&ip);
            let token = match state.auth.sessions.create(state.auth.session_ttl()) {
                Ok(token) => token,
                Err(e) => return err_response(&e),
            };
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
