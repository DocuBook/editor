//! SSRF guard for `web_fetch`: the model picks the URL, so every hop must land
//! on a public address and the connection is pinned to the addresses checked.
//!
//! Stricter than `provider::validated_custom_addrs` (which guards endpoints the
//! user typed): CGNAT, benchmarking, reserved, IPv4-mapped/NAT64/6to4-embedded
//! and IPv6 link-local addresses are rejected too.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use reqwest::Url;

use super::ToolError;

/// Longest URL accepted from the model.
pub const MAX_URL_LEN: usize = 2048;
/// Bound on the blocking `getaddrinfo` call; a hostile resolver must not hold
/// the fetch (or outlive a Stop) for the system resolver's own timeout.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);
/// Only the default web ports: anything else is far more likely an internal service.
const ALLOWED_PORTS: [u16; 2] = [80, 443];
/// Host names that must never be resolved, whatever DNS says.
const BLOCKED_HOST_SUFFIXES: [&str; 4] = [".localhost", ".local", ".internal", ".home.arpa"];
/// GCP's metadata host; the other clouds use link-local addresses.
const METADATA_HOST: &str = "metadata.google.internal";
const BLOCKED_HOSTS: [&str; 2] = ["localhost", METADATA_HOST];

/// Report whether `ip` is a globally routable unicast address.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

/// Classify an IPv4 address against the IANA special-purpose blocks.
fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    let special = a == 0 // "this network"
        || a == 10
        || (a == 100 && (64..=127).contains(&b)) // CGNAT 100.64/10
        || a == 127
        || (a == 169 && b == 254) // link-local, cloud metadata
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
        || (a == 192 && b == 0 && c == 2) // TEST-NET-1
        || (a == 192 && b == 88 && c == 99) // 6to4 relay anycast
        || (a == 192 && b == 168)
        || (a == 198 && (18..=19).contains(&b)) // benchmarking
        || (a == 198 && b == 51 && c == 100) // TEST-NET-2
        || (a == 203 && b == 0 && c == 113) // TEST-NET-3
        || a >= 224; // multicast, reserved, broadcast
    !special
}

/// Classify an IPv6 address; embedded IPv4 forms are judged by their IPv4 part.
fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let segments = ip.segments();
    let embedded_v4 = |high: u16, low: u16| {
        Ipv4Addr::new((high >> 8) as u8, high as u8, (low >> 8) as u8, low as u8)
    };
    // NAT64 well-known prefix 64:ff9b::/96 — DNS64 networks use it for public hosts.
    if segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return is_public_v4(embedded_v4(segments[6], segments[7]));
    }
    // 6to4 2002::/16 carries an IPv4 address in bits 16..48.
    if segments[0] == 0x2002 {
        return is_public_v4(embedded_v4(segments[1], segments[2]));
    }
    let special = ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || ip.is_unique_local() // fc00::/7
        || ip.is_unicast_link_local() // fe80::/10
        || (segments[0] & 0xffc0) == 0xfec0 // deprecated site-local
        || segments[..6] == [0, 0, 0, 0, 0, 0] // IPv4-compatible ::/96
        || segments[..4] == [0x100, 0, 0, 0] // discard-only 100::/64
        || segments[..2] == [0x2001, 0] // Teredo 2001::/32
        || segments[..2] == [0x2001, 0xdb8] // documentation
        || segments[..3] == [0x64, 0xff9b, 1]; // local-use NAT64 64:ff9b:1::/48
    !special
}

/// Report whether `host` is a link-local address or a cloud metadata name.
///
/// Used for operator-supplied URLs that may otherwise be private.
pub fn is_metadata_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host == METADATA_HOST || host.ends_with(".internal") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.is_link_local(),
        Ok(IpAddr::V6(v6)) => {
            v6.is_unicast_link_local()
                || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_link_local())
                || v6 == Ipv6Addr::new(0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254)
        }
        Err(_) => false,
    }
}

/// Parse and syntactically validate a URL the model wants fetched.
pub fn validate_url(raw: &str) -> Result<Url, ToolError> {
    if raw.is_empty() || raw.len() > MAX_URL_LEN {
        return Err(ToolError::invalid_input("URL is empty or longer than 2048 characters"));
    }
    let url = Url::parse(raw).map_err(|_| ToolError::invalid_input("URL is not a valid absolute URL"))?;
    check_url(&url)?;
    Ok(url)
}

/// Apply the scheme, credential, port and host-name rules to a parsed URL.
pub fn check_url(url: &Url) -> Result<(), ToolError> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ToolError::url_not_allowed("only http and https URLs can be fetched"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ToolError::url_not_allowed("URLs with embedded credentials are not fetched"));
    }
    if !url.port_or_known_default().is_some_and(|port| ALLOWED_PORTS.contains(&port)) {
        return Err(ToolError::url_not_allowed("only ports 80 and 443 are allowed"));
    }
    let host = url
        .host_str()
        .ok_or_else(|| ToolError::url_not_allowed("URL has no host"))?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if BLOCKED_HOSTS.contains(&host.as_str())
        || BLOCKED_HOST_SUFFIXES.iter().any(|suffix| host.ends_with(suffix))
    {
        return Err(ToolError::url_not_allowed("internal host names are not fetched"));
    }
    Ok(())
}

/// Resolve the URL's host and require every address to be public.
///
/// Returns the host to pin and the validated socket addresses.
pub async fn resolve_public(url: &Url) -> Result<(String, Vec<SocketAddr>), ToolError> {
    let host = url
        .host_str()
        .ok_or_else(|| ToolError::url_not_allowed("URL has no host"))?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = match host.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) => tokio::time::timeout(RESOLVE_TIMEOUT, tokio::net::lookup_host((host.as_str(), port)))
            .await
            .map_err(|_| ToolError::url_not_accessible("host name could not be resolved in time"))?
            .map_err(|_| ToolError::url_not_accessible("host name could not be resolved"))?
            .collect(),
    };
    if addrs.is_empty() {
        return Err(ToolError::url_not_accessible("host name could not be resolved"));
    }
    // One internal answer is enough to refuse: a mixed answer is a rebinding attempt.
    if let Some(internal) = addrs.iter().find(|addr| !is_public_ip(addr.ip())) {
        return Err(ToolError::url_not_allowed(format!(
            "host resolves to a non-public address ({})",
            internal.ip()
        )));
    }
    Ok((host, addrs))
}

/// Build a client that can only reach the validated addresses of one host.
///
/// Redirects are followed by the caller (each hop re-validated) and proxies are
/// disabled, because a proxy would resolve the host itself and bypass the check.
pub fn pinned_client(
    host: &str,
    addrs: &[SocketAddr],
    connect_timeout: Duration,
    total_timeout: Duration,
) -> Result<reqwest::Client, ToolError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(connect_timeout)
        .timeout(total_timeout)
        .resolve_to_addrs(host, addrs)
        .build()
        .map_err(|_| ToolError::unavailable("could not create the HTTP client"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn public(raw: &str) -> bool {
        is_public_ip(raw.parse().unwrap())
    }

    #[test]
    fn rejects_every_internal_ipv4_block() {
        for ip in [
            "0.0.0.0", "0.1.2.3", "10.0.0.1", "100.64.0.1", "100.127.255.255", "127.0.0.1",
            "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1",
            "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.1",
            "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255",
        ] {
            assert!(!public(ip), "{ip} must be rejected");
        }
    }

    #[test]
    fn accepts_public_ipv4_next_to_the_blocked_ranges() {
        for ip in ["1.1.1.1", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.15.0.1", "172.32.0.1", "198.20.0.1", "223.255.255.254"] {
            assert!(public(ip), "{ip} must be accepted");
        }
    }

    #[test]
    fn judges_embedded_ipv4_inside_ipv6() {
        for ip in ["::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a00:1", "2002:a9fe:a9fe::1", "::127.0.0.1"] {
            assert!(!public(ip), "{ip} must be rejected");
        }
        assert!(public("::ffff:8.8.8.8"));
        assert!(public("64:ff9b::808:808"));
        assert!(public("2002:808:808::1"));
    }

    #[test]
    fn rejects_internal_ipv6_blocks() {
        for ip in ["::", "::1", "fc00::1", "fd00:ec2::254", "fe80::1", "fec0::1", "ff02::1", "100::1", "2001::1", "2001:db8::1", "64:ff9b:1::1"] {
            assert!(!public(ip), "{ip} must be rejected");
        }
        assert!(public("2606:4700:4700::1111"));
    }

    #[test]
    fn url_rules_cover_scheme_credentials_ports_and_hosts() {
        assert!(validate_url("https://example.com/a?b=c").is_ok());
        assert!(validate_url("http://example.com:80/").is_ok());
        for raw in [
            "ftp://example.com/",
            "file:///etc/passwd",
            "https://user:pass@example.com/",
            "https://example.com:8080/",
            "http://localhost/",
            "http://LOCALHOST./",
            "http://printer.local/",
            "http://metadata.google.internal/",
            "http://router.home.arpa/",
            "not a url",
        ] {
            assert!(validate_url(raw).is_err(), "{raw} must be rejected");
        }
        assert!(validate_url(&format!("https://example.com/{}", "a".repeat(MAX_URL_LEN))).is_err());
    }

    #[tokio::test]
    async fn resolution_refuses_ip_literals_in_any_spelling() {
        // The URL parser canonicalises octal/hex/short IPv4 forms before the check.
        for raw in ["http://127.1/", "http://0x7f.0.0.1/", "http://2130706433/", "http://[::ffff:7f00:1]/", "http://169.254.169.254/"] {
            let url = validate_url(raw).unwrap();
            assert!(resolve_public(&url).await.is_err(), "{raw} must be rejected");
        }
    }
}
