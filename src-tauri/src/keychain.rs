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
