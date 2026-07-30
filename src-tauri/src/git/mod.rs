
use std::process::Command;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct PushResult { pub success: bool, pub commit: String, pub message: String, pub error: String }

/// Git repository wrapper for add-commit-push operations.
pub struct Git { pub repo_path: String }

impl Git {
/** Open a git repository at the given path. */
    pub fn open(path: &str) -> Self { Self { repo_path: path.to_string() } }
/** Check if the path is a valid git repository. */
    pub fn is_repo(&self)  -> bool {
        Command::new("git").args(["rev-parse", "--git-dir"]).current_dir(&self.repo_path).output().is_ok()
    }
/** Return git status as porcelain string. */
    pub fn status(&self) -> Result<String, String> {
        let out = Command::new("git").args(["status", "--porcelain"]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
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
