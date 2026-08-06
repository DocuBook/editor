
use std::process::Command;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct PushResult { pub success: bool, pub commit: String, pub message: String, pub error: String }

/// Git repository wrapper for add-commit-push operations.
pub struct Git { pub repo_path: String }

impl Git {
/** Open a git repository at the given path. */
    pub fn open(path: &str) -> Self { Self { repo_path: path.to_string() } }
/** Check if the path is a valid git repository (exit status, not just command ran).
 *  Uses .output() (pipes stdout) so git does not print to the app terminal —
 *  .status() inherits stdout and would spam `git rev-parse --git-dir` output (".git"). */
    pub fn is_repo(&self)  -> bool {
        Command::new("git").args(["rev-parse", "--git-dir"]).current_dir(&self.repo_path).output().map(|o| o.status.success()).unwrap_or(false)
    }
/** Return git status as porcelain string. */
    pub fn status(&self) -> Result<String, String> {
        let out = Command::new("git").args(["status", "--porcelain"]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    /** Branch + status in ONE git subprocess (PERF: the old two-command
     *  rev-parse + status cost ~2× per 3s poll). Runs `status --porcelain=v2 -b`
     *  and maps v2 lines back to v1-style `XY path` so frontend parsers are
     *  unchanged. Returns (branch, v1_status_string). */
    pub fn status_with_branch(&self) -> Result<(String, String), String> {
        let out = Command::new("git")
            .args(["status", "--porcelain=v2", "-b"])
            .current_dir(&self.repo_path)
            .output()
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out.stdout);
        let mut branch = String::new();
        let mut lines: Vec<String> = Vec::new();
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("# branch.head ") {
                branch = rest.trim().to_string();
            } else if let Some(rest) = line.strip_prefix("1 ") {
                // v2: 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path> → v1: XY path
                let mut it = rest.split_whitespace();
                if let (Some(xy), Some(path)) = (it.next(), it.last()) {
                    lines.push(format!("{xy} {path}"));
                }
            } else if let Some(rest) = line.strip_prefix("? ") {
                lines.push(format!("? {}", rest.trim()));
            }
        }
        Ok((branch, lines.join("\n")))
    }
/** Stage all changes. */
    pub fn add_all(&self) -> Result<(), String> {
        Command::new("git").args(["add", "-A"]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        Ok(())
    }
/** Commit with message. Returns commit hash. */
    pub fn commit(&self, msg: &str) -> Result<String, String> {
        let m = if msg.is_empty() { "Auto-commit from Editor" } else { msg };
        Command::new("git").args(["commit", "-m", m]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        let hash = Command::new("git").args(["rev-parse", "HEAD"]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&hash.stdout).trim().to_string())
    }
/** Push to remote. */
    pub fn push(&self) -> Result<(), String> {
        Command::new("git").args(["push"]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        Ok(())
    }
/** Add → commit → push in one call. Returns PushResult. */
    pub fn push_full(&self, msg: &str) -> PushResult {
        if !self.is_repo() { return PushResult { success: false, commit: String::new(), message: String::new(), error: "Not a git repo".into() } }
        let status = match self.status() { Ok(s) => s, Err(e) => return PushResult { success: false, commit: String::new(), message: String::new(), error: e.to_string() } };
        if status.trim().is_empty() { return PushResult { success: true, commit: String::new(), message: "Nothing to push".into(), error: String::new() } }
        if let Err(e) = self.add_all() { return PushResult { success: false, commit: String::new(), message: String::new(), error: format!("Add: {}", e) } }
        let hash = match self.commit(msg) { Ok(h) => h, Err(e) => return PushResult { success: false, commit: String::new(), message: String::new(), error: format!("Commit: {}", e) } };
        if let Err(e) = self.push() { return PushResult { success: false, commit: hash, message: String::new(), error: format!("Push: {}", e) } }
        PushResult { success: true, commit: hash, message: "Pushed".into(), error: String::new() }
    }
}

/** Derive a safe folder name from a repository URL (last path segment, minus .git).
 *  Rejects empty/traversal names ("", ".", "..", "/", "\\"). */
fn clone_name(url: &str) -> Option<String> {
    let name = url.trim_end_matches('/').rsplit('/').next()?.to_string();
    let name = name.strip_suffix(".git").unwrap_or(&name).to_string();
    if name.is_empty() || name == "." || name.contains("..") || name.contains('/') || name.contains('\\') { None } else { Some(name) }
}

impl Git {
/** Initialize a git repository in the vault folder (git init). */
    pub fn init(&self) -> Result<(), String> {
        let out = Command::new("git").arg("init").current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        Ok(())
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
/** Read commit identity (local then global git config). Returns (name, email). */
    pub fn identity(&self) -> Result<(String, String), String> {
        Ok((self.config("user.name"), self.config("user.email")))
    }
    fn config(&self, key: &str) -> String {
        Command::new("git").args(["config", "--get", key]).current_dir(&self.repo_path).output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
    }
/** Set repo-local commit identity. Does NOT touch the user's global git config. */
    pub fn set_identity(&self, name: &str, email: &str) -> Result<(), String> {
        if name.trim().is_empty() || email.trim().is_empty() { return Err("Name and email are required".into()); }
        for (k, v) in [("user.name", name.trim()), ("user.email", email.trim())] {
            let out = Command::new("git").args(["config", k, v]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
            if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        }
        Ok(())
    }
/** Clone a remote repository into `parent/<name>` (name derived from URL).
 *  Returns the cloned directory path. Safe: URL passed as argv (no shell injection),
 *  folder name validated against traversal. Only remote sources are accepted
 *  (https/http/ssh/git schemes or scp-like [user@]host:path); local paths are
 *  rejected — "Open Folder" covers those. Falls back to the system git binary,
 *  so existing vaults / credentials (SSH key, keychain credential helper) work unchanged. */
    pub fn clone_repo(url: &str, parent: &str) -> Result<String, String> {
        let url = url.trim();
        if !is_remote_url(url) {
            return Err("Invalid repository URL — use https://, git@host:path, ssh://, or git:// (local paths are not supported; use Open Folder instead)".into());
        }
        let name = clone_name(url).ok_or_else(|| format!("Invalid repository URL: cannot derive folder name from \"{url}\""))?;
        let dest = std::path::Path::new(parent).join(&name);
        if dest.exists() {
            return Err(format!("Folder \"{}\" already exists — pick another URL or parent folder", dest.display()));
        }
        let out = Command::new("git")
            .args(["clone", url, dest.to_str().ok_or("Invalid path")?])
            .output()
            .map_err(|e| format!("git binary not found: {}", e))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(dest.to_string_lossy().to_string())
    }
}

/** True if the URL is a remote repository source: a scheme:// URL (except file://)
 *  or an scp-like [user@]host:path form. Local paths (/…, ~/…, ./…, plain name)
 *  are rejected. */
fn is_remote_url(url: &str) -> bool {
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
    fn clone_name_derives_from_url() {
        assert_eq!(clone_name("https://github.com/user/repo.git").as_deref(), Some("repo"));
        assert_eq!(clone_name("https://github.com/user/repo").as_deref(), Some("repo"));
        assert_eq!(clone_name("git@github.com:user/repo.git").as_deref(), Some("repo"));
        assert_eq!(clone_name("ssh://git@host:22/path/repo").as_deref(), Some("repo"));
        assert_eq!(clone_name("https://host/a/b/").as_deref(), Some("b"));
    }

    #[test]
    fn clone_name_rejects_traversal() {
        assert_eq!(clone_name("https://host/.."), None);
        assert_eq!(clone_name("https://host/."), None);
        assert_eq!(clone_name(""), None);
        // bare-host URL derives a safe folder name; git itself will fail the clone
        assert_eq!(clone_name("https://host/").as_deref(), Some("host"));
    }

    #[test]
    fn init_creates_a_repo() {
        // Unique dir per invocation — a stable {pid} suffix would collide across
        // parallel cargo-test threads if any second test reuses this pattern.
        let dir = std::env::temp_dir().join(format!(
            "docubook-test-init-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let g = Git::open(dir.to_str().unwrap());
        assert!(!g.is_repo());
        g.init().unwrap();
        assert!(g.is_repo());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_settings_validation_without_repo() {
        // add_remote validation runs before any git call — testable without a repo
        let g = Git::open("/nonexistent");
        assert!(g.add_remote("bad name", "https://x/y.git").is_err());
        assert!(g.add_remote("../evil", "https://x/y.git").is_err());
        assert!(g.add_remote("origin", "/tmp/local").is_err());
        assert!(g.add_remote("origin", "file:///tmp/x").is_err());
        assert!(g.set_identity("", "a@b.c").is_err());
        assert!(g.set_identity("N", "").is_err());
    }

    #[test]
    fn clone_repo_validates_url_without_network() {
        assert!(Git::clone_repo("", "/tmp").is_err());
        assert!(Git::clone_repo("file:///etc", "/tmp").is_err());
        assert!(Git::clone_repo("https://host/..", "/tmp").is_err());
        // local paths are rejected (use Open Folder instead)
        assert!(Git::clone_repo("/tmp/foo", "/tmp").is_err());
        assert!(Git::clone_repo("~/repo", "/tmp").is_err());
        assert!(Git::clone_repo("./repo", "/tmp").is_err());
        assert!(Git::clone_repo("repo", "/tmp").is_err());
        // valid remotes still accepted
        assert!(is_remote_url("https://github.com/user/repo.git"));
        assert!(is_remote_url("http://host/repo.git"));
        assert!(is_remote_url("ssh://git@host:22/path/repo"));
        assert!(is_remote_url("git://host/repo"));
        assert!(is_remote_url("git@github.com:user/repo.git"));
        assert!(is_remote_url("host:user/repo"));
        // non-remotes
        assert!(!is_remote_url(""));
        assert!(!is_remote_url("file:///tmp/x"));
        assert!(!is_remote_url("/tmp/x"));
        assert!(!is_remote_url("~/x"));
        assert!(!is_remote_url("./x"));
        assert!(!is_remote_url("plainname"));
    }
}
