//! Branch listing and switching — the contract for the status-bar switcher
//! lives here and must stay in sync with `frontend/components/StatusBar.tsx`:
//!
//! Listed (from actual refs, never hardcoded):
//! - every local branch (`refs/heads/*`) → `remote: false`
//! - remote-tracking refs (`refs/remotes/*`) → `remote: true` EXCEPT
//!   `<remote>/HEAD` (symbolic default pointer — not a branch) and refs whose
//!   local counterpart already exists (dedupe by the name a checkout would
//!   create, i.e. after the first '/': `origin/feature/x` → `feature/x`).
//!
//! Switching: local → `git checkout`; remote → `git switch -c <short>
//! --track <remote-full>` UNLESS the local branch already exists (plain
//! checkout — never a "-c" collision).

use std::process::Command;
use serde::Serialize;

use super::Git;

/** A branch for the switcher: local (`remote: false`) or a remote-tracking
 *  ref (`remote: true`, full name like `origin/dev`). Sourced from the actual
 *  refs — never assumed/hardcoded. */
#[derive(Debug, Serialize, PartialEq)]
pub struct BranchRef {
    pub name: String,
    pub remote: bool,
}

impl Git {
/** List branches from actual refs — local (`refs/heads`) first, then
 *  remote-tracking (`refs/remotes`). See the module doc for the full
 *  contract. */
    pub fn branches(&self) -> Result<Vec<BranchRef>, String> {
        let out = Command::new("git").args(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        let mut refs: Vec<BranchRef> = Vec::new();
        let mut local: Vec<String> = Vec::new();
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("refs/heads/") {
                local.push(rest.to_string());
                refs.push(BranchRef { name: rest.to_string(), remote: false });
            } else if let Some(rest) = line.strip_prefix("refs/remotes/") {
                // origin/HEAD (+ <remote>/HEAD) is the symbolic default-branch
                // pointer, not a branch — never list it ("switch -c HEAD" fatal).
                if rest.ends_with("/HEAD") { continue; }
                // The local branch a checkout would create is the name after the
                // FIRST '/': "origin/feature/x" → "feature/x". Comparing the last
                // segment would let nested remote branches through dedupe and
                // then fail with "a branch named ... already exists".
                let short = rest.split_once('/').map(|(_, b)| b).unwrap_or(rest).to_string();
                if !local.contains(&short) {
                    refs.push(BranchRef { name: rest.to_string(), remote: true });
                }
            }
        }
        Ok(refs)
    }
/** Switch branches. `remote: false` → plain `git checkout <name>`; `remote:
 *  true` (name like `origin/dev`) → `git switch -c dev --track origin/dev`,
 *  creating the local tracking branch. Name is argv-passed (no shell
 *  injection) and validated so it can never be parsed as a flag. */
    pub fn checkout_branch(&self, name: &str, remote: bool) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() || name.starts_with('-') { return Err("Invalid branch name".into()); }
        if remote {
            let Some((_, short)) = name.split_once('/') else { return Err("Invalid remote branch name".into()); };
            if short.is_empty() || short.starts_with('-') || short == "HEAD" { return Err("Invalid remote branch name".into()); }
            // Idempotent: the local tracking branch may already exist (created
            // earlier, or by a teammate) — plain checkout then, never -c.
            let local_exists = self.branches().unwrap_or_default().iter().any(|b| !b.remote && b.name == short);
            let args = if local_exists { vec!["checkout", short] } else { vec!["switch", "-c", short, "--track", name] };
            let out = Command::new("git").args(&args).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
            if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
            return Ok(());
        }
        let out = Command::new("git").args(["checkout", name]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_util::temp_git_repo;

    #[test]
    fn branches_list_and_checkout() {
        let dir = temp_git_repo("branches");
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        g.set_identity("T", "t@e.c").unwrap();
        std::fs::write(dir.join("a.md"), "a").unwrap();
        g.add_all().unwrap();
        g.commit("first").unwrap();
        let names = |g: &Git| g.branches().unwrap().into_iter().map(|b| (b.name, b.remote)).collect::<Vec<_>>();
        let base = names(&g);
        assert_eq!(base.len(), 1);
        Command::new("git").args(["switch", "-c", "dev"]).current_dir(&dir).output().unwrap();
        let bs = names(&g);
        assert!(bs.contains(&("dev".to_string(), false)));
        assert_eq!(bs.len(), 2);
        g.checkout_branch(base[0].0.as_str(), false).unwrap();
        assert!(names(&g).contains(&("dev".to_string(), false)));
        // flag injection and empty names are rejected before reaching git
        assert!(g.checkout_branch("", false).is_err());
        assert!(g.checkout_branch("-x", false).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nested_remote_branch_dedupes_and_checkout_is_idempotent() {
        let dir = temp_git_repo("branches-nested");
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        g.set_identity("T", "t@e.c").unwrap();
        std::fs::write(dir.join("a.md"), "a").unwrap();
        g.add_all().unwrap();
        g.commit("first").unwrap();
        g.add_remote("origin", "https://example.invalid/repo.git").unwrap();
        // Local branch "feature/x" AND remote "origin/feature/x" exist
        Command::new("git").args(["switch", "-c", "feature/x"]).current_dir(&dir).output().unwrap();
        Command::new("git").args(["update-ref", "refs/remotes/origin/feature/x", "HEAD"]).current_dir(&dir).output().unwrap();
        let names = g.branches().unwrap();
        assert!(names.contains(&BranchRef { name: "feature/x".into(), remote: false }));
        // Nested remote must be deduped (short name after the FIRST '/')
        assert!(!names.iter().any(|b| b.remote && b.name == "origin/feature/x"));
        // Idempotent: local already exists → plain checkout, no "-c" collision
        g.checkout_branch("origin/feature/x", true).unwrap();
        let state = g.status_with_branch().unwrap();
        assert_eq!(state.branch, "feature/x");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn branches_include_remote_refs_and_switch_creates_tracking() {
        let dir = temp_git_repo("branches-remote");
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        g.set_identity("T", "t@e.c").unwrap();
        std::fs::write(dir.join("a.md"), "a").unwrap();
        g.add_all().unwrap();
        g.commit("first").unwrap();
        // Simulate a fetched remote without network: configured remote + ref
        g.add_remote("origin", "https://example.invalid/repo.git").unwrap();
        Command::new("git").args(["update-ref", "refs/remotes/origin/feat", "HEAD"]).current_dir(&dir).output().unwrap();
        // origin/HEAD symbolic default pointer must never be listed
        Command::new("git").args(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]).current_dir(&dir).output().unwrap();
        let names = g.branches().unwrap();
        assert!(names.contains(&BranchRef { name: "origin/feat".into(), remote: true }));
        assert!(!names.iter().any(|b| b.name == "origin/HEAD"));
        // Checking out the remote ref creates a local tracking branch "feat"
        g.checkout_branch("origin/feat", true).unwrap();
        let state = g.status_with_branch().unwrap();
        assert_eq!(state.branch, "feat");
        // Malformed remote names are rejected
        assert!(g.checkout_branch("origin", true).is_err());
        assert!(g.checkout_branch("origin/-x", true).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
