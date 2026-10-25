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
use axum::http::HeaderMap;
use std::collections::HashMap;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// One DB_TRUSTED_PROXY entry: a single address or a CIDR range (`172.18.0.0/16`),
/// so a proxy container that gets a new address on restart stays trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustedProxy {
    net: IpAddr,
    prefix: u8,
}

impl TrustedProxy {
    fn contains(&self, ip: IpAddr) -> bool {
        let (net, addr, bits) = match (self.net, ip.to_canonical()) {
            (IpAddr::V4(n), IpAddr::V4(a)) => (u128::from(u32::from(n)), u128::from(u32::from(a)), 32),
            (IpAddr::V6(n), IpAddr::V6(a)) => (u128::from(n), u128::from(a), 128),
            _ => return false,
        };
        let shift = u32::from(bits - self.prefix);
        self.prefix == 0 || net >> shift == addr >> shift
    }
}

impl std::fmt::Display for TrustedProxy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.net, self.prefix)
    }
}

impl std::str::FromStr for TrustedProxy {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, ()> {
        let (addr, prefix) = match value.trim().split_once('/') {
            Some((addr, prefix)) => (addr, Some(prefix)),
            None => (value.trim(), None),
        };
        let net = addr.trim().parse::<IpAddr>().map_err(|_| ())?.to_canonical();
        let bits = if net.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            Some(prefix) => prefix.trim().parse::<u8>().map_err(|_| ())?,
            None => bits,
        };
        if prefix > bits {
            return Err(());
        }
        Ok(Self { net, prefix })
    }
}

fn is_trusted(trusted: &[TrustedProxy], ip: IpAddr) -> bool {
    trusted.iter().any(|proxy| proxy.contains(ip))
}

/// Every entry of every `X-Forwarded-For` line, in the order the hops were added
/// (each proxy appends the address it saw).
fn xff_entries(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect()
}

/// The forwarded hops to walk, or `None` when the headers contradict each other.
/// `X-Real-IP` alone is used when there is no `X-Forwarded-For`. When both are
/// present, a proxy that sets both puts the same address in `X-Real-IP` and at
/// the right of `X-Forwarded-For`; a mismatch means one came from the client
/// (nginx passes the client's `X-Forwarded-For` through unless told otherwise,
/// Caddy passes the client's `X-Real-IP` through), so neither is trusted.
fn forwarded_entries(headers: &HeaderMap) -> Option<Vec<String>> {
    let real_ip = headers.get("x-real-ip").and_then(|v| v.to_str().ok()).map(str::trim);
    let xff = xff_entries(headers);
    match (xff.last(), real_ip) {
        (None, Some(real_ip)) => Some(vec![real_ip.to_string()]),
        (None, None) => Some(Vec::new()),
        (Some(_), None) => Some(xff),
        (Some(last), Some(real_ip)) => {
            let agree = matches!((parse_hop(last), parse_hop(real_ip)), (Some(a), Some(b)) if a == b);
            agree.then_some(xff)
        }
    }
}

/// One hop as an address. Some proxies append the port (`203.0.113.7:4444`,
/// `[2001:db8::1]:443`), so a socket address is accepted too.
fn parse_hop(raw: &str) -> Option<IpAddr> {
    raw.parse::<IpAddr>()
        .ok()
        .or_else(|| raw.parse::<std::net::SocketAddr>().ok().map(|s| s.ip()))
        .map(|ip| ip.to_canonical())
}

/// Address to rate-limit a request by. Only a peer in DB_TRUSTED_PROXY may name
/// the real client: hops are walked from the right past trusted proxies, and the
/// first untrusted hop is the client. A hop that cannot be read stops the walk,
/// because nothing to its left can be trusted; any other peer is its own address.
pub(crate) fn client_ip(peer: IpAddr, headers: &HeaderMap, trusted: &[TrustedProxy]) -> IpAddr {
    let peer = peer.to_canonical();
    if !is_trusted(trusted, peer) {
        return peer;
    }
    let Some(entries) = forwarded_entries(headers) else {
        return peer;
    };
    let mut leftmost = None;
    for raw in entries.iter().rev() {
        match parse_hop(raw) {
            Some(ip) if is_trusted(trusted, ip) => leftmost = Some(ip),
            Some(ip) => return ip,
            None => return peer,
        }
    }
    leftmost.unwrap_or(peer)
}

/// Whether a request is from the machine the server runs on, for the setup gate:
/// a loopback peer with no forwarding headers at all. A request that passed
/// through any proxy is treated as remote, whatever address it claims.
pub(crate) fn is_local_client(peer: IpAddr, headers: &HeaderMap) -> bool {
    peer.to_canonical().is_loopback()
        && !headers.contains_key("x-forwarded-for")
        && !headers.contains_key("x-real-ip")
}

/// DB_TRUSTED_PROXY: comma-separated addresses or CIDR ranges. An entry that
/// does not parse is dropped with a `trusted_proxy_invalid` warning: a silently
/// dropped proxy puts every visitor behind it back in one login bucket, which
/// is the lockout the setting exists to prevent.
pub(crate) fn parse_trusted_proxies(value: Option<&str>) -> Vec<TrustedProxy> {
    let Some(value) = value else {
        return Vec::new();
    };
    let proxies: Vec<TrustedProxy> = value
        .split(',')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .filter_map(|v| match v.parse() {
            Ok(proxy) => Some(proxy),
            Err(()) => {
                tracing::warn!(
                    event = "trusted_proxy_invalid",
                    entry = %v,
                    "DB_TRUSTED_PROXY entry is not an address or CIDR range and was ignored"
                );
                None
            }
        })
        .collect();
    tracing::info!(
        event = "trusted_proxy_configured",
        proxies = ?proxies.iter().map(ToString::to_string).collect::<Vec<_>>()
    );
    proxies
}

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

/** Shared password policy — must stay in step with
 *  `frontend/utils/passwordPolicy.ts`, which drives the live setup checklist.
 *  Returns the first unmet rule's user-facing message, in the same order the
 *  frontend shows them, or `None` when the password is acceptable. */
pub fn password_error(pw: &str) -> Option<&'static str> {
    let has_lower = pw.chars().any(|c| c.is_ascii_lowercase());
    let has_upper = pw.chars().any(|c| c.is_ascii_uppercase());
    if !(has_lower && has_upper) {
        return Some("Password must include both upper and lower case letters");
    }
    if pw.encode_utf16().count() < 8 {
        return Some("Password must be at least 8 characters");
    }
    let has_digit = pw.chars().any(|c| c.is_ascii_digit());
    let has_special = pw.chars().any(|c| !c.is_ascii_alphanumeric());
    if !(has_digit && has_special) {
        return Some("Password must include numbers and special characters");
    }
    None
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
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(Self::hash(&token), SystemTime::now() + ttl);
        self.persist(&map);
        Ok(token)
    }

    pub fn valid(&self, token: &str, _ttl: Duration) -> bool {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let now = SystemTime::now();
        let before = map.len();
        map.retain(|_, expires| *expires > now);
        if map.len() != before {
            self.persist(&map);
        }
        map.contains_key(&Self::hash(token))
    }

    pub fn revoke(&self, token: &str) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        if map.remove(&Self::hash(token)).is_some() {
            self.persist(&map);
        }
    }

    pub fn revoke_all(&self) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
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

    /// Reserve one attempt for `ip`, before its password is checked. Counting at
    /// start (not on failure) keeps overlapping attempts from all passing the limit.
    pub fn check(&self, ip: &str) -> Result<(), String> {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        map.retain(|_, (_, until)| *until > now);
        let e = map.entry(ip.to_string()).or_insert((0, now + LOCKOUT));
        if e.0 > MAX_ATTEMPTS {
            return Err("Too many attempts — try again in a minute".into());
        }
        e.0 += 1;
        if e.0 > MAX_ATTEMPTS {
            e.1 = now + LOCKOUT;
        }
        Ok(())
    }

    pub fn clear(&self, ip: &str) {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).remove(ip);
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
    fn password_policy_matches_frontend_rules() {
        assert_eq!(password_error("Password1!"), None);
        assert_eq!(
            password_error("Abcdefg1"),
            Some("Password must include numbers and special characters")
        );
        assert_eq!(
            password_error("password1!"),
            Some("Password must include both upper and lower case letters")
        );
        assert_eq!(
            password_error("PASSWORD1!"),
            Some("Password must include both upper and lower case letters")
        );
        assert_eq!(
            password_error("Pa1!"),
            Some("Password must be at least 8 characters")
        );
        assert_eq!(
            password_error("Password!"),
            Some("Password must include numbers and special characters")
        );
        assert_eq!(
            password_error("Password1"),
            Some("Password must include numbers and special characters")
        );
        // Non-ASCII letters are not ASCII upper/lower case, matching the
        // frontend's `[a-z]` / `[A-Z]` tests.
        assert!(password_error("Éééééé1!").is_some());
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
    fn limiter_blocks_after_6_attempts() {
        let l = LoginLimiter::new();
        for _ in 0..=MAX_ATTEMPTS {
            assert!(l.check("1.2.3.4").is_ok());
        }
        assert!(l.check("1.2.3.4").is_err());
        assert!(l.check("9.9.9.9").is_ok());
        l.clear("1.2.3.4");
        assert!(l.check("1.2.3.4").is_ok());
    }

    #[test]
    fn attempts_are_counted_when_they_start() {
        // Password checks are slow, so attempts overlap. Nothing has failed yet
        // for them to count against, so the limit must bind at check time.
        let l = LoginLimiter::new();
        let allowed = (0..100).filter(|_| l.check("1.2.3.4").is_ok()).count();
        assert_eq!(allowed, MAX_ATTEMPTS as usize + 1);
    }

    #[test]
    fn client_ip_uses_the_forwarded_client_only_for_trusted_peers() {
        let headers = |lines: &[&str]| {
            let mut m = HeaderMap::new();
            for line in lines {
                m.append("x-forwarded-for", line.parse().unwrap());
            }
            m
        };
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        let t = |s: &str| s.parse::<TrustedProxy>().unwrap();
        let loopback = ip("127.0.0.1");
        let proxy = ip("10.0.0.5");
        // An untrusted peer's header is ignored, so it cannot choose its bucket.
        assert_eq!(client_ip(ip("198.51.100.9"), &headers(&["203.0.113.1"]), &[]), ip("198.51.100.9"));
        // Loopback is not trusted implicitly: only DB_TRUSTED_PROXY makes it a proxy.
        assert_eq!(client_ip(loopback, &headers(&["203.0.113.1"]), &[]), loopback);
        // Trusted proxy: the rightmost hop is the client, not a spoofed leftmost one.
        assert_eq!(client_ip(loopback, &headers(&["1.1.1.1, 203.0.113.7"]), &[t("127.0.0.1")]), ip("203.0.113.7"));
        // Several X-Forwarded-For lines are read together, in order.
        assert_eq!(client_ip(loopback, &headers(&["1.1.1.1", "203.0.113.7"]), &[t("127.0.0.1")]), ip("203.0.113.7"));
        // A chain of trusted proxies is skipped from the right.
        assert_eq!(client_ip(proxy, &headers(&["203.0.113.8, 10.0.0.9"]), &[t("10.0.0.5"), t("10.0.0.9")]), ip("203.0.113.8"));
        // A proxy that appends the port: the hop is still the client, not the decoy.
        assert_eq!(client_ip(proxy, &headers(&["6.6.6.6, 203.0.113.7:4444"]), &[t("10.0.0.5")]), ip("203.0.113.7"));
        assert_eq!(client_ip(proxy, &headers(&["6.6.6.6, [2001:db8::1]:443"]), &[t("10.0.0.5")]), ip("2001:db8::1"));
        // An unreadable hop stops the walk: nothing to its left is trusted.
        assert_eq!(client_ip(proxy, &headers(&["6.6.6.6, garbage"]), &[t("10.0.0.5")]), proxy);
        // A CIDR range trusts every proxy address inside it.
        assert_eq!(client_ip(ip("172.18.0.7"), &headers(&["203.0.113.9"]), &[t("172.18.0.0/16")]), ip("203.0.113.9"));
        // No forwarding information falls back to the peer.
        assert_eq!(client_ip(proxy, &HeaderMap::new(), &[t("10.0.0.5")]), proxy);
    }

    #[test]
    fn local_client_is_only_a_loopback_peer_with_no_forwarding_headers() {
        let none = HeaderMap::new();
        let mut remote = HeaderMap::new();
        remote.insert("x-forwarded-for", "198.51.100.9".parse().unwrap());
        let mut loopback_forwarded = HeaderMap::new();
        loopback_forwarded.insert("x-forwarded-for", "127.0.0.1".parse().unwrap());
        let mut real_ip = HeaderMap::new();
        real_ip.insert("x-real-ip", "127.0.0.1".parse().unwrap());
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        let lan: IpAddr = "192.168.1.20".parse().unwrap();

        assert!(is_local_client(loopback, &none));
        assert!(!is_local_client(loopback, &remote), "proxied remote client is not local");
        // Any forwarding header disqualifies, even one that names loopback.
        assert!(!is_local_client(loopback, &loopback_forwarded));
        assert!(!is_local_client(loopback, &real_ip));
        assert!(!is_local_client(lan, &none));
        assert!(!is_local_client(lan, &loopback_forwarded));
    }

    #[test]
    fn trusted_proxy_ranges_match_only_their_own_addresses() {
        let t = |s: &str| s.parse::<TrustedProxy>().unwrap();
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert!(t("172.18.0.0/16").contains(ip("172.18.4.2")));
        assert!(!t("172.18.0.0/16").contains(ip("172.19.0.1")));
        assert!(t("10.0.0.5").contains(ip("10.0.0.5")));
        assert!(!t("10.0.0.5").contains(ip("10.0.0.6")));
        assert!(t("fd00::/8").contains(ip("fd12::1")));
        assert!(!t("fd00::/8").contains(ip("10.0.0.1")), "families never match");
        assert!(t("172.18.0.0/16").contains(ip("::ffff:172.18.0.3")), "IPv4-mapped peers match their IPv4 range");
        assert!("10.0.0.0/33".parse::<TrustedProxy>().is_err());
        assert!("nope".parse::<TrustedProxy>().is_err());
    }

    #[test]
    fn trusted_proxy_env_ignores_bad_entries() {
        let t = |s: &str| s.parse::<TrustedProxy>().unwrap();
        assert_eq!(parse_trusted_proxies(None), Vec::<TrustedProxy>::new());
        assert_eq!(
            parse_trusted_proxies(Some("10.0.0.5, nope , ::ffff:172.18.0.2, 172.18.0.0/16, 10.0.0.0/40, ,")),
            vec![t("10.0.0.5"), t("172.18.0.2"), t("172.18.0.0/16")]
        );
    }

    /// How the common reverse proxies forward the client, and what each yields.
    #[test]
    fn client_ip_behind_common_reverse_proxies() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        let t = |s: &str| s.parse::<TrustedProxy>().unwrap();
        let headers = |pairs: &[(&'static str, &str)]| {
            let mut m = HeaderMap::new();
            for (name, value) in pairs {
                m.append(*name, value.parse().unwrap());
            }
            m
        };
        let proxy = ip("127.0.0.1");
        let local = [t("127.0.0.1")];

        // Caddy: ignores the client's X-Forwarded-For and writes its own, but
        // passes the client's X-Real-IP through. A spoofed X-Real-IP is a mismatch.
        assert_eq!(client_ip(proxy, &headers(&[("x-forwarded-for", "203.0.113.7")]), &local), ip("203.0.113.7"));
        assert_eq!(
            client_ip(proxy, &headers(&[("x-forwarded-for", "203.0.113.7"), ("x-real-ip", "6.6.6.6")]), &local),
            proxy
        );

        // Traefik: appends the client to whatever arrived, and sets X-Real-Ip to it.
        assert_eq!(
            client_ip(proxy, &headers(&[("x-forwarded-for", "6.6.6.6, 203.0.113.7"), ("x-real-ip", "203.0.113.7")]), &local),
            ip("203.0.113.7")
        );

        // nginx with `$proxy_add_x_forwarded_for`: appends; the spoofed left entry is ignored.
        assert_eq!(client_ip(proxy, &headers(&[("x-forwarded-for", "6.6.6.6, 203.0.113.7")]), &local), ip("203.0.113.7"));
        // nginx with only `X-Real-IP $remote_addr`: the client's own X-Forwarded-For
        // passes through. It disagrees with X-Real-IP, so neither is trusted.
        assert_eq!(
            client_ip(proxy, &headers(&[("x-forwarded-for", "6.6.6.6"), ("x-real-ip", "203.0.113.7")]), &local),
            proxy
        );
        // Same nginx, client sent no X-Forwarded-For: X-Real-IP names the client.
        assert_eq!(client_ip(proxy, &headers(&[("x-real-ip", "203.0.113.7")]), &local), ip("203.0.113.7"));

        // Cloudflare in front of nginx: Cloudflare appends the visitor, nginx appends
        // the Cloudflare edge and sets X-Real-IP to it. Listing Cloudflare's ranges
        // skips the edge hop and reaches the visitor.
        let cf_and_local = [t("127.0.0.1"), t("173.245.48.0/20")];
        assert_eq!(
            client_ip(
                proxy,
                &headers(&[("x-forwarded-for", "6.6.6.6, 203.0.113.7, 173.245.48.10"), ("x-real-ip", "173.245.48.10")]),
                &cf_and_local
            ),
            ip("203.0.113.7")
        );
        // Without Cloudflare's ranges listed, the edge is the client: coarser, never spoofable.
        assert_eq!(
            client_ip(
                proxy,
                &headers(&[("x-forwarded-for", "6.6.6.6, 203.0.113.7, 173.245.48.10"), ("x-real-ip", "173.245.48.10")]),
                &local
            ),
            ip("173.245.48.10")
        );
    }
}
