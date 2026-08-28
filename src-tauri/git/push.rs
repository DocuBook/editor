//! Pushing: `push_checked` — upstream-aware push. Nothing ahead (with an
//! upstream) → `Nothing to push`; no upstream → push with `-u <remote> <branch>`
//! so the tracking ref is created. Independent of the worktree state, fixing
//! the old push_full retry trap: a clean worktree after a failed push used to
//! report "Nothing to push" forever.

use std::process::Command;
use serde::Serialize;

use super::Git;

/** Result of a push attempt. `commit` is unused (kept for message symmetry). */
#[derive(Debug, Serialize)]
pub struct PushResult { pub success: bool, pub commit: String, pub message: String, pub error: String }

impl Git {
/** Push commits to the configured upstream. Nothing ahead → `Nothing to push`
 *  (success, no-op). Independent of the worktree state, fixing the old
 *  push_full retry trap: a clean worktree after a failed push used to report
 *  "Nothing to push" forever, stranding the un-pushed commit.
 *
 *  Branch without upstream (first push): push with `-u <remote> <branch>` so
 *  the tracking ref is created — the StatusBar shows the branch as untracked
 *  until then instead of blocking Push (ahead is meaningless without upstream). */
    pub fn push_checked(&self) -> PushResult {
        if !self.is_repo() { return PushResult { success: false, commit: String::new(), message: String::new(), error: "Not a git repo".into() } }
        let ws = match self.status_with_branch() { Ok(w) => w, Err(e) => return PushResult { success: false, commit: String::new(), message: String::new(), error: e.to_string() } };
        let no_upstream = ws.upstream.is_empty();
        if !no_upstream && ws.ahead == 0 {
            return PushResult { success: true, commit: String::new(), message: "Nothing to push".into(), error: String::new() };
        }
        if no_upstream && !self.has_commits() {
            // Brand-new repo (no commits yet): nothing to push — and git would
            // reject the empty refspec even with -u.
            return PushResult { success: true, commit: String::new(), message: "Nothing to push".into(), error: String::new() };
        }
        let mut cmd = Command::new("git");
        cmd.arg("push").current_dir(&self.repo_path);
        if no_upstream {
            // Detached HEAD ("(HEAD detached at …)") cannot take -u — fall back
            // to a plain push whose stderr explains the situation.
            if !ws.branch.starts_with('(') {
                let remotes = self.remotes().unwrap_or_default();
                let remote = if remotes.iter().any(|(n, _)| n == "origin") { "origin" } else { remotes.first().map(|(n, _)| n.as_str()).unwrap_or("origin") };
                cmd.arg("-u").arg(remote).arg(&ws.branch);
            }
        }
        let out = match cmd.output() { Ok(o) => o, Err(e) => return PushResult { success: false, commit: String::new(), message: String::new(), error: e.to_string() } };
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return PushResult { success: false, commit: String::new(), message: String::new(), error: if stderr.is_empty() { "Push failed".into() } else { stderr } };
        }
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        PushResult { success: true, commit: String::new(), message: if stdout.is_empty() { "Pushed".into() } else { stdout }, error: String::new() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_util::temp_git_repo;

    #[test]
    fn push_checked_nothing_to_push_without_remote() {
        let dir = temp_git_repo("push-checked");
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        // No commits yet → "Nothing to push" (never attempts a doomed -u push).
        let r = g.push_checked();
        assert!(r.success);
        assert_eq!(r.message, "Nothing to push");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
