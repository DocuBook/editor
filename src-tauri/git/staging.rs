//! Staging: `add_all` (whole worktree, `.trash` excluded) and `stage_path`
//! (a single file — what the editor save flow uses). No commit/push here.

use std::process::Command;

use super::Git;

impl Git {
/** Stage all changes, excluding the vault `.trash/` (deleted notes must not be
 *  committed as moves into the trash). Pathspec works for any repo, no
 *  .gitignore required. */
    pub fn add_all(&self) -> Result<(), String> {
        let out = Command::new("git").args(["add", "-A", "--", ".", ":!.trash"]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        Ok(())
    }
/** Stage a single path (the active tab) — never touches other files, unlike
 *  add_all. The `.trash` exclusion from add_all does not apply: editor saves
 *  only ever target live vault files. */
    pub fn stage_path(&self, path: &str) -> Result<(), String> {
        let out = Command::new("git").args(["add", "--", path]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_util::temp_git_repo;

    #[test]
    fn stage_path_stages_only_that_file() {
        let dir = temp_git_repo("stage-path");
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        std::fs::write(dir.join("a.md"), "a").unwrap();
        std::fs::write(dir.join("b.md"), "b").unwrap();
        g.stage_path("a.md").unwrap();
        let ws = g.status_with_branch().unwrap();
        // XY pair "A." = staged add, worktree unchanged; b.md is only
        // reported as untracked ("? b.md") — never staged.
        assert!(ws.status.contains("A. a.md"));
        assert!(ws.status.contains("? b.md"));
        assert!(!ws.status.contains("A. b.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
