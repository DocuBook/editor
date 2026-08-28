//! Worktree state: `status` (porcelain v1) and `status_with_branch` — the
//! single-subprocess poll feeding the 3s poller (branch + upstream +
//! ahead/behind + v1 status lines). Parsing is the pure `parse_porcelain_v2`.
//! Nothing here stages, commits, or pushes.

use std::process::Command;
use serde::Serialize;

use super::Git;

/** Parsed `status --porcelain=v2 -b` summary: branch name, v1-style status
 *  lines (`XY path`), upstream tracking ref (empty = never pushed), and
 *  ahead/behind counts vs that upstream. */
#[derive(Debug, Default, Serialize)]
pub struct WorktreeStatus {
    pub branch: String,
    pub upstream: String,
    pub status: String,
    pub ahead: usize,
    pub behind: usize,
}

impl Git {
/** Return git status as porcelain string. */
    pub fn status(&self) -> Result<String, String> {
        let out = Command::new("git").args(["status", "--porcelain"]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    /** Branch + status + ahead/behind in ONE git subprocess (PERF: the old
     *  two-command rev-parse + status cost ~2× per 3s poll). Runs
     *  `status --porcelain=v2 -b`, maps v2 lines back to v1-style `XY path`
     *  (frontend parsers unchanged) and parses ahead/behind vs upstream. */
    pub fn status_with_branch(&self) -> Result<WorktreeStatus, String> {
        let out = Command::new("git")
            .args(["status", "--porcelain=v2", "-b"])
            .current_dir(&self.repo_path)
            .output()
            .map_err(|e| e.to_string())?;
        Ok(parse_porcelain_v2(&String::from_utf8_lossy(&out.stdout)))
    }
}

/** Parse `git status --porcelain=v2 -b` output into branch + v1-style lines +
 *  ahead/behind. Pure (no git calls) so it is unit-testable offline. */
fn parse_porcelain_v2(text: &str) -> WorktreeStatus {
    let mut branch = String::new();
    let mut upstream = String::new();
    let mut ahead = 0usize;
    let mut behind = 0usize;
    let mut lines: Vec<String> = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            branch = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // e.g. "# branch.ab +2 -1" — signs included
            let mut it = rest.split_whitespace();
            if let Some(a) = it.next() { ahead = a.trim_start_matches('+').parse().unwrap_or(0) }
            if let Some(b) = it.next() { behind = b.trim_start_matches('-').parse().unwrap_or(0) }
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            upstream = rest.trim().to_string();
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
    WorktreeStatus { branch, upstream, status: lines.join("\n"), ahead, behind }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_porcelain_v2_summary() {
        let ws = parse_porcelain_v2(
            "# branch.oid aabbcc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 M. N... 100644 100644 100644 a b src/a.md\n? untracked.md",
        );
        assert_eq!(ws.branch, "main");
        assert_eq!(ws.upstream, "origin/main");
        assert_eq!((ws.ahead, ws.behind), (2, 1));
        assert_eq!(ws.status, "M. src/a.md\n? untracked.md");
    }

    #[test]
    fn parse_porcelain_v2_no_upstream_defaults_to_zero() {
        // Detached HEAD / no upstream → no branch.ab line → 0/0, so push
        // correctly reports "Nothing to push" instead of a doomed push.
        let ws = parse_porcelain_v2("# branch.oid abc\n# branch.head (HEAD detached at abc)");
        assert!(ws.status.is_empty());
        assert!(ws.upstream.is_empty());
        assert_eq!((ws.ahead, ws.behind), (0, 0));
    }
}
