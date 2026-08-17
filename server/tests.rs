// API integration tests (moved out of main).
use super::*;
use crate::{ai, probe, handlers, httpm, cmds, auth_routes};
#[cfg(test)]
mod api_tests {
    use super::*;

    #[test]
    fn custom_config_from_resolves_env_override() {
        let get = |k: &str| -> Option<String> {
            match k {
                "DB_OPENAI_COMPAT_BASE_URL" => Some("https://x.example/v1".into()),
                "DB_OPENAI_COMPAT_API_KEY" => Some("sk-env".into()),
                _ => None,
            }
        };
        let cfg = probe::custom_config_from(&get).expect("base url set");
        assert_eq!(cfg.0, "https://x.example/v1");
        assert_eq!(cfg.1.as_deref(), Some("sk-env"));
        assert_eq!(cfg.2, None);
        // no env → no override (backward compat)
        assert!(probe::custom_config_from(&|_| None).is_none());
    }

    use axum::body::Body;
    use axum::extract::connect_info::MockConnectInfo;
    use axum::http::{header, HeaderMap, Request, StatusCode};
    use std::net::SocketAddr;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tower::ServiceExt;

    /** Fresh AppState per test: isolated config/sessions/limiter, unique temp
     *  dir (nanos suffix — no {pid}-only collision), no env seeding. */
    fn test_state() -> AppState {
        let dir = std::env::temp_dir().join(format!(
            "db-api-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        AppState {
            vault: Arc::new(Mutex::new(None)),
            wiki: Arc::new(Mutex::new(None)),
            git: Arc::new(Mutex::new(None)),
            ai_cancel: Arc::new(AtomicBool::new(false)),
            auth: Arc::new(AuthState::new(&dir)),
            data_dir: dir,
        }
    }

    fn router() -> (Router, std::path::PathBuf) {
        let state = test_state();
        let data_dir = state.data_dir.clone();
        // www_dir: temp — static files are never requested in API tests.
        (build_router(state, std::env::temp_dir()), data_dir)
    }

    async fn post_with(
        app: &Router,
        path: &str,
        body: Value,
        cookie: Option<&str>,
    ) -> (StatusCode, HeaderMap, String) {
        let mut builder = Request::builder()
            .method("POST")
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(c) = cookie {
            builder = builder.header(header::COOKIE, c);
        }
        // MockConnectInfo: oneshot has no transport — inject a fixed client IP
        // so ConnectInfo extraction (rate limiting) sees a consistent source.
        let app = app
            .clone()
            .layer(MockConnectInfo(SocketAddr::from(([127, 0, 0, 1], 0))));
        let resp = app
            .oneshot(builder.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, headers, String::from_utf8_lossy(&bytes).to_string())
    }

    async fn post(app: &Router, path: &str, body: Value) -> (StatusCode, HeaderMap, String) {
        post_with(app, path, body, None).await
    }

    async fn get(app: &Router, path: &str) -> (StatusCode, HeaderMap, String) {
        let app = app
            .clone()
            .layer(MockConnectInfo(SocketAddr::from(([127, 0, 0, 1], 0))));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, headers, String::from_utf8_lossy(&bytes).to_string())
    }

    /** Commands return JSON-serialized strings wrapped in {"result": "..."}. */
    fn result_json(body: &str) -> Value {
        let outer: Value = serde_json::from_str(body).expect("outer json");
        serde_json::from_str(outer["result"].as_str().expect("result string")).expect("inner json")
    }

    #[tokio::test]
    async fn health_ok() {
        let (app, _) = router();
        let (status, _, body) = get(&app, "/api/health").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(result_json(&body)["vaultOpen"], false, "{body}");
    }

    #[tokio::test]
    async fn setup_status_reflects_no_admin() {
        let (app, _) = router();
        let (status, _, body) = post(&app, "/api/setup_status", json!({})).await;
        assert_eq!(status, StatusCode::OK);
        let v = result_json(&body);
        assert_eq!(v["setupRequired"], true, "{body}");
        assert_eq!(v["setupToken"], false, "{body}");
    }

    #[tokio::test]
    async fn setup_admin_creates_admin_and_cookie() {
        let (app, _) = router();
        let (s, h, b) = post(
            &app,
            "/api/setup_admin",
            json!({"email": "a@b.c", "password": "password1"}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{b}");
        let cookie = h
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .map(|c| c.to_string());
        assert!(
            cookie.is_some_and(|c| c.starts_with("db_session=")),
            "session cookie set: {h:?}"
        );

        // second admin rejected
        let (s, _, _) = post(
            &app,
            "/api/setup_admin",
            json!({"email": "x@y.z", "password": "password1"}),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        // setup status now false
        let (_, _, b) = post(&app, "/api/setup_status", json!({})).await;
        assert_eq!(result_json(&b)["setupRequired"], false, "{b}");
    }

    #[tokio::test]
    async fn setup_admin_token_required_via_http() {
        let state = test_state();
        state.auth.config.lock().unwrap().setup_token = Some("tok-secret-1".to_string());
        let app = build_router(state, std::env::temp_dir());

        // wizard sees the token field
        let (_, _, b) = post(&app, "/api/setup_status", json!({})).await;
        assert_eq!(result_json(&b)["setupToken"], true, "{b}");

        // missing / wrong token → rejected, admin never created
        for token in [None, Some("wrong")] {
            let body = match token {
                Some(t) => json!({"email": "a@b.c", "password": "password1", "token": t}),
                None => json!({"email": "a@b.c", "password": "password1"}),
            };
            let (s, _, _) = post(&app, "/api/setup_admin", body).await;
            assert_eq!(
                s,
                StatusCode::BAD_REQUEST,
                "token={token:?} must be rejected"
            );
        }
        let (_, _, b) = post(&app, "/api/setup_status", json!({})).await;
        assert_eq!(
            result_json(&b)["setupRequired"],
            true,
            "admin must not exist: {b}"
        );

        // correct token → created + session cookie
        let (s, h, b) = post(
            &app,
            "/api/setup_admin",
            json!({"email": "a@b.c", "password": "password1", "token": "tok-secret-1"}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{b}");
        assert!(h.get(header::SET_COOKIE).is_some());
    }

    #[tokio::test]
    async fn setup_admin_rate_limited_after_6_failures() {
        let (app, _) = router();
        // Limiter blocks when count > MAX_ATTEMPTS(5) — 6 bad requests pass,
        // the 7th is rate-limited (429). Matches auth.rs limiter semantics.
        for i in 0..7 {
            // invalid email "x" → 400 + limiter.fail; 7th must be blocked
            let (s, _, _) = post(
                &app,
                "/api/setup_admin",
                json!({"email": "x", "password": "password1"}),
            )
            .await;
            if i < 6 {
                assert_eq!(s, StatusCode::BAD_REQUEST, "attempt {i}");
            } else {
                assert_eq!(s, StatusCode::TOO_MANY_REQUESTS, "attempt {i} must 429");
            }
        }
    }

    #[tokio::test]
    async fn login_flow_sets_session_cookie() {
        let (app, _) = router();
        let (s, _, _) = post(
            &app,
            "/api/setup_admin",
            json!({"email": "a@b.c", "password": "password1"}),
        )
        .await;
        assert_eq!(s, StatusCode::OK);

        // wrong password → 400
        let (s, _, _) = post(
            &app,
            "/api/login",
            json!({"email": "a@b.c", "password": "wrongpass"}),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);

        // correct → 200 + session cookie
        let (s, h, b) = post(
            &app,
            "/api/login",
            json!({"email": "a@b.c", "password": "password1"}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{b}");
        assert!(h
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|c| c.starts_with("db_session=")));
    }

    #[tokio::test]
    async fn login_rate_limited_after_6_failures() {
        let (app, _) = router();
        let (s, _, _) = post(
            &app,
            "/api/setup_admin",
            json!({"email": "a@b.c", "password": "password1"}),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        for i in 0..7 {
            let (s, _, _) = post(
                &app,
                "/api/login",
                json!({"email": "a@b.c", "password": "wrongpass"}),
            )
            .await;
            if i < 6 {
                assert_eq!(s, StatusCode::BAD_REQUEST, "attempt {i}");
            } else {
                assert_eq!(s, StatusCode::TOO_MANY_REQUESTS, "attempt {i} must 429");
            }
        }
    }

    #[tokio::test]
    async fn protected_api_requires_session_after_admin() {
        let (app, _) = router();
        let (s, _, _) = post(
            &app,
            "/api/setup_admin",
            json!({"email": "a@b.c", "password": "password1"}),
        )
        .await;
        assert_eq!(s, StatusCode::OK);

        // no cookie → 401 on protected command
        let (s, _, b) = post(&app, "/api/web_vault_root", json!({})).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED, "{b}");
        // setup_status stays public
        let (s, _, _) = post(&app, "/api/setup_status", json!({})).await;
        assert_eq!(s, StatusCode::OK);
    }

    #[tokio::test]
    async fn path_allowlist_blocks_escape_via_api() {
        let (app, data_dir) = router();
        let (s, h, _) = post(
            &app,
            "/api/setup_admin",
            json!({"email": "a@b.c", "password": "password1"}),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let cookie = h
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();

        // absolute path outside data dir → blocked
        let (s, _, b) = post_with(
            &app,
            "/api/open_vault",
            json!({"path": "/etc"}),
            Some(&cookie),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{b}");
        assert!(b.contains("outside"), "{b}");

        // traversal that resolves outside → blocked
        let escape = format!("{}/../etc", data_dir.display());
        let (s, _, _) = post_with(
            &app,
            "/api/open_vault",
            json!({"path": escape}),
            Some(&cookie),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);

        // legit vault inside data dir → allowed
        let vault = data_dir.join("vaults").join("ok");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::write(vault.join("a.md"), "# hi").unwrap();
        let (s, _, b) = post_with(
            &app,
            "/api/open_vault",
            json!({"path": format!("{}/vaults/ok", data_dir.display())}),
            Some(&cookie),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{b}");
    }
}

