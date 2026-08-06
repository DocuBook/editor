//! Account auth for the web build — one admin per server (personal server
//! model, same persona as the desktop app).
//!
//! - Passwords: Argon2id (pure-Rust crate, constant-time verify).
//! - Sessions: random 32-byte token in an in-memory map, httpOnly cookie
//!   `db_session` (SameSite=Strict). Sessions reset on restart → re-login.
//! - Login rate limit: 6 failed attempts / 60 s per client IP, blocked on the
//!   7th (count > MAX_ATTEMPTS) — in-memory.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use rand::rngs::OsRng;

use argon2::Argon2;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

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
    map: Mutex<HashMap<String, Instant>>,
}

impl Sessions {
    pub fn new() -> Self {
        Self { map: Mutex::new(HashMap::new()) }
    }

    pub fn create(&self, ttl: Duration) -> String {
        let mut bytes = [0u8; 32];
        let _ = getrandom::getrandom(&mut bytes);
        let token = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        self.map.lock().expect("lock").insert(token.clone(), Instant::now() + ttl);
        token
    }

    pub fn valid(&self, token: &str, ttl: Duration) -> bool {
        let mut map = self.map.lock().expect("lock");
        let now = Instant::now();
        map.retain(|_, expires| *expires > now);
        map.get(token).is_some_and(|expires| now + ttl > *expires || *expires > now)
    }

    pub fn revoke(&self, token: &str) {
        self.map.lock().expect("lock").remove(token);
    }
}

pub struct LoginLimiter {
    map: Mutex<HashMap<String, (u32, Instant)>>,
}

const MAX_ATTEMPTS: u32 = 5;
const LOCKOUT: Duration = Duration::from_secs(60);

impl LoginLimiter {
    pub fn new() -> Self {
        Self { map: Mutex::new(HashMap::new()) }
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
        let e = map.entry(ip.to_string()).or_insert((0, Instant::now() + LOCKOUT));
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

    #[test]
    fn password_roundtrip() {
        let h = hash_password("hunter2!").unwrap();
        assert!(verify_password(&h, "hunter2!"));
        assert!(!verify_password(&h, "hunter2?"));
    }

    #[test]
    fn sessions_create_and_validate() {
        let s = Sessions::new();
        let ttl = Duration::from_secs(3600);
        let t = s.create(ttl);
        assert!(s.valid(&t, ttl));
        assert!(!s.valid("deadbeef", ttl));
        s.revoke(&t);
        assert!(!s.valid(&t, ttl));
    }

    #[test]
    fn sessions_expire_after_ttl() {
        let s = Sessions::new();
        let t = s.create(Duration::ZERO);
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
