//! Server config — merged from three sources, file-style precedence:
//!   env var > /data/config.json (UI-written overrides) > default.
//!
//! config.json lives in the data dir next to vaults/ and keys.json — purely
//! additive, so existing deployments upgrade without touching anything.
//!
//! Env vars (boot-time, win over config.json):
//!   DB_ADMIN_EMAIL + DB_ADMIN_PASSWORD  → auto-create admin on first boot
//!     (env-based headless provisioning; BOTH required)
//!   DB_SESSION_TTL_HOURS                → session lifetime
//!   DB_SECURE_COOKIE=1                  → set Secure flag on session cookie

use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_PROBE_PROVIDERS: usize = 32;
const MAX_PROBE_MODELS_PER_PROVIDER: usize = 128;
const MAX_PROBE_ID_LEN: usize = 256;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[derive(Clone)]
pub struct Admin {
    pub email: String,
    pub password_hash: String,
}

/** Which provider/model the AI panel uses — selection only, never credentials.
 *  Lives here rather than in keys.json so it survives `clear site data` and a
 *  browser/device switch, and is readable without DB_KEYS_PASSPHRASE. */
#[derive(Clone, Default)]
pub struct AiSelection {
    pub provider: String,
    pub model: String,
    /** Measured tool-call support per provider → model → supports tools, from the
     *  test_connection probe. Non-secret and expensive to re-measure (one extra
     *  round-trip per model), so it is persisted here rather than in localStorage:
     *  a new browser would otherwise run text-only until each model re-probed. */
    pub probes: std::collections::BTreeMap<String, std::collections::BTreeMap<String, bool>>,
}

#[derive(Clone)]
pub struct Config {
    pub admin: Option<Admin>,
    pub session_ttl_hours: u64,
    pub ai: AiSelection,
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
        let session_ttl_hours = v.get("session_ttl_hours").and_then(|x| x.as_u64()).unwrap_or(168);
        let ai = v.get("ai").map(|a| AiSelection {
            provider: a.get("provider").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            model: a.get("model").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            probes: parse_probes(a.get("probes")),
        }).unwrap_or_default();
        // Env-only, never persisted: optional setup guard for public deployments.
        let setup_token = std::env::var("DB_SETUP_TOKEN").ok().filter(|s| !s.is_empty());
        if setup_token.is_none() {
            tracing::warn!(event = "setup_token_missing");
        }
        Self { admin, session_ttl_hours, ai, setup_token, path: path.to_path_buf() }
    }

    pub fn save(&self) -> Result<(), String> {
        let v = serde_json::json!({
            "admin": self.admin.as_ref().map(|a| serde_json::json!({
                "email": a.email,
                "password_hash": a.password_hash,
                "created_at": chrono_now(),
            })),
            "session_ttl_hours": self.session_ttl_hours,
            "ai": {
                "provider": self.ai.provider,
                "model": self.ai.model,
                "probes": self.ai.probes,
            },
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

    /** Record which provider/model the UI selected. `model` may be empty while a
     *  longer key is being entered; the provider is always saved so the selection
     *  survives a browser/device change. */
    pub fn set_ai(&mut self, provider: &str, model: &str) -> Result<(), String> {
        self.ai.provider = provider.to_string();
        self.ai.model = model.to_string();
        self.save()
    }

    /** Record a measured probe outcome (provider → model → supports tools). Merged
     *  into the existing map so a probe for one model never drops the others. */
    pub fn set_probe(&mut self, provider: &str, model: &str, tools: bool) -> Result<(), String> {
        self.merge_probe(provider, model, tools)?;
        self.save()
    }

    /** Mutation without the write, so a bulk probe sync is one file write instead
     *  of one per model. Callers own the `save()` call. */
    pub fn merge_probe(&mut self, provider: &str, model: &str, tools: bool) -> Result<(), String> {
        if provider.is_empty() || model.is_empty() {
            return Err("Provider and model are required for a probe result".into());
        }
        if provider.len() > MAX_PROBE_ID_LEN || model.len() > MAX_PROBE_ID_LEN {
            return Err(format!("Provider and model IDs must be at most {MAX_PROBE_ID_LEN} bytes"));
        }
        if !self.ai.probes.contains_key(provider) && self.ai.probes.len() >= MAX_PROBE_PROVIDERS {
            return Err(format!("At most {MAX_PROBE_PROVIDERS} probe providers are supported"));
        }
        let models = self.ai.probes.entry(provider.to_string()).or_default();
        if !models.contains_key(model) && models.len() >= MAX_PROBE_MODELS_PER_PROVIDER {
            return Err(format!("At most {MAX_PROBE_MODELS_PER_PROVIDER} models per provider are supported"));
        }
        models.insert(model.to_string(), tools);
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
        let env_ttl = std::env::var("DB_SESSION_TTL_HOURS").ok();
        let source = |env: Option<String>| if env.is_some() { "env" } else { "file" };
        serde_json::json!({
            "admin": self.admin.as_ref().map(|a| serde_json::json!({ "email": a.email })),
            "session_ttl_hours": { "value": self.session_ttl_hours, "source": source(env_ttl) },
            "boot": {
                "port": std::env::var("PORT").unwrap_or_else(|_| "8080".into()),
                "data_dir": data_dir.to_string_lossy(),
                "www_dir": std::env::var("WWW_DIR").unwrap_or_else(|_| "./dist".into()),
            },
        })
    }
}

/** Decode the persisted probe map, ignoring anything malformed: a hand-edited or
 *  older config.json must never fail to load over a non-essential cache. */
fn parse_probes(
    value: Option<&serde_json::Value>,
) -> std::collections::BTreeMap<String, std::collections::BTreeMap<String, bool>> {
    let mut out = std::collections::BTreeMap::new();
    let Some(obj) = value.and_then(|v| v.as_object()) else {
        return out;
    };
    for (provider, models) in obj {
        let Some(models) = models.as_object() else { continue };
        let entries: std::collections::BTreeMap<String, bool> = models
            .iter()
            .filter_map(|(model, tools)| tools.as_bool().map(|t| (model.clone(), t)))
            .collect();
        if !entries.is_empty() {
            out.insert(provider.clone(), entries);
        }
    }
    out
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
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TMP: AtomicUsize = AtomicUsize::new(0);

    fn tmp() -> std::path::PathBuf {
        let id = NEXT_TMP.fetch_add(1, Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!("db-config-test-{}-{id}", std::process::id()));
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
    fn setup_admin_token_gate() {
        // Backward compatible: no DB_SETUP_TOKEN → no token required.
        let dir = tmp();
        let mut no_tok = Config {
            admin: None,
            session_ttl_hours: 24,
            ai: AiSelection::default(),
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
            session_ttl_hours: 24,
            ai: AiSelection::default(),
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
    fn ai_selection_persists_across_reload() {
        // The point of storing this server-side: a new browser or device must be
        // able to read back the provider/model that localStorage lost.
        let dir = tmp();
        let mut c = Config::load(&dir);
        assert_eq!(c.ai.provider, "", "fresh config starts unselected");
        c.set_ai("anthropic", "claude-sonnet-5").unwrap();

        let reloaded = Config::load(&dir);
        assert_eq!(reloaded.ai.provider, "anthropic");
        assert_eq!(reloaded.ai.model, "claude-sonnet-5");
        let _ = std::fs::remove_file(dir.join("config.json"));
    }

    #[test]
    fn ai_probes_persist_across_reload_and_merge() {
        // Re-probing costs a network round-trip per model, so a fresh browser must
        // read the results back instead of re-measuring (and running text-only
        // until each probe lands).
        let dir = tmp();
        let mut c = Config::load(&dir);
        assert!(c.ai.probes.is_empty(), "fresh config starts unprobed");
        c.set_probe("anthropic", "claude-sonnet-5", true).unwrap();
        c.set_probe("anthropic", "claude-haiku-5", false).unwrap();

        let reloaded = Config::load(&dir);
        assert!(reloaded.ai.probes["anthropic"]["claude-sonnet-5"]);
        assert!(!reloaded.ai.probes["anthropic"]["claude-haiku-5"]);

        // Merging: a later probe must not drop the other models, and writing the
        // selection must not drop the probes either.
        let mut c2 = Config::load(&dir);
        c2.set_probe("anthropic", "claude-opus-5", true).unwrap();
        c2.set_ai("openai-compatible", "local-1").unwrap();
        let c3 = Config::load(&dir);
        assert_eq!(c3.ai.probes["anthropic"].len(), 3, "probes must merge, not replace");
        assert_eq!(c3.ai.provider, "openai-compatible");
        let _ = std::fs::remove_file(dir.join("config.json"));
    }

    #[test]
    fn probe_limits_reject_unbounded_entries() {
        let dir = tmp();
        let mut c = Config::load(&dir);
        assert!(c.merge_probe(&"p".repeat(MAX_PROBE_ID_LEN + 1), "m", true).is_err());
        assert!(c.merge_probe("p", &"m".repeat(MAX_PROBE_ID_LEN + 1), true).is_err());

        for i in 0..MAX_PROBE_MODELS_PER_PROVIDER {
            c.merge_probe("p", &format!("m-{i}"), true).unwrap();
        }
        assert!(c.merge_probe("p", "one-too-many", true).is_err());
        let _ = std::fs::remove_file(dir.join("config.json"));
    }

    #[test]
    fn malformed_probes_do_not_break_config_load() {
        // A cache must never take the config down with it: non-bool values and
        // non-object providers are dropped rather than failing the parse.
        let dir = tmp();
        std::fs::write(
            dir.join("config.json"),
            r#"{"ai":{"provider":"anthropic","model":"m","probes":{"a":{"ok":true,"bad":"yes"},"b":7}}}"#,
        )
        .unwrap();
        let c = Config::load(&dir);
        assert_eq!(c.ai.provider, "anthropic");
        assert!(c.ai.probes["a"]["ok"]);
        assert_eq!(c.ai.probes["a"].len(), 1, "non-bool entry dropped");
        assert!(!c.ai.probes.contains_key("b"), "non-object provider dropped");
        let _ = std::fs::remove_file(dir.join("config.json"));
    }

    #[test]
    fn missing_ai_block_does_not_break_existing_config() {
        // A config.json written before this field existed must still load.
        let dir = tmp();
        std::fs::write(dir.join("config.json"), r#"{"session_ttl_hours":48}"#).unwrap();
        let c = Config::load(&dir);
        assert_eq!(c.session_ttl_hours, 48);
        assert_eq!(c.ai.provider, "");
        let _ = std::fs::remove_file(dir.join("config.json"));
    }

    #[test]
    fn set_ui_keys_validation() {
        let dir = tmp();
        let mut c = Config::load(&dir);
        assert!(c.set("session_ttl_hours", &serde_json::json!(0)).is_err());
        c.set("session_ttl_hours", &serde_json::json!(24)).unwrap();
        assert_eq!(c.session_ttl_hours, 24);
        assert!(c.set("port", &serde_json::json!(1)).is_err());
        let _ = std::fs::remove_file(dir.join("config.json"));
    }
}
