//! HTTPS access tokens for Git remotes (web server only).
//!
//! A container has no credential helper, SSH agent, or `~/.ssh`, and its home
//! directory does not survive a redeploy. Tokens therefore live in
//! `git-credentials.json` inside the data dir, which is a volume.
//!
//! Unlike `keys.json`, this file has no plaintext mode. It is always AES-256-GCM
//! encrypted with the `DB_KEYS_PASSPHRASE`-derived key (see `keys.rs`), and
//! saving is refused while that passphrase is unset. The passphrase lives in the
//! environment, not in the volume, so a copy of `/data` alone does not reveal a
//! token. Tokens are read server-side by the Git credential callback and are
//! never sent back to the browser: listing returns hosts and usernames only.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::keys;
use crate::AppState;

const FILE_NAME: &str = "git-credentials.json";
const NEEDS_PASSPHRASE: &str =
    "Set DB_KEYS_PASSPHRASE to store Git credentials — they are only ever saved encrypted";

/// Serialises read-modify-write cycles so two saves cannot drop each other.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Entry {
    username: String,
    token: String,
}

fn file(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

fn load_with(data_dir: &Path, pass: Option<&str>) -> Result<HashMap<String, Entry>, String> {
    let raw = match std::fs::read_to_string(file(data_dir)) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(format!("Cannot read {FILE_NAME}: {error}")),
    };
    if raw.trim().is_empty() {
        return Ok(HashMap::new());
    }
    let pass = pass.ok_or("Git credentials are encrypted — set DB_KEYS_PASSPHRASE to use them")?;
    if !keys::looks_like_envelope(&raw) {
        return Err(format!("{FILE_NAME} is not an encrypted credential file"));
    }
    let map = keys::decrypt_map(&raw, pass)
        .map_err(|_| format!("Cannot decrypt {FILE_NAME} — check DB_KEYS_PASSPHRASE"))?;
    map.into_iter()
        .map(|(host, value)| {
            serde_json::from_str(&value)
                .map(|entry| (host, entry))
                .map_err(|_| format!("{FILE_NAME} holds an invalid entry"))
        })
        .collect()
}

fn save_with(
    data_dir: &Path,
    map: &HashMap<String, Entry>,
    pass: Option<&str>,
) -> Result<(), String> {
    let pass = pass.ok_or(NEEDS_PASSPHRASE)?;
    let plain = map
        .iter()
        .map(|(host, entry)| {
            serde_json::to_string(entry)
                .map(|value| (host.clone(), value))
                .map_err(|error| error.to_string())
        })
        .collect::<Result<HashMap<_, _>, _>>()?;
    let sealed = keys::encrypt_map(&plain, pass)?;

    // Write a 0600 temp file and rename it over the old one: the token file is
    // never briefly world-readable, and a crash never leaves it half-written.
    let target = file(data_dir);
    let temp = data_dir.join(format!(".{FILE_NAME}.tmp"));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write = || -> std::io::Result<()> {
        let mut handle = options.open(&temp)?;
        handle.write_all(sealed.as_bytes())?;
        handle.sync_all()?;
        std::fs::rename(&temp, &target)
    };
    write().map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("Cannot write {FILE_NAME}: {error} — check the /data volume ownership")
    })
}

/// `host` or `host:port`, lowercase. Accepts a pasted HTTPS URL. Only HTTPS
/// hosts can be stored because only HTTPS remotes are ever offered a token.
fn normalize_host(input: &str) -> Result<String, String> {
    let input = input.trim();
    let host = if input.contains("://") {
        docubook_core::git::credentials::https_host(input)
            .ok_or("Only HTTPS remotes can use a stored token")?
    } else {
        let host = input.trim_end_matches('/').to_ascii_lowercase();
        host.strip_suffix(":443").unwrap_or(&host).to_string()
    };
    let (name, port) = match host.rsplit_once(':') {
        Some((name, port)) => (name, Some(port)),
        None => (host.as_str(), None),
    };
    let valid_name = !name.is_empty()
        && name.len() <= 253
        && name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        });
    let valid_port = port.is_none_or(|port| port.parse::<u16>().is_ok_and(|port| port > 0));
    if !valid_name || !valid_port {
        return Err("Invalid host — use a name such as github.com or git.example.com:8443".into());
    }
    Ok(host)
}

fn validate_entry(username: &str, token: &str) -> Result<(), String> {
    // HTTP Basic splits on the first `:`, so a username cannot contain one.
    if username.is_empty()
        || username.len() > 256
        || username.contains(':')
        || username.chars().any(char::is_control)
    {
        return Err("Invalid username".into());
    }
    if token.is_empty()
        || token.len() > 4096
        || token.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("Invalid access token".into());
    }
    Ok(())
}

fn set_with(
    data_dir: &Path,
    host: &str,
    username: &str,
    token: &str,
    pass: Option<&str>,
) -> Result<String, String> {
    let pass = pass.ok_or(NEEDS_PASSPHRASE)?;
    let host = normalize_host(host)?;
    let username = username.trim();
    let token = token.trim();
    validate_entry(username, token)?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut map = load_with(data_dir, Some(pass))?;
    map.insert(
        host.clone(),
        Entry {
            username: username.to_string(),
            token: token.to_string(),
        },
    );
    save_with(data_dir, &map, Some(pass))?;
    Ok(host)
}

fn delete_with(data_dir: &Path, host: &str, pass: Option<&str>) -> Result<(), String> {
    let host = normalize_host(host)?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut map = load_with(data_dir, pass)?;
    if map.remove(&host).is_none() {
        return Ok(());
    }
    if map.is_empty() {
        // Removing the last token needs no passphrase-protected rewrite.
        return match std::fs::remove_file(file(data_dir)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Cannot remove {FILE_NAME}: {error}")),
        };
    }
    save_with(data_dir, &map, pass)
}

fn list_with(data_dir: &Path, pass: Option<&str>) -> Value {
    let (credentials, error) = match load_with(data_dir, pass) {
        Ok(map) => {
            let mut list: Vec<Value> = map
                .into_iter()
                .map(|(host, entry)| json!({ "host": host, "username": entry.username }))
                .collect();
            list.sort_by(|a, b| a["host"].as_str().cmp(&b["host"].as_str()));
            (list, String::new())
        }
        Err(error) => (Vec::new(), error),
    };
    json!({ "encryption": pass.is_some(), "credentials": credentials, "error": error })
}

/// Token for `host`, for the Git credential callback. Errors are logged, never
/// surfaced with secret material, and simply mean "no stored credential".
pub fn lookup(data_dir: &Path, host: &str) -> Option<(String, String)> {
    match load_with(data_dir, keys::passphrase().as_deref()) {
        Ok(mut map) => map.remove(host).map(|entry| (entry.username, entry.token)),
        Err(error) => {
            tracing::warn!(event = "git_credentials_unavailable", error = %error);
            None
        }
    }
}

pub fn list_json(state: &AppState) -> Result<String, String> {
    Ok(list_with(&state.data_dir, keys::passphrase().as_deref()).to_string())
}

pub fn set_from_args(state: &AppState, args: &Value) -> Result<String, String> {
    let arg = |name: &str| args.get(name).and_then(Value::as_str).unwrap_or_default();
    let host = set_with(
        &state.data_dir,
        arg("host"),
        arg("username"),
        arg("token"),
        keys::passphrase().as_deref(),
    )?;
    tracing::info!(event = "git_credential_saved", host = %host);
    Ok(json!({ "host": host }).to_string())
}

pub fn delete_from_args(state: &AppState, args: &Value) -> Result<String, String> {
    let host = args.get("host").and_then(Value::as_str).unwrap_or_default();
    delete_with(&state.data_dir, host, keys::passphrase().as_deref())?;
    tracing::info!(event = "git_credential_deleted", host = %host);
    Ok("null".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "db-git-creds-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn tokens_are_stored_encrypted_and_never_listed() {
        let dir = tmp();
        let host = set_with(
            &dir,
            "https://GitHub.com/org/repo.git",
            "me",
            "ghp_secret",
            Some("pw"),
        )
        .unwrap();
        assert_eq!(host, "github.com");

        let raw = std::fs::read_to_string(file(&dir)).unwrap();
        assert!(keys::looks_like_envelope(&raw));
        assert!(
            !raw.contains("ghp_secret") && !raw.contains("github.com"),
            "{raw}"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(file(&dir)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        let listed = list_with(&dir, Some("pw")).to_string();
        assert!(
            listed.contains("github.com") && listed.contains("\"me\""),
            "{listed}"
        );
        assert!(!listed.contains("ghp_secret"), "{listed}");

        let map = load_with(&dir, Some("pw")).unwrap();
        assert_eq!(map["github.com"].token, "ghp_secret");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn saving_without_a_passphrase_is_refused() {
        let dir = tmp();
        assert_eq!(
            set_with(&dir, "github.com", "me", "token", None).unwrap_err(),
            NEEDS_PASSPHRASE
        );
        assert!(!file(&dir).exists());
        let listed = list_with(&dir, None);
        assert_eq!(listed["encryption"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_wrong_or_missing_passphrase_reveals_nothing() {
        let dir = tmp();
        set_with(&dir, "github.com", "me", "token", Some("right")).unwrap();
        assert!(load_with(&dir, Some("wrong")).is_err());
        assert!(load_with(&dir, None).is_err());
        let listed = list_with(&dir, Some("wrong"));
        assert_eq!(listed["credentials"], json!([]));
        assert!(listed["error"]
            .as_str()
            .unwrap()
            .contains("DB_KEYS_PASSPHRASE"));
        // An existing encrypted file is never replaced under another passphrase.
        assert!(set_with(&dir, "gitlab.com", "me", "token", Some("wrong")).is_err());
        assert_eq!(load_with(&dir, Some("right")).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hosts_and_entries_are_validated() {
        assert_eq!(normalize_host(" GitHub.com ").unwrap(), "github.com");
        assert_eq!(
            normalize_host("git.example.com:8443").unwrap(),
            "git.example.com:8443"
        );
        assert_eq!(normalize_host("github.com:443").unwrap(), "github.com");
        for bad in [
            "",
            "http://github.com/x",
            "git@github.com:x",
            "-bad.com",
            "a..b",
            "host:0",
            "host:99999",
            "ho st",
            "github.com/org",
        ] {
            assert!(normalize_host(bad).is_err(), "{bad}");
        }
        assert!(validate_entry("me", "tok").is_ok());
        assert!(validate_entry("", "tok").is_err());
        assert!(validate_entry("a:b", "tok").is_err());
        assert!(validate_entry("me", "").is_err());
        assert!(validate_entry("me", "to ken").is_err());
        assert!(validate_entry("me", "tok\n").is_err());
    }

    #[test]
    fn deleting_the_last_token_removes_the_file() {
        let dir = tmp();
        set_with(&dir, "github.com", "me", "a", Some("pw")).unwrap();
        set_with(&dir, "gitlab.com", "me", "b", Some("pw")).unwrap();
        delete_with(&dir, "github.com", Some("pw")).unwrap();
        assert_eq!(load_with(&dir, Some("pw")).unwrap().len(), 1);
        delete_with(&dir, "gitlab.com", Some("pw")).unwrap();
        assert!(!file(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
