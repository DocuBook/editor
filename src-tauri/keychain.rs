/// macOS Keychain access via the `security` CLI.
///
/// Uses the OS `security` command instead of the keyring crate because
/// keyring 3.6.3 writes to a process-scoped location on macOS 12 and its
/// entries do not persist across processes (verified: cross-process reads
/// return NoEntry while the `security` CLI persists correctly).
use std::process::Command;

const SERVICE: &str = "com.docubook.editor";

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

/** Return the subset of providers that have an API key in the login keychain.
 *  Each `security` call is a short-lived process, so checks run in bounded
 *  parallel batches (16 at a time) instead of 100+ sequential spawns.
 *  An empty provider list is a no-op (no keychain access). */
pub fn list_keys(providers: &[String]) -> Vec<String> {
    if providers.is_empty() {
        return Vec::new();
    }
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
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_keys_empty_is_a_noop() {
        let empty: Vec<String> = vec![];
        assert!(list_keys(&empty).is_empty());
    }
}
