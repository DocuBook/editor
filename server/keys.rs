//! API-key storage for the web build.
//!
//! Desktop uses the macOS Keychain (`src-tauri/keychain.rs`); the web server
//! runs on Linux where that doesn't exist, so keys live in a JSON file inside
//! the data dir (`keys.json`, mode 0600). Same security model as the desktop
//! build: keys are written by the user, read server-side only, and never sent
//! to the browser.
//!
//! ## Optional encryption at rest (DB_KEYS_PASSPHRASE)
//!
//! - No `DB_KEYS_PASSPHRASE` env → plaintext JSON (backward compatible,
//!   existing behavior unchanged).
//! - Set in the environment → `keys.json` is AES-256-GCM encrypted with a key
//!   derived from the passphrase via Argon2id (fresh random salt per file).
//!   Existing plaintext files migrate to encrypted on first access.
//! - The passphrase is ONLY the storage layer. The real API key still flows
//!   plaintext to the provider `Authorization` header per request — encryption
//!   protects the file at rest, not the request path.
//! - Guard: if the file is encrypted and the passphrase is missing, reads
//!   return empty and writes are REFUSED (never silently overwrite encrypted
//!   keys with a plaintext file).

use std::collections::HashMap;
use std::path::Path;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::Argon2;

fn keys_file(data_dir: &Path) -> std::path::PathBuf {
    // Resolve configured directory when possible; do not create arbitrary paths
    // from potentially untrusted input in this helper.
    let stable_data_dir = data_dir
        .canonicalize()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    stable_data_dir.join("keys.json")
}

fn passphrase() -> Option<String> {
    std::env::var("DB_KEYS_PASSPHRASE").ok().filter(|s| !s.is_empty())
}

const ENC_VERSION: u8 = 1;

/** Derive a 32-byte AES key from the passphrase + salt (Argon2id). */
fn derive_key(pass: &str, salt: &[u8]) -> [u8; 32] {
    // codeql[rust/hard-coded-cryptographic-value] — output buffer of the Argon2id
    // KDF; the zeros are overwritten by hash_password_into (not a hard-coded key).
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(pass.as_bytes(), salt, &mut key)
        .expect("argon2id kdf");
    key
}

fn encrypt_map(map: &HashMap<String, String>, pass: &str) -> Result<String, String> {
    let plain = serde_json::to_vec(map).map_err(|e| e.to_string())?;
    let salt: [u8; 16] = std::array::from_fn(|_| rand::random());
    let nonce: [u8; 12] = std::array::from_fn(|_| rand::random());
    let cipher = Aes256Gcm::new_from_slice(&derive_key(pass, &salt)).map_err(|e| e.to_string())?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plain.as_slice())
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&serde_json::json!({
        "v": ENC_VERSION,
        "kdf": "argon2id",
        "salt": salt.to_vec(),
        "nonce": nonce.to_vec(),
        "data": ct,
    }))
    .map_err(|e| e.to_string())
}

fn decrypt_map(raw: &str, pass: &str) -> Result<HashMap<String, String>, String> {
    let v: serde_json::Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    let salt: Vec<u8> = v["salt"].as_array().ok_or("keys.json: missing salt")?.iter().filter_map(|x| x.as_u64().map(|n| n as u8)).collect();
    let nonce: Vec<u8> = v["nonce"].as_array().ok_or("keys.json: missing nonce")?.iter().filter_map(|x| x.as_u64().map(|n| n as u8)).collect();
    let ct: Vec<u8> = v["data"].as_array().ok_or("keys.json: missing data")?.iter().filter_map(|x| x.as_u64().map(|n| n as u8)).collect();
    let cipher = Aes256Gcm::new_from_slice(&derive_key(pass, &salt)).map_err(|e| e.to_string())?;
    let plain = cipher
        .decrypt(Nonce::from_slice(&nonce), ct.as_slice())
        .map_err(|e| format!("keys.json decrypt failed — check DB_KEYS_PASSPHRASE: {e}"))?;
    serde_json::from_slice(&plain).map_err(|e| e.to_string())
}

/** Envelope detection: `{"v":..,"kdf":..,"salt":..,...}` (encrypted) vs the
 *  plain provider map. Provider ids never collide with `"kdf"`. */
fn looks_like_envelope(raw: &str) -> bool {
    raw.trim_start().starts_with('{') && raw.contains("\"kdf\"")
}

fn load(data_dir: &Path) -> HashMap<String, String> {
    // codeql[rust/path-injection] — deployer-set data_dir, same as keys_file above
    load_with(data_dir, passphrase().as_deref())
}

fn load_with(data_dir: &Path, pass: Option<&str>) -> HashMap<String, String> {
    // codeql[rust/path-injection] — data_dir is deployer-controlled (env/config), not attacker input
    let raw = std::fs::read_to_string(keys_file(data_dir)).unwrap_or_default();
    if raw.trim().is_empty() {
        return HashMap::new();
    }
    match pass {
        Some(p) => {
            if looks_like_envelope(&raw) {
                match decrypt_map(&raw, p) {
                    Ok(m) => m,
                    Err(e) => {
                        eprintln!("[docubook] {e}");
                        HashMap::new()
                    }
                }
            } else {
                // Plaintext file + passphrase set → migrate to encrypted now.
                let map: HashMap<String, String> = serde_json::from_str(&raw).unwrap_or_default();
                if let Err(e) = save_with(data_dir, &map, Some(p)) {
                    eprintln!("[docubook] keys.json encryption migration failed: {e}");
                }
                map
            }
        }
        None => {
            if looks_like_envelope(&raw) {
                eprintln!("[docubook] keys.json is encrypted but DB_KEYS_PASSPHRASE is not set — keys unavailable");
                HashMap::new()
            } else {
                serde_json::from_str(&raw).unwrap_or_default()
            }
        }
    }
}

fn save(data_dir: &Path, map: &HashMap<String, String>) -> Result<(), String> {
    // codeql[rust/path-injection] — deployer-set data_dir, same as keys_file above
    save_with(data_dir, map, passphrase().as_deref())
}

fn save_with(data_dir: &Path, map: &HashMap<String, String>, pass: Option<&str>) -> Result<(), String> {
    // codeql[rust/path-injection] — data_dir is deployer-controlled (env/config), not attacker input
    let path = keys_file(data_dir);
    // Guard: never overwrite an encrypted file with plaintext when the
    // passphrase is missing (would silently destroy all stored keys).
    let currently_encrypted = std::fs::read_to_string(&path).map(|s| looks_like_envelope(&s)).unwrap_or(false);
    if currently_encrypted && pass.is_none() {
        return Err("keys.json is encrypted — set DB_KEYS_PASSPHRASE to modify keys".into());
    }
    let json = match pass {
        Some(p) => encrypt_map(map, p)?,
        None => serde_json::to_string_pretty(map).map_err(|e| e.to_string())?,
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create {}: {}", parent.display(), e))?;
    }
    std::fs::write(&path, json).map_err(|e| format!("Cannot write {}: {} — check the /data volume ownership", path.display(), e))?;
    #[cfg(unix)]
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    Ok(())
}

pub fn get_key(data_dir: &Path, provider: &str) -> Result<String, String> {
    load(data_dir).get(provider).cloned().ok_or_else(|| "not_found".to_string())
}

pub fn set_key(data_dir: &Path, provider: &str, key: &str) -> Result<(), String> {
    let mut map = load(data_dir);
    map.insert(provider.to_string(), key.to_string());
    save(data_dir, &map)
}

pub fn delete_key(data_dir: &Path, provider: &str) -> Result<(), String> {
    let mut map = load(data_dir);
    map.remove(provider);
    save(data_dir, &map)
}

/** Map key binding a custom base URL to a provider's key (openai-compatible
 *  custom endpoints). Separate key keeps get_key/list_keys semantics unchanged. */
fn base_url_key(provider: &str) -> String {
    format!("{}:base_url", provider)
}

pub fn set_base_url(data_dir: &Path, provider: &str, url: &str) -> Result<(), String> {
    let mut map = load(data_dir);
    map.insert(base_url_key(provider), url.to_string());
    save(data_dir, &map)
}

pub fn get_base_url(data_dir: &Path, provider: &str) -> Result<String, String> {
    load(data_dir).get(&base_url_key(provider)).cloned().ok_or_else(|| "not_found".to_string())
}

pub fn delete_base_url(data_dir: &Path, provider: &str) -> Result<(), String> {
    let mut map = load(data_dir);
    map.remove(&base_url_key(provider));
    save(data_dir, &map)
}

/** Providers that already have a saved key. */
pub fn list_keys(data_dir: &Path, providers: &[String]) -> Vec<String> {
    let map = load(data_dir);
    providers.iter().filter(|p| map.contains_key(*p)).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "db-keys-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn plaintext_backward_compat() {
        // No passphrase → plaintext JSON, exactly like before.
        let dir = tmp();
        let mut map = HashMap::new();
        map.insert("openai".to_string(), "sk-abc".to_string());
        save_with(&dir, &map, None).unwrap();
        let raw = std::fs::read_to_string(keys_file(&dir)).unwrap();
        assert!(raw.contains("sk-abc"), "no passphrase must stay plaintext");
        let loaded = load_with(&dir, None);
        assert_eq!(loaded.get("openai").map(|s| s.as_str()), Some("sk-abc"));
        let _ = std::fs::remove_file(keys_file(&dir));
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let dir = tmp();
        let mut map = HashMap::new();
        map.insert("anthropic".to_string(), "sk-ant-x".to_string());
        map.insert("openai-compatible:base_url".to_string(), "https://x.example/v1".to_string());
        save_with(&dir, &map, Some("hunter2")).unwrap();
        let raw = std::fs::read_to_string(keys_file(&dir)).unwrap();
        assert!(!raw.contains("sk-ant-x"), "passphrase set must encrypt");
        assert!(looks_like_envelope(&raw));
        let loaded = load_with(&dir, Some("hunter2"));
        assert_eq!(loaded, map);
        let _ = std::fs::remove_file(keys_file(&dir));
    }

    #[test]
    fn wrong_passphrase_fails() {
        let dir = tmp();
        let mut map = HashMap::new();
        map.insert("openai".to_string(), "sk-x".to_string());
        save_with(&dir, &map, Some("right")).unwrap();
        assert!(decrypt_map(&std::fs::read_to_string(keys_file(&dir)).unwrap(), "wrong").is_err());
        let loaded = load_with(&dir, Some("wrong"));
        assert!(loaded.is_empty(), "wrong passphrase must not return garbage");
        let _ = std::fs::remove_file(keys_file(&dir));
    }

    #[test]
    fn plaintext_migrates_to_encrypted_on_passphrase() {
        let dir = tmp();
        let mut map = HashMap::new();
        map.insert("openai".to_string(), "sk-migrate".to_string());
        save_with(&dir, &map, None).unwrap();
        // First read with a passphrase → file rewritten encrypted.
        let loaded = load_with(&dir, Some("secret"));
        assert_eq!(loaded.get("openai").map(|s| s.as_str()), Some("sk-migrate"));
        let raw = std::fs::read_to_string(keys_file(&dir)).unwrap();
        assert!(looks_like_envelope(&raw), "must migrate to encrypted");
        assert!(load_with(&dir, Some("secret")).get("openai").is_some());
        let _ = std::fs::remove_file(keys_file(&dir));
    }

    #[test]
    fn missing_passphrase_never_overwrites_encrypted() {
        let dir = tmp();
        let mut map = HashMap::new();
        map.insert("openai".to_string(), "sk-x".to_string());
        save_with(&dir, &map, Some("secret")).unwrap();
        // No passphrase: reads empty, writes refused.
        assert!(load_with(&dir, None).is_empty());
        let mut m2 = HashMap::new();
        m2.insert("openai".to_string(), "sk-new".to_string());
        assert!(save_with(&dir, &m2, None).is_err(), "must refuse to overwrite encrypted file");
        // Original still intact & decryptable.
        assert_eq!(load_with(&dir, Some("secret")).get("openai").map(|s| s.as_str()), Some("sk-x"));
        let _ = std::fs::remove_file(keys_file(&dir));
    }
}
