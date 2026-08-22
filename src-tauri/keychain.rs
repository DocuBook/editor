/// macOS Keychain access via the `security` CLI.
///
/// Uses the OS `security` command instead of the keyring crate because
/// keyring 3.6.3 writes to a process-scoped location on macOS 12 and its
/// entries do not persist across processes (verified: cross-process reads
/// return NoEntry while the `security` CLI persists correctly).
use std::{collections::HashSet, process::Command, sync::Mutex};

const SERVICE: &str = "com.docubook.editor";
const MAX_PROVIDER_COUNT: usize = 64;
const MAX_PROVIDER_ID_BYTES: usize = 128;
static KEY_SCAN_LOCK: Mutex<()> = Mutex::new(());

/** Store an API key in the login keychain. Upserts if the entry exists. */
pub fn set_key(provider: &str, key: &str) -> Result<(), String> {
    let out = Command::new("security")
        .args(["add-generic-password", "-s", SERVICE, "-a", provider, "-w", key, "-U"])
        .output()
        .map_err(|e| format!("security add failed: {}", e))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/** Read an API key from the login keychain. */
pub fn get_key(provider: &str) -> Result<String, String> {
    let out = Command::new("security")
        .args(["find-generic-password", "-s", SERVICE, "-a", provider, "-w"])
        .output()
        .map_err(|e| format!("security find failed: {}", e))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err("not_found".to_string())
    }
}

/** Delete an API key from the login keychain. Entry-not-found is treated as success (already gone). */
pub fn delete_key(provider: &str) -> Result<(), String> {
    let out = Command::new("security")
        .args(["delete-generic-password", "-s", SERVICE, "-a", provider])
        .output()
        .map_err(|e| format!("security delete failed: {}", e))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("could not be found") || stderr.contains("not found") {
        Ok(())
    } else {
        Err(stderr.trim().to_string())
    }
}

/** Account suffix binding a custom base URL to a provider's key
 *  (openai-compatible custom endpoints). Kept as a separate entry so
 *  get_key/list_keys semantics are unchanged. */
fn base_url_account(provider: &str) -> String {
    format!("{}:base_url", provider)
}

/** Store the base URL bound to a provider's API key. */
pub fn set_base_url(provider: &str, url: &str) -> Result<(), String> {
    let out = Command::new("security")
        .args(["add-generic-password", "-s", SERVICE, "-a", &base_url_account(provider), "-w", url, "-U"])
        .output()
        .map_err(|e| format!("security add failed: {}", e))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/** Read the base URL bound to a provider's API key (custom endpoints). */
pub fn get_base_url(provider: &str) -> Result<String, String> {
    let out = Command::new("security")
        .args(["find-generic-password", "-s", SERVICE, "-a", &base_url_account(provider), "-w"])
        .output()
        .map_err(|e| format!("security find failed: {}", e))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err("not_found".to_string())
    }
}

/** Delete the base URL bound to a provider's key. Entry-not-found is treated as success. */
pub fn delete_base_url(provider: &str) -> Result<(), String> {
    let out = Command::new("security")
        .args(["delete-generic-password", "-s", SERVICE, "-a", &base_url_account(provider)])
        .output()
        .map_err(|e| format!("security delete failed: {}", e))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("could not be found") || stderr.contains("not found") {
        Ok(())
    } else {
        Err(stderr.trim().to_string())
    }
}

fn bounded_providers(providers: &[String]) -> Result<Vec<String>, String> {
    if providers.len() > MAX_PROVIDER_COUNT {
        return Err(format!("Too many providers (maximum {})", MAX_PROVIDER_COUNT));
    }
    let mut seen = HashSet::new();
    let unique: Vec<_> = providers.iter().filter(|p| seen.insert(p.as_str())).cloned().collect();
    if unique.iter().any(|p| p.len() > MAX_PROVIDER_ID_BYTES) {
        return Err(format!("Provider ID is too long (maximum {} bytes)", MAX_PROVIDER_ID_BYTES));
    }
    Ok(unique)
}

/** Return the subset of providers that have an API key in the login keychain.
 *  Each `security` call is a short-lived process, so checks run in bounded
 *  parallel batches (16 at a time). Duplicate and oversized input is rejected
 *  before spawning; scans are serialized to cap total concurrent subprocesses. */
pub fn list_keys(providers: &[String]) -> Result<Vec<String>, String> {
    let providers = bounded_providers(providers)?;
    if providers.is_empty() {
        return Ok(Vec::new());
    }
    let _scan = KEY_SCAN_LOCK.lock().map_err(|_| "Keychain scan lock failed".to_string())?;
    let mut found = Vec::new();
    for chunk in providers.chunks(16) {
        std::thread::scope(|s| {
            let handles: Vec<_> = chunk.iter().map(|p| {
                let p = p.clone();
                s.spawn(move || {
                    Command::new("security")
                        .args(["find-generic-password", "-s", SERVICE, "-a", &p, "-w"])
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false)
                })
            }).collect();
            for (h, p) in handles.into_iter().zip(chunk.iter()) {
                if h.join().unwrap_or(false) {
                    found.push(p.clone());
                }
            }
        });
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_keys_empty_is_a_noop() {
        let empty: Vec<String> = vec![];
        assert!(list_keys(&empty).unwrap().is_empty());
    }

    #[test]
    fn bounded_providers_deduplicates_in_order() {
        let providers = vec!["anthropic".into(), "google".into(), "anthropic".into()];
        assert_eq!(bounded_providers(&providers).unwrap(), ["anthropic", "google"]);
    }

    #[test]
    fn bounded_providers_rejects_excess_work_and_long_ids() {
        let many: Vec<_> = (0..=MAX_PROVIDER_COUNT).map(|i| format!("provider-{i}")).collect();
        assert!(bounded_providers(&many).is_err());
        assert!(bounded_providers(&["x".repeat(MAX_PROVIDER_ID_BYTES + 1)]).is_err());
    }
}
