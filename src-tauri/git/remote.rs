//! Remotes: list/add/remove and URL validation (`is_remote_url` — also used
//! by `repo::clone_repo`). URL checks run before any git call, so validation
//! is testable without a repository.

use std::process::Command;

use super::Git;

impl Git {
    /** Check whether at least one remote is configured. */
    #[allow(dead_code)] // Shared server build does not use this desktop-only query.
    pub fn has_remote(&self) -> bool {
        Command::new("git").arg("remote").current_dir(&self.repo_path).output().map(|o| o.status.success() && !o.stdout.is_empty()).unwrap_or(false)
    }
/** List configured remotes as (name, url) pairs (git remote -v, deduped). */
    pub fn remotes(&self) -> Result<Vec<(String, String)>, String> {
        let out = Command::new("git").args(["remote", "-v"]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        let mut v: Vec<(String, String)> = Vec::new();
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 && !v.iter().any(|(n, u)| n == parts[0] && u == parts[1]) {
                v.push((parts[0].to_string(), parts[1].to_string()));
            }
        }
        Ok(v)
    }
/** Add a remote (git remote add <name> <url>). URL validated as remote-only (no local paths). */
    pub fn add_remote(&self, name: &str, url: &str) -> Result<(), String> {
        if name.is_empty() || name.contains('/') || name.contains(' ') || name == "." || name.contains("..") {
            return Err("Invalid remote name".into());
        }
        if !is_remote_url(url) {
            return Err("Invalid remote URL — use https://, git@host:path, ssh://, or git://".into());
        }
        let out = Command::new("git").args(["remote", "add", name, url]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        Ok(())
    }
/** Remove a remote. */
    pub fn remove_remote(&self, name: &str) -> Result<(), String> {
        let out = Command::new("git").args(["remote", "remove", name]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        Ok(())
    }
}

/** True if the URL is a remote repository source: a scheme:// URL (except file://)
 *  or an scp-like [user@]host:path form. Local paths (/…, ~/…, ./…, plain name)
 *  are rejected. */
pub(crate) fn is_remote_url(url: &str) -> bool {
    if url.is_empty() { return false; }
    if url.contains("://") { return !url.starts_with("file://"); }
    // scp-like: [user@]host:path — no spaces, host has no '/' , path non-empty
    let Some((host, path)) = url.split_once(':') else { return false };
    let host = host.rsplit_once('@').map(|(_, h)| h).unwrap_or(host);
    !host.is_empty() && !host.contains('/') && !path.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_remote_validation_without_repo() {
        // add_remote validation runs before any git call — testable without a repo
        let g = Git::open("/nonexistent");
        assert!(g.add_remote("bad name", "https://x/y.git").is_err());
        assert!(g.add_remote("../evil", "https://x/y.git").is_err());
        assert!(g.add_remote("origin", "/tmp/local").is_err());
        assert!(g.add_remote("origin", "file:///tmp/x").is_err());
    }
}
