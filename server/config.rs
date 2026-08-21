//! Server config — merged from three sources, file-style precedence:
//!   env var > /data/config.json (UI-written overrides) > default.
//!
//! config.json lives in the data dir next to vaults/ and keys.json — purely
//! additive, so existing deployments upgrade without touching anything.
//!
//! Env vars (boot-time, win over config.json):
//!   DB_ADMIN_EMAIL + DB_ADMIN_PASSWORD  → auto-create admin on first boot
//!     (env-based headless provisioning; BOTH required)
//!   DB_NO_AUTH=1                        → force open access (old behavior)
//!   DB_SESSION_TTL_HOURS                → session lifetime
//!   DB_SECURE_COOKIE=1                  → set Secure flag on session cookie


use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[derive(Clone)]
pub struct Admin {
    pub email: String,
    pub password_hash: String,
}

#[derive(Clone)]
pub struct Config {
    pub admin: Option<Admin>,
    pub no_auth: bool,
    pub session_ttl_hours: u64,
    pub setup_token: Option<String>,
    path: PathBuf,
}

impl Config {
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join("config.json");
        if !path.exists() {
            tracing::info!(event = "config_missing");
        }
        let mut c = Self::from_file(&path);

        // Env seeding — first boot provisioning (both values required).
        let env_email = std::env::var("DB_ADMIN_EMAIL").ok();
        let env_pass = std::env::var("DB_ADMIN_PASSWORD").ok();
        if c.admin.is_none() {
            if let (Some(email), Some(pass)) = (&env_email, &env_pass) {
                if !email.is_empty() && !pass.is_empty() {
                    if let Ok(hash) = super::auth::hash_password(pass) {
                        c.admin = Some(Admin { email: email.clone(), password_hash: hash });
                        let _ = c.save();
                        tracing::info!(event = "auth_setup_success", source = "environment");
                    }
                }
            }
        }
        // Env wins over config.json.
        if let Ok(v) = std::env::var("DB_NO_AUTH") {
            c.no_auth = v == "1" || v.eq_ignore_ascii_case("true");
        }
        if let Ok(v) = std::env::var("DB_SESSION_TTL_HOURS") {
            if let Ok(n) = v.parse::<u64>() {
                if n > 0 {
                    c.session_ttl_hours = n;
                }
            }
        }
        c
    }

    fn from_file(path: &Path) -> Self {
        let raw = std::fs::read_to_string(path).unwrap_or_default();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
        let admin = v.get("admin").and_then(|a| a.as_object()).map(|a| Admin {
            email: a.get("email").and_then(|e| e.as_str()).unwrap_or("").to_string(),
            password_hash: a.get("password_hash").and_then(|e| e.as_str()).unwrap_or("").to_string(),
        });
        let no_auth = v.get("no_auth").and_then(|x| x.as_bool()).unwrap_or(false);
        let session_ttl_hours = v.get("session_ttl_hours").and_then(|x| x.as_u64()).unwrap_or(168);
        // Env-only, never persisted: optional setup guard for public deployments.
        let setup_token = std::env::var("DB_SETUP_TOKEN").ok().filter(|s| !s.is_empty());
        if setup_token.is_none() {
            tracing::warn!(event = "setup_token_missing");
        }
        Self { admin, no_auth, session_ttl_hours, setup_token, path: path.to_path_buf() }
    }

    pub fn save(&self) -> Result<(), String> {
        let v = serde_json::json!({
            "admin": self.admin.as_ref().map(|a| serde_json::json!({
                "email": a.email,
                "password_hash": a.password_hash,
                "created_at": chrono_now(),
            })),
            "no_auth": self.no_auth,
            "session_ttl_hours": self.session_ttl_hours,
        });
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create {}: {}", parent.display(), e))?;
        }
        std::fs::write(&self.path, serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Cannot write {}: {} — check the /data volume ownership", self.path.display(), e))?;
        #[cfg(unix)]
        let _ = std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600));
        Ok(())
    }

    /** Create the admin account (wizard). Fails if one already exists, or if a
     *  setup token is configured (DB_SETUP_TOKEN) and the caller does not present it.
     *  Backward compatible: no token env → no token required (pre-fix behavior). */
    pub fn setup_admin(&mut self, email: &str, password: &str, token: Option<&str>) -> Result<(), String> {
        if self.admin.is_some() {
            return Err("Admin account already exists".into());
        }
        if let Some(expected) = &self.setup_token {
            if token != Some(expected.as_str()) {
                return Err("Invalid setup token — check the server logs / DB_SETUP_TOKEN env".into());
            }
        }
        if email.is_empty() || !email.contains('@') {
            return Err("Enter a valid email address".into());
        }
        if password.len() < 8 {
            return Err("Password must be at least 8 characters".into());
        }
        let hash = super::auth::hash_password(password)?;
        self.admin = Some(Admin { email: email.trim().to_lowercase(), password_hash: hash });
        self.save()
    }

    pub fn change_password(&mut self, old: &str, new: &str) -> Result<(), String> {
        // admin must exist before a password can change (guard, not unwrap)
        let existing = self.admin.as_ref().ok_or("No admin account")?;
        if !super::auth::verify_password(&existing.password_hash, old) {
            return Err("Current password is incorrect".into());
        }
        if new.len() < 8 {
            return Err("New password must be at least 8 characters".into());
        }
        let hash = super::auth::hash_password(new)?;
        // admin is guaranteed Some above; write without unwrap so this can't
        // panic even if the guard ever changes
        if let Some(admin) = self.admin.as_mut() {
            admin.password_hash = hash;
        }
        self.save()
    }

    /** Apply a UI override. Only UI_KEYS are accepted. */
    pub fn set(&mut self, key: &str, value: &serde_json::Value) -> Result<(), String> {
        match key {
            "no_auth" => {
                let v = value.as_bool().ok_or("no_auth must be a boolean")?;
                // No admin-guard here: "Skip — keep open access" from the setup
                // wizard runs on a FRESH install where no admin exists yet, and
                // disabling it with no admin can't lock anyone out either
                // (setup_required bypasses auth until an admin is created).
                self.no_auth = v;
            }
            "session_ttl_hours" => {
                let n = value.as_u64().ok_or("session_ttl_hours must be a number")?;
                if !(1..=8760).contains(&n) {
                    return Err("session_ttl_hours must be 1–8760".into());
                }
                self.session_ttl_hours = n;
            }
            _ => return Err(format!("Unknown config key: {key}")),
        }
        self.save()
    }

    /** Effective config + source for the dashboard (env values are read-only). */
    pub fn view(&self, data_dir: &Path) -> serde_json::Value {
        let env_no_auth = std::env::var("DB_NO_AUTH").ok();
        let env_ttl = std::env::var("DB_SESSION_TTL_HOURS").ok();
        let source = |env: Option<String>| if env.is_some() { "env" } else { "file" };
        serde_json::json!({
            "admin": self.admin.as_ref().map(|a| serde_json::json!({ "email": a.email })),
            "no_auth": { "value": self.no_auth, "source": source(env_no_auth) },
            "session_ttl_hours": { "value": self.session_ttl_hours, "source": source(env_ttl) },
            "boot": {
                "port": std::env::var("PORT").unwrap_or_else(|_| "8080".into()),
                "data_dir": data_dir.to_string_lossy(),
                "www_dir": std::env::var("WWW_DIR").unwrap_or_else(|_| "./dist".into()),
            },
        })
    }
}

/** Timestamp without pulling chrono — RFC3339-ish for the config file. */
fn chrono_now() -> String {
    let s = std::process::Command::new("date").arg("-u").arg("+%Y-%m-%dT%H:%M:%SZ").output();
    match s {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
}

/** Convenience handle: config + sessions + limiter behind one Mutex-free split. */
pub struct AuthState {
    pub config: Mutex<Config>,
    pub sessions: super::auth::Sessions,
    pub limiter: super::auth::LoginLimiter,
    pub secure_cookie: bool,
}

impl AuthState {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            config: Mutex::new(Config::load(data_dir)),
            sessions: super::auth::Sessions::new(data_dir),
            limiter: super::auth::LoginLimiter::new(),
            secure_cookie: std::env::var("DB_SECURE_COOKIE").ok().is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true")),
        }
    }

    pub fn session_ttl(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.config.lock().expect("lock").session_ttl_hours * 3600)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("db-config-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn setup_and_set_roundtrip() {
        let dir = tmp();
        let mut c = Config::load(&dir);
        assert!(c.admin.is_none());
        c.setup_admin("a@b.c", "password1", None).unwrap();
        assert!(c.admin.is_some());
        assert!(c.setup_admin("x@y.z", "password2", None).is_err(), "second admin must fail");
        assert!(c.change_password("wrong", "newpass1").is_err());
        c.change_password("password1", "newpass1").unwrap();

        // reload from disk
        let c2 = Config::load(&dir);
        assert!(c2.admin.is_some());
        assert!(super::super::auth::verify_password(&c2.admin.unwrap().password_hash, "newpass1"));
        let _ = std::fs::remove_file(dir.join("config.json"));
    }

    #[test]
    fn no_auth_allowed_without_admin() {
        // "Skip for now — keep open access" on a fresh install: no admin yet,
        // but enabling no_auth must succeed and persist.
        let dir = tmp();
        let mut c = Config::load(&dir);
        assert!(c.admin.is_none());
        c.set("no_auth", &serde_json::json!(true)).unwrap();
        assert!(c.no_auth);
        let c2 = Config::load(&dir);
        assert!(c2.no_auth, "no_auth must persist to disk");
        let _ = std::fs::remove_file(dir.join("config.json"));
    }

    #[test]
    fn setup_admin_token_gate() {
        // Backward compatible: no DB_SETUP_TOKEN → no token required.
        let dir = tmp();
        let mut no_tok = Config {
            admin: None,
            no_auth: false,
            session_ttl_hours: 24,
            setup_token: None,
            path: dir.join("c1.json"),
        };
        no_tok.setup_admin("a@b.c", "password1", None).unwrap();
        assert!(no_tok.admin.is_some());

        // Token configured → missing/wrong token rejected, admin NOT created,
        // correct token accepted. (Setup wizard could never complete when
        // DB_SETUP_TOKEN was set; pre-auth claim must be token-gated.)
        let mut tok = Config {
            admin: None,
            no_auth: false,
            session_ttl_hours: 24,
            setup_token: Some("tok-secret-1".into()),
            path: dir.join("c2.json"),
        };
        assert!(tok.setup_admin("a@b.c", "password1", None).is_err(), "missing token must be rejected");
        assert!(tok.setup_admin("a@b.c", "password1", Some("wrong")).is_err(), "wrong token must be rejected");
        assert!(tok.admin.is_none(), "admin must not be created on failed attempts");
        tok.setup_admin("a@b.c", "password1", Some("tok-secret-1")).unwrap();
        assert!(tok.admin.is_some());
        let _ = std::fs::remove_file(dir.join("c1.json"));
        let _ = std::fs::remove_file(dir.join("c2.json"));
    }

    #[test]
    fn set_ui_keys_validation() {
        let dir = tmp();
        let mut c = Config::load(&dir);
        assert!(c.set("no_auth", &serde_json::json!(true)).is_ok(), "no_auth allowed before admin (skip flow)");
        c.setup_admin("a@b.c", "password1", None).unwrap();
        c.set("no_auth", &serde_json::json!(true)).unwrap();
        assert!(c.no_auth);
        assert!(c.set("no_auth", &serde_json::json!("yes")).is_err());
        assert!(c.set("session_ttl_hours", &serde_json::json!(0)).is_err());
        c.set("session_ttl_hours", &serde_json::json!(24)).unwrap();
        assert_eq!(c.session_ttl_hours, 24);
        assert!(c.set("port", &serde_json::json!(1)).is_err());
        let _ = std::fs::remove_file(dir.join("config.json"));
    }
}
