//! Account auth for the web build — one admin per server (personal server
//! model, same persona as the desktop app).
//!
//! - Passwords: Argon2id (pure-Rust crate, constant-time verify).
//! - Sessions: random 32-byte token in an httpOnly cookie `db_session`
//!   (SameSite=Strict). Sessions persist across restarts in
//!   `sessions.json` (0600) keyed by SHA-256 of the token — a file leak
//!   does not yield usable tokens. Expiry is absolute (session_ttl_hours).
//! - Login rate limit: 6 failed attempts / 60 s per client IP, blocked on the
//!   7th (count > MAX_ATTEMPTS) — in-memory.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};

use argon2::Argon2;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

pub fn hash_password(pw: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(pw.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

pub fn verify_password(hash: &str, pw: &str) -> bool {
    PasswordHash::new(hash)
        .map(|h| Argon2::default().verify_password(pw.as_bytes(), &h).is_ok())
        .unwrap_or(false)
}

pub struct Sessions {
    map: Mutex<HashMap<String, SystemTime>>, // sha256(token) → expiry
    base_dir: PathBuf,
    path: PathBuf,
}

impl Sessions {
    pub fn new(data_dir: &Path) -> Self {
        let _ = std::fs::create_dir_all(data_dir);
        let base_dir = data_dir
            .canonicalize()
            .unwrap_or_else(|_| data_dir.to_path_buf());
        let path = base_dir.join("sessions.json");

        let mut map = HashMap::new();
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<HashMap<String, u64>>(&raw) {
                for (hash, secs) in v {
                    if let Some(t) = UNIX_EPOCH.checked_add(Duration::from_secs(secs)) {
                        map.insert(hash, t);
                    }
                }
            }
        }
        Self {
            map: Mutex::new(map),
            base_dir,
            path,
        }
    }

    fn persist(&self, map: &HashMap<String, SystemTime>) {
        let out: HashMap<String, u64> = map
            .iter()
            .map(|(h, t)| {
                (
                    h.clone(),
                    t.duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                )
            })
            .collect();
        if let Ok(json) = serde_json::to_string_pretty(&out) {
            if !self.path.starts_with(&self.base_dir) {
                return;
            }
            if let Some(p) = self.path.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            if std::fs::write(&self.path, json).is_ok() {
                #[cfg(unix)]
                let _ =
                    std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600));
            }
        }
    }

    /** Deterministic hash of the token — random 256-bit secrets, SHA-256 is
     *  the right primitive (argon2's random salt would break lookup). */
    fn hash(token: &str) -> String {
        format!("{:x}", Sha256::digest(token.as_bytes()))
    }

    pub fn create(&self, ttl: Duration) -> Result<String, String> {
        let mut bytes: [u8; 32] = Default::default();
        getrandom::getrandom(&mut bytes).map_err(|e| format!("session entropy failed: {e}"))?;
        let token = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let mut map = self.map.lock().expect("lock");
        map.insert(Self::hash(&token), SystemTime::now() + ttl);
        self.persist(&map);
        Ok(token)
    }

    pub fn valid(&self, token: &str, _ttl: Duration) -> bool {
        let mut map = self.map.lock().expect("lock");
        let now = SystemTime::now();
        let before = map.len();
        map.retain(|_, expires| *expires > now);
        if map.len() != before {
            self.persist(&map);
        }
        map.contains_key(&Self::hash(token))
    }

    pub fn revoke(&self, token: &str) {
        let mut map = self.map.lock().expect("lock");
        if map.remove(&Self::hash(token)).is_some() {
            self.persist(&map);
        }
    }

    pub fn revoke_all(&self) {
        let mut map = self.map.lock().expect("lock");
        map.clear();
        self.persist(&map);
    }
}

pub struct LoginLimiter {
    map: Mutex<HashMap<String, (u32, Instant)>>,
}

const MAX_ATTEMPTS: u32 = 5;
const LOCKOUT: Duration = Duration::from_secs(60);

impl LoginLimiter {
    pub fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }

    pub fn check(&self, ip: &str) -> Result<(), String> {
        let mut map = self.map.lock().expect("lock");
        let now = Instant::now();
        map.retain(|_, (_, until)| *until > now);
        if let Some((count, until)) = map.get(ip) {
            if *count > MAX_ATTEMPTS && *until > now {
                return Err("Too many attempts — try again in a minute".into());
            }
        }
        Ok(())
    }

    pub fn fail(&self, ip: &str) {
        let mut map = self.map.lock().expect("lock");
        let e = map
            .entry(ip.to_string())
            .or_insert((0, Instant::now() + LOCKOUT));
        e.0 += 1;
        if e.0 > MAX_ATTEMPTS {
            e.1 = Instant::now() + LOCKOUT;
        }
    }

    pub fn clear(&self, ip: &str) {
        self.map.lock().expect("lock").remove(ip);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "db-auth-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn password_roundtrip() {
        let h = hash_password("hunter2!").unwrap();
        assert!(verify_password(&h, "hunter2!"));
        assert!(!verify_password(&h, "hunter2?"));
    }

    #[test]
    fn sessions_create_and_validate() {
        let s = Sessions::new(&tmp());
        let ttl = Duration::from_secs(3600);
        let t = s.create(ttl).unwrap();
        assert!(s.valid(&t, ttl));
        assert!(!s.valid("deadbeef", ttl));
        s.revoke(&t);
        assert!(!s.valid(&t, ttl));
    }

    #[test]
    fn sessions_persist_across_restart() {
        let dir = tmp();
        let ttl = Duration::from_secs(3600);
        let token = {
            let s = Sessions::new(&dir);
            let t = s.create(ttl).unwrap();
            assert!(s.valid(&t, ttl));
            t
        };
        // "restart": a fresh Sessions over the same dir must still validate.
        let s2 = Sessions::new(&dir);
        assert!(s2.valid(&token, ttl), "session must survive restart");
        s2.revoke(&token);
        let s3 = Sessions::new(&dir);
        assert!(!s3.valid(&token, ttl), "revoke must persist too");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sessions_file_stores_hashes_not_tokens() {
        let dir = tmp();
        let s = Sessions::new(&dir);
        let token = s.create(Duration::from_secs(60)).unwrap();
        let raw = std::fs::read_to_string(dir.join("sessions.json")).unwrap();
        assert!(
            !raw.contains(&token),
            "sessions.json must not contain raw tokens"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sessions_expire_after_ttl() {
        let s = Sessions::new(&tmp());
        let t = s.create(Duration::ZERO).unwrap();
        assert!(!s.valid(&t, Duration::ZERO)); // expires immediately — GC path
    }

    #[test]
    fn limiter_blocks_after_5_failures() {
        let l = LoginLimiter::new();
        for _ in 0..MAX_ATTEMPTS {
            l.fail("1.2.3.4");
            assert!(l.check("1.2.3.4").is_ok());
        }
        l.fail("1.2.3.4");
        assert!(l.check("1.2.3.4").is_err());
        assert!(l.check("9.9.9.9").is_ok());
        l.clear("1.2.3.4");
        assert!(l.check("1.2.3.4").is_ok());
    }
}
