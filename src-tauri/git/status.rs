//! Worktree status feeding the shared Git UI poller.

use git2::{Repository, Status, StatusOptions};
use serde::Serialize;

use super::{git_error, Git};

#[derive(Debug, Default, Serialize)]
pub struct WorktreeStatus {
    pub branch: String,
    pub upstream: String,
    pub status: String,
    pub ahead: usize,
    pub behind: usize,
}

impl Git {
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
        })
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
        g.init().unwrap();
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
}
