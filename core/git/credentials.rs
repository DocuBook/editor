//! App-managed HTTPS credentials for remotes.
//!
//! The desktop app relies on the user's own Git setup (credential helper, SSH
//! agent, `~/.ssh`). A container has none of that, so the web server registers
//! a lookup backed by its encrypted store; the credential callback asks it
//! first. Only HTTPS remotes ever receive a stored secret — never plain HTTP
//! (readable on the wire) and never SSH.

use std::sync::OnceLock;

/// `(username, secret)` for an HTTPS host (`host` or `host:port`, lowercase).
pub type CredentialLookup = dyn Fn(&str) -> Option<(String, String)> + Send + Sync;

static LOOKUP: OnceLock<Box<CredentialLookup>> = OnceLock::new();

/// Register the process-wide credential store. The first registration wins;
/// the web server calls this once at startup.
pub fn set_credential_lookup(lookup: Box<CredentialLookup>) {
    let _ = LOOKUP.set(lookup);
}

pub(crate) fn has_lookup() -> bool {
    LOOKUP.get().is_some()
}

/// Stored credential for `url`, with the host it was matched on.
pub(crate) fn stored_credential(url: &str) -> Option<(String, String, String)> {
    let lookup = LOOKUP.get()?;
    let host = https_host(url)?;
    let (username, secret) = lookup(&host)?;
    Some((host, username, secret))
}

/// `host[:port]` of an HTTPS URL, lowercase, without userinfo or the default
/// port. `None` for every other scheme.
pub fn https_host(url: &str) -> Option<String> {
    let scheme = url.get(..8)?;
    if !scheme.eq_ignore_ascii_case("https://") {
        return None;
    }
    let authority = url[8..].split(['/', '?', '#']).next()?;
    let host = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority)
        .to_ascii_lowercase();
    let host = host.strip_suffix(":443").unwrap_or(&host).to_string();
    (!host.is_empty()).then_some(host)
}

/// Final callback error: says what to configure in the runtime at hand.
pub(crate) fn missing_credentials_message(url: &str, rejected_host: Option<&str>) -> String {
    message_for(url, rejected_host, has_lookup())
}

fn message_for(url: &str, rejected_host: Option<&str>, app_store: bool) -> String {
    if let Some(host) = rejected_host {
        return format!(
            "The saved access token for {host} was rejected — update it in Settings → Git"
        );
    }
    if app_store {
        return match https_host(url) {
            Some(host) => {
                format!("No Git credentials for {host} — save an access token in Settings → Git")
            }
            None => "No Git credentials for this remote — use an HTTPS remote URL and save an access token in Settings → Git".into(),
        };
    }
    "No usable Git credentials — set credential.helper in your global ~/.gitconfig (e.g. osxkeychain) or load your SSH key into ssh-agent".into()
}

/// Whether an error came from the credential callback, so callers that
/// summarise transport errors keep it instead of a generic message.
pub(crate) fn is_credentials_message(error: &str) -> bool {
    error.contains("Git credentials") || error.contains("access token")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_host_is_normalised_and_limited_to_https() {
        assert_eq!(
            https_host("https://github.com/org/repo.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            https_host("HTTPS://User@GitLab.Example.com:443/x").as_deref(),
            Some("gitlab.example.com")
        );
        assert_eq!(
            https_host("https://git.local:8443/x").as_deref(),
            Some("git.local:8443")
        );
        assert_eq!(https_host("http://github.com/org/repo.git"), None);
        assert_eq!(https_host("git@github.com:org/repo.git"), None);
        assert_eq!(https_host("ssh://git@github.com/org/repo.git"), None);
        assert_eq!(https_host("https:///x"), None);
    }

    #[test]
    fn messages_point_at_the_runtime_that_can_fix_it() {
        let web = message_for("https://github.com/o/r.git", None, true);
        assert!(
            web.contains("github.com") && web.contains("Settings → Git"),
            "{web}"
        );
        let ssh = message_for("git@github.com:o/r.git", None, true);
        assert!(ssh.contains("HTTPS remote URL"), "{ssh}");
        let rejected = message_for("https://github.com/o/r.git", Some("github.com"), true);
        assert!(rejected.contains("was rejected"), "{rejected}");
        let desktop = message_for("https://github.com/o/r.git", None, false);
        assert!(
            desktop.contains("~/.gitconfig") && desktop.contains("ssh-agent"),
            "{desktop}"
        );
        for message in [web, ssh, rejected, desktop] {
            assert!(is_credentials_message(&message), "{message}");
        }
    }

    #[test]
    fn stored_credentials_are_only_offered_to_https_remotes() {
        set_credential_lookup(Box::new(|host| {
            (host == "creds.example.test").then(|| ("user".to_string(), "secret".to_string()))
        }));
        let (host, user, secret) =
            stored_credential("https://creds.example.test/org/repo.git").unwrap();
        assert_eq!(
            (host.as_str(), user.as_str(), secret.as_str()),
            ("creds.example.test", "user", "secret")
        );
        assert!(stored_credential("http://creds.example.test/org/repo.git").is_none());
        assert!(stored_credential("ssh://git@creds.example.test/org/repo.git").is_none());
        assert!(stored_credential("https://other.example.test/org/repo.git").is_none());
    }
}
