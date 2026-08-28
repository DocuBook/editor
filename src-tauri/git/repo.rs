//! Repository-level lifecycle: existence check (`is_repo`), `git init`, and
//! `clone_repo`. Nothing worktree/staging/commit related lives here.

use std::process::Command;

use super::Git;
use super::remote::is_remote_url;

impl Git {
    /** Check if the path is a valid git repository (exit status, not just command ran).
     *  Uses .output() (pipes stdout) so git does not print to the app terminal —
     *  .status() inherits stdout and would spam `git rev-parse --git-dir` output (".git"). */
    pub fn is_repo(&self)  -> bool {
        Command::new("git").args(["rev-parse", "--git-dir"]).current_dir(&self.repo_path).output().map(|o| o.status.success()).unwrap_or(false)
    }
/** Initialize a git repository in the vault folder (git init). */
    pub fn init(&self) -> Result<(), String> {
        let out = Command::new("git").arg("init").current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
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

/** Derive a safe folder name from a repository URL (last path segment, minus .git).
 *  Rejects empty/traversal names ("", ".", "..", "/", "\\"). */
fn clone_name(url: &str) -> Option<String> {
    let name = url.trim_end_matches('/').rsplit('/').next()?.to_string();
    let name = name.strip_suffix(".git").unwrap_or(&name).to_string();
    if name.is_empty() || name == "." || name.contains("..") || name.contains('/') || name.contains('\\') { None } else { Some(name) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_util::temp_git_repo;

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
        let dir = temp_git_repo("init");
        let g = Git::open(dir.to_str().unwrap());
        assert!(!g.is_repo());
        g.init().unwrap();
        assert!(g.is_repo());
        let _ = std::fs::remove_dir_all(&dir);
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
