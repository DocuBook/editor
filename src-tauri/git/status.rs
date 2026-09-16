//! Worktree status feeding the shared Git UI poller.

use git2::{
    DiffDelta, DiffFormat, DiffHunk, DiffLine, DiffOptions, Repository, RepositoryState, Status,
    StatusOptions,
};
use serde::Serialize;
use std::cell::RefCell;
use std::collections::HashMap;

use super::{git_error, Git};

#[derive(Debug, Default, Serialize)]
pub struct WorktreeStatus {
    pub branch: String,
    pub upstream: String,
    pub status: String,
    pub ahead: usize,
    pub behind: usize,
    /// In-progress operation (`clean`, `merge`, `rebase`, …) — the UI needs it
    /// to offer Continue/Abort instead of a fresh sync.
    pub state: String,
}

/// Caps for the diff excerpt handed to commit-message generation: enough content
/// for the model to judge intent, bounded so a huge change set cannot blow the
/// prompt or the IPC payload.
const MAX_DIFF_FILES: usize = 10;
const MAX_LINES_PER_FILE: usize = 30;
const MAX_LINE_CHARS: usize = 200;
const MAX_COLLECTED_CHARS: usize = 64 * 1024;
const MAX_EXCERPT_CHARS: usize = 8 * 1024;

impl Git {
    /// Returns a bounded diff excerpt for commit-message generation: per-file
    /// churn stats plus the leading changed lines of the largest files. Stats
    /// alone cannot tell the model what a change set does, so the excerpt
    /// carries real content; the caps keep the prompt small.
    ///
    /// The HEAD tree is the base, so the excerpt covers everything a commit
    /// would capture — staged, unstaged, and untracked alike.
    pub fn diff_summary(&self) -> Result<String, String> {
        let repo = self.repository()?;
        let head = repo
            .head()
            .ok()
            .and_then(|head| head.peel_to_tree().ok());
        let mut options = DiffOptions::new();
        // Untracked deltas carry no content lines unless this flag is set, so
        // without it a brand-new note would never reach the churn stats.
        options
            .include_untracked(true)
            .recurse_untracked_dirs(true)
            .show_untracked_content(true);
        let diff = repo
            .diff_tree_to_workdir_with_index(head.as_ref(), Some(&mut options))
            .map_err(git_error)?;
        let scanned = RefCell::new(ScannedDiff::default());
        diff.print(
            DiffFormat::Patch,
            &mut |delta: DiffDelta<'_>, _hunk: Option<DiffHunk<'_>>, line: DiffLine<'_>| {
                if let Some(path) = delta.new_file().path().or(delta.old_file().path()) {
                    scanned.borrow_mut().record(&path.display().to_string(), &line);
                }
                true
            },
        )
        .map_err(git_error)?;
        Ok(scanned.into_inner().excerpt())
    }

    pub fn status_with_branch(&self) -> Result<WorktreeStatus, String> {
        let repo = self.repository()?;
        let branch = head_name(&repo);
        let status = status_lines(&repo)?;
        let mut upstream = String::new();
        let mut ahead = 0;
        let mut behind = 0;

        if !branch.is_empty() && !branch.starts_with('(') {
            if let Ok(local) = repo.find_branch(&branch, git2::BranchType::Local) {
                if let Ok(tracking) = local.upstream() {
                    upstream = tracking
                        .name()
                        .ok()
                        .flatten()
                        .unwrap_or_default()
                        .to_string();
                    if let (Some(local_id), Some(upstream_id)) =
                        (local.get().target(), tracking.get().target())
                    {
                        (ahead, behind) = repo
                            .graph_ahead_behind(local_id, upstream_id)
                            .map_err(git_error)?;
                    }
                }
            }
        }

        Ok(WorktreeStatus {
            branch,
            upstream,
            status,
            ahead,
            behind,
            state: state_name(repo.state()).to_string(),
        })
    }
}

/// Churn statistics plus a truncated copy of the changed lines, gathered in the
/// single diff walk the caller already performs.
#[derive(Default)]
struct ScannedDiff {
    churn: HashMap<String, (usize, usize)>,
    excerpt: HashMap<String, Vec<String>>,
    collected: usize,
}

impl ScannedDiff {
    fn record(&mut self, path: &str, line: &DiffLine<'_>) {
        let origin = line.origin();
        let churn = self.churn.entry(path.to_string()).or_insert((0, 0));
        match origin {
            '+' => churn.0 += 1,
            '-' => churn.1 += 1,
            _ => return,
        }
        if self.collected >= MAX_COLLECTED_CHARS {
            return;
        }
        let lines = self.excerpt.entry(path.to_string()).or_default();
        if lines.len() >= MAX_LINES_PER_FILE {
            return;
        }
        let content = String::from_utf8_lossy(line.content());
        let content = content.trim_end_matches(['\n', '\r']);
        if content.is_empty() {
            return;
        }
        let rendered = format!("  {origin} {}", clamp_chars(content, MAX_LINE_CHARS));
        self.collected += rendered.len();
        lines.push(rendered);
    }

    /// Files ranked by churn, largest first, each with its excerpt; the total is
    /// capped so the prompt stays predictable.
    fn excerpt(&self) -> String {
        let mut ranked: Vec<_> = self.churn.iter().collect();
        ranked.sort_by_key(|(_, (added, removed))| std::cmp::Reverse(added + removed));
        let mut sections = Vec::new();
        let mut total = 0usize;
        for (path, (added, removed)) in ranked.into_iter().take(MAX_DIFF_FILES) {
            let mut section = format!("{path} (+{added} -{removed})");
            for line in self.excerpt.get(path).map(Vec::as_slice).unwrap_or_default() {
                if total + section.len() + line.len() + 1 > MAX_EXCERPT_CHARS {
                    break;
                }
                section.push('\n');
                section.push_str(line);
            }
            total += section.len() + 1;
            sections.push(section);
            if total >= MAX_EXCERPT_CHARS {
                break;
            }
        }
        sections.join("\n")
    }
}

/// Truncate on a char boundary so lossy multi-byte content never panics.
fn clamp_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value.chars().take(max).collect()
}

/** Stable machine-readable name for the repository state (`git status` style). */
fn state_name(state: RepositoryState) -> &'static str {
    match state {
        RepositoryState::Clean => "clean",
        RepositoryState::Merge => "merge",
        RepositoryState::Revert => "revert",
        RepositoryState::RevertSequence => "revert-sequence",
        RepositoryState::CherryPick => "cherry-pick",
        RepositoryState::CherryPickSequence => "cherry-pick-sequence",
        RepositoryState::Bisect => "bisect",
        RepositoryState::Rebase => "rebase",
        RepositoryState::RebaseInteractive => "rebase-interactive",
        RepositoryState::RebaseMerge => "rebase-merge",
        RepositoryState::ApplyMailbox => "apply-mailbox",
        RepositoryState::ApplyMailboxOrRebase => "apply-mailbox-or-rebase",
    }
}

fn status_lines(repo: &Repository) -> Result<String, String> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo.statuses(Some(&mut options)).map_err(git_error)?;
    let mut lines = Vec::with_capacity(statuses.len());
    for entry in statuses.iter() {
        let path = String::from_utf8_lossy(entry.path_bytes());
        let (index, worktree) = status_pair(entry.status());
        lines.push(format!("{index}{worktree} {path}"));
    }
    Ok(lines.join("\n"))
}

fn status_pair(status: Status) -> (char, char) {
    if status.is_conflicted() {
        return ('U', 'U');
    }
    if status.is_wt_new() && !status.is_index_new() {
        return ('?', '?');
    }

    let index = if status.is_index_new() {
        'A'
    } else if status.is_index_modified() {
        'M'
    } else if status.is_index_deleted() {
        'D'
    } else if status.is_index_renamed() {
        'R'
    } else if status.is_index_typechange() {
        'T'
    } else {
        '.'
    };
    let worktree = if status.is_wt_modified() {
        'M'
    } else if status.is_wt_deleted() {
        'D'
    } else if status.is_wt_renamed() {
        'R'
    } else if status.is_wt_typechange() {
        'T'
    } else {
        '.'
    };
    (index, worktree)
}

fn head_name(repo: &Repository) -> String {
    let Ok(head) = repo.find_reference("HEAD") else {
        return String::new();
    };
    if let Ok(Some(target)) = head.symbolic_target() {
        return target
            .strip_prefix("refs/heads/")
            .unwrap_or(target)
            .to_string();
    }
    head.target()
        .map(|id| format!("(HEAD detached at {})", &id.to_string()[..7]))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_util::temp_git_repo;

    #[test]
    fn reports_branch_index_worktree_and_untracked_status() {
        let dir = temp_git_repo("status");
        let g = Git::open(dir.to_str().unwrap());
        g.init("").unwrap();
        g.set_identity("T", "t@e.c").unwrap();
        std::fs::write(dir.join("tracked.md"), "one").unwrap();
        g.add_all().unwrap();
        g.commit("first").unwrap();

        std::fs::write(dir.join("tracked.md"), "two").unwrap();
        std::fs::write(dir.join("new.md"), "new").unwrap();
        let ws = g.status_with_branch().unwrap();
        assert!(!ws.branch.is_empty());
        assert!(ws.status.contains(".M tracked.md"));
        assert!(ws.status.contains("?? new.md"));
        assert!(ws.upstream.is_empty());
        assert_eq!((ws.ahead, ws.behind), (0, 0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn diff_summary_carries_churn_and_changed_lines() {
        let dir = temp_git_repo("diff-summary");
        let g = Git::open(dir.to_str().unwrap());
        g.init("").unwrap();
        g.set_identity("T", "t@e.c").unwrap();
        std::fs::write(dir.join("tracked.md"), "one\n").unwrap();
        g.add_all().unwrap();
        g.commit("first").unwrap();

        // Unstaged edit, untracked note, and a staged-only file: the excerpt is
        // based on HEAD, so a commit would capture all three.
        std::fs::write(dir.join("tracked.md"), "two\n").unwrap();
        std::fs::write(dir.join("fresh.md"), "new\n").unwrap();
        std::fs::write(dir.join("staged.md"), "queued\n").unwrap();
        g.stage_path("staged.md").unwrap();

        let summary = g.diff_summary().unwrap();
        assert!(summary.contains("tracked.md (+1 -1)"), "{summary}");
        assert!(summary.contains("- one"), "{summary}");
        assert!(summary.contains("+ two"), "{summary}");
        assert!(summary.contains("fresh.md (+1 -0)"), "{summary}");
        assert!(summary.contains("+ new"), "{summary}");
        assert!(summary.contains("staged.md (+1 -0)"), "{summary}");
        assert!(summary.contains("+ queued"), "{summary}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
