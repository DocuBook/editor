//! Commits: `commit` (raw git commit), `commit_all` (worktree-aware wrapper
//! returning `Nothing to commit` on an empty worktree), and `has_commits`
//! (HEAD existence — push needs it to avoid a doomed `-u` on empty repos).

use std::process::Command;
use serde::Serialize;

use super::Git;

/** Result of `commit_all` — an empty worktree is a success with `Nothing to commit`. */
#[derive(Debug, Serialize)]
pub struct CommitResult { pub success: bool, pub commit: String, pub message: String, pub error: String }

impl Git {
/** Commit with message. Returns commit hash. */
    pub fn commit(&self, msg: &str) -> Result<String, String> {
        let m = if msg.is_empty() { "Auto-commit from Editor" } else { msg };
        let out = Command::new("git").args(["commit", "-m", m]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        let hash = Command::new("git").args(["rev-parse", "HEAD"]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&hash.stdout).trim().to_string())
    }
/** Commit what is staged. An empty worktree is a success with
 *  `Nothing to commit` (the commit box stays open, no error state). */
    pub fn commit_all(&self, msg: &str) -> CommitResult {
        if !self.is_repo() { return CommitResult { success: false, commit: String::new(), message: String::new(), error: "Not a git repo".into() } }
        let status = match self.status() { Ok(s) => s, Err(e) => return CommitResult { success: false, commit: String::new(), message: String::new(), error: e.to_string() } };
        if status.trim().is_empty() { return CommitResult { success: true, commit: String::new(), message: "Nothing to commit".into(), error: String::new() } }
        match self.commit(msg) {
            Ok(h) => CommitResult { success: true, commit: h, message: "Committed".into(), error: String::new() },
            Err(e) => CommitResult { success: false, commit: String::new(), message: String::new(), error: format!("Commit: {}", e) },
        }
    }
/** True if HEAD points at a commit (a brand-new repository with no commits
 *  cannot be pushed even with -u — git rejects the empty refspec). */
    pub(crate) fn has_commits(&self) -> bool {
        Command::new("git").args(["rev-parse", "--verify", "HEAD"]).current_dir(&self.repo_path).output().map(|o| o.status.success()).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_util::temp_git_repo;

    #[test]
    fn commit_all_flow() {
        let dir = temp_git_repo("commit-all");
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        g.set_identity("T", "t@e.c").unwrap();
        let r1 = g.commit_all("Auto-commit: x");
        assert!(r1.success);
        assert_eq!(r1.message, "Nothing to commit");
        std::fs::write(dir.join("a.md"), "hello").unwrap();
        g.add_all().unwrap();
        let r2 = g.commit_all("Auto-commit: a.md");
        assert!(r2.success);
        assert_eq!(r2.message, "Committed");
        assert!(r2.commit.len() >= 7);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
