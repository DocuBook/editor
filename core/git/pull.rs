//! One-call pull: fetch, then reconcile the current branch by rebase or merge.
//!
//! `Auto` keeps the narrow case the UI asks for — exactly one local commit over
//! more than one incoming commit rebases; every other divergence merges. A
//! branch that is only behind fast-forwards, an up-to-date branch is untouched.

use git2::{Repository, RepositoryState};

use super::sync::{
    default_remote_branch, ensure_no_tracked_changes, GitPullRequest, PullOutcome, PullStrategy,
};
use super::{git_error, Git};

impl Git {
    /// Fetch and reconcile the current branch in one API call. Auto mode rebases
    /// only the narrow low-risk case requested by the UI: exactly one local
    /// commit over more than one incoming commit. Other divergence merges, while
    /// non-diverged history uses a no-op or fast-forward.
    pub fn pull(&self, request: GitPullRequest) -> PullOutcome {
        self.pull_inner(&request)
            .unwrap_or_else(|error| PullOutcome {
                state: "failed".into(),
                strategy: "none".into(),
                remote: request.remote,
                branch: request.branch,
                error,
                ..PullOutcome::default()
            })
    }

    fn pull_inner(&self, request: &GitPullRequest) -> Result<PullOutcome, String> {
        let repo = self.repository()?;
        if !matches!(repo.state(), RepositoryState::Clean) {
            return Err(format!(
                "Finish or abort the current {:?} before pulling",
                repo.state()
            ));
        }
        ensure_no_tracked_changes(&repo, "pulling")?;

        let remote = self.resolve_remote(&request.remote)?;
        let before = remote_branch_target(&repo, &remote, &request.branch);
        drop(repo);
        self.fetch_remote(&remote)?;

        let repo = self.repository()?;
        let branch = if request.branch.trim().is_empty() {
            default_remote_branch(&repo, &remote)?
        } else {
            request.branch.trim().to_string()
        };
        let target = format!("{remote}/{branch}");
        let remote_id = repo
            .find_reference(&format!("refs/remotes/{target}"))
            .ok()
            .and_then(|reference| reference.target())
            .ok_or_else(|| format!("Remote branch {target} not found after fetch"))?;
        let remote_changed = before != Some(remote_id);

        if !self.has_commits() {
            drop(repo);
            let outcome = self.merge_remote(&remote, &branch);
            return Ok(PullOutcome {
                success: outcome.success,
                state: if outcome.success {
                    "adopted"
                } else if outcome.conflicts.is_empty() {
                    "failed"
                } else {
                    "conflicts"
                }
                .into(),
                strategy: "fastForward".into(),
                remote,
                branch,
                remote_changed,
                message: outcome.message,
                error: outcome.error,
                conflicts: outcome.conflicts,
                ..PullOutcome::default()
            });
        }

        let local_id = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .map_err(git_error)?
            .id();
        let (ahead, behind) = repo
            .graph_ahead_behind(local_id, remote_id)
            .map_err(git_error)?;
        drop(repo);

        if behind == 0 {
            return Ok(PullOutcome {
                success: true,
                state: "upToDate".into(),
                strategy: "none".into(),
                remote,
                branch,
                remote_changed,
                ahead,
                behind,
                message: format!("Already up to date with {target}"),
                ..PullOutcome::default()
            });
        }

        if ahead == 0 {
            let outcome = self.merge_remote(&remote, &branch);
            return Ok(PullOutcome {
                success: outcome.success,
                state: if outcome.success {
                    "fastForwarded"
                } else {
                    "failed"
                }
                .into(),
                strategy: "fastForward".into(),
                remote,
                branch,
                remote_changed,
                ahead,
                behind,
                message: outcome.message,
                error: outcome.error,
                conflicts: outcome.conflicts,
            });
        }

        let rebase = match request.strategy {
            PullStrategy::Rebase => true,
            PullStrategy::Merge => false,
            PullStrategy::Auto => ahead == 1 && behind > 1,
        };
        if rebase {
            let outcome = self.rebase_remote(&remote, &branch);
            Ok(PullOutcome {
                success: outcome.success,
                state: if outcome.success {
                    "rebased"
                } else if outcome.conflicts.is_empty() {
                    "failed"
                } else {
                    "conflicts"
                }
                .into(),
                strategy: "rebase".into(),
                remote,
                branch,
                remote_changed,
                ahead,
                behind,
                message: outcome.message,
                error: outcome.error,
                conflicts: outcome.conflicts,
            })
        } else {
            let outcome = self.merge_remote(&remote, &branch);
            Ok(PullOutcome {
                success: outcome.success,
                state: if outcome.success {
                    "merged"
                } else if outcome.conflicts.is_empty() {
                    "failed"
                } else {
                    "conflicts"
                }
                .into(),
                strategy: "merge".into(),
                remote,
                branch,
                remote_changed,
                ahead,
                behind,
                message: outcome.message,
                error: outcome.error,
                conflicts: outcome.conflicts,
            })
        }
    }
}

fn remote_branch_target(repo: &Repository, remote: &str, branch: &str) -> Option<git2::Oid> {
    let branch = if branch.trim().is_empty() {
        default_remote_branch(repo, remote).ok()?
    } else {
        branch.trim().to_string()
    };
    repo.find_reference(&format!("refs/remotes/{remote}/{branch}"))
        .ok()?
        .target()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_util::{
        attach_remote, bare_remote, cleanup, clone_local, commit_file, local_repo,
    };

    #[test]
    fn pull_request_deserializes_supported_strategies() {
        for (value, expected) in [
            ("auto", PullStrategy::Auto),
            ("rebase", PullStrategy::Rebase),
            ("merge", PullStrategy::Merge),
        ] {
            let request: GitPullRequest = serde_json::from_value(serde_json::json!({
                "remote": "origin",
                "branch": "main",
                "strategy": value,
            }))
            .unwrap();
            assert_eq!(request.strategy, expected);
        }
        assert!(serde_json::from_value::<GitPullRequest>(serde_json::json!({
            "strategy": "squash",
        }))
        .is_err());
    }

    #[test]
    fn pull_auto_rebases_one_local_commit_over_multiple_remote_commits() {
        let (remote_dir, url) = bare_remote("sync-pull-rebase-remote");
        let (dir, g) = local_repo("sync-pull-rebase");
        commit_file(&g, &dir, "base.md", "base", "base");
        attach_remote(&g, "origin", &url);
        assert!(g.push_checked().success);

        let (clone_dir, clone) = clone_local(&url, "sync-pull-rebase-clone");
        commit_file(&clone, &clone_dir, "remote-1.md", "one", "remote one");
        commit_file(&clone, &clone_dir, "remote-2.md", "two", "remote two");
        assert!(clone.push_checked().success);
        commit_file(&g, &dir, "local.md", "local", "local");

        let outcome = g.pull(GitPullRequest {
            remote: "origin".into(),
            branch: "main".into(),
            strategy: PullStrategy::Auto,
        });
        assert!(outcome.success, "{}{}", outcome.error, outcome.message);
        assert_eq!(outcome.state, "rebased");
        assert_eq!(outcome.strategy, "rebase");
        assert!(outcome.remote_changed);
        assert_eq!((outcome.ahead, outcome.behind), (1, 2));

        let repo = g.repository().unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 1);
        assert_eq!(head.message().unwrap(), "local");
        assert_eq!(head.parent(0).unwrap().message().unwrap(), "remote two");
        drop(head);
        drop(repo);
        cleanup(&[&dir, &remote_dir, &clone_dir]);
    }

    #[test]
    fn pull_auto_merges_when_more_than_one_local_commit_diverged() {
        let (remote_dir, url) = bare_remote("sync-pull-merge-remote");
        let (dir, g) = local_repo("sync-pull-merge");
        commit_file(&g, &dir, "base.md", "base", "base");
        attach_remote(&g, "origin", &url);
        assert!(g.push_checked().success);

        let (clone_dir, clone) = clone_local(&url, "sync-pull-merge-clone");
        commit_file(&clone, &clone_dir, "remote.md", "remote", "remote");
        assert!(clone.push_checked().success);
        commit_file(&g, &dir, "local-1.md", "one", "local one");
        commit_file(&g, &dir, "local-2.md", "two", "local two");

        let outcome = g.pull(GitPullRequest {
            remote: "origin".into(),
            branch: "main".into(),
            strategy: PullStrategy::Auto,
        });
        assert!(outcome.success, "{}{}", outcome.error, outcome.message);
        assert_eq!(outcome.state, "merged");
        assert_eq!(outcome.strategy, "merge");
        assert_eq!((outcome.ahead, outcome.behind), (2, 1));
        assert_eq!(
            g.repository()
                .unwrap()
                .head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .parent_count(),
            2
        );

        cleanup(&[&dir, &remote_dir, &clone_dir]);
    }

    #[test]
    fn pull_fast_forwards_and_reports_fetched_origin_change() {
        let (remote_dir, url) = bare_remote("sync-pull-ff-remote");
        let (dir, g) = local_repo("sync-pull-ff");
        commit_file(&g, &dir, "base.md", "base", "base");
        attach_remote(&g, "origin", &url);
        assert!(g.push_checked().success);

        let (clone_dir, clone) = clone_local(&url, "sync-pull-ff-clone");
        commit_file(&clone, &clone_dir, "remote.md", "remote", "remote");
        assert!(clone.push_checked().success);

        let outcome = g.pull(GitPullRequest {
            remote: "origin".into(),
            branch: "main".into(),
            strategy: PullStrategy::Auto,
        });
        assert!(outcome.success, "{}{}", outcome.error, outcome.message);
        assert_eq!(outcome.state, "fastForwarded");
        assert_eq!(outcome.strategy, "fastForward");
        assert!(outcome.remote_changed);
        assert_eq!((outcome.ahead, outcome.behind), (0, 1));
        assert!(dir.join("remote.md").exists());

        cleanup(&[&dir, &remote_dir, &clone_dir]);
    }

    #[test]
    fn pull_reports_up_to_date_without_rewriting_history() {
        let (remote_dir, url) = bare_remote("sync-pull-current-remote");
        let (dir, g) = local_repo("sync-pull-current");
        commit_file(&g, &dir, "base.md", "base", "base");
        attach_remote(&g, "origin", &url);
        assert!(g.push_checked().success);
        let head_before = g.repository().unwrap().head().unwrap().target();

        let outcome = g.pull(GitPullRequest {
            remote: "origin".into(),
            branch: "main".into(),
            strategy: PullStrategy::Auto,
        });
        assert!(outcome.success, "{}{}", outcome.error, outcome.message);
        assert_eq!(outcome.state, "upToDate");
        assert_eq!(outcome.strategy, "none");
        assert!(!outcome.remote_changed);
        assert_eq!((outcome.ahead, outcome.behind), (0, 0));
        assert_eq!(
            g.repository().unwrap().head().unwrap().target(),
            head_before
        );

        cleanup(&[&dir, &remote_dir]);
    }
}
