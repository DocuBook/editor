//! Replay local commits on top of a remote branch.
//!
//! A branch strictly behind the remote is fast-forwarded. Conflicts stop the
//! rebase with the state kept on disk so the UI can offer Continue/Abort:
//! nothing is force-pushed and nothing is discarded silently.

use git2::{Repository, RepositoryState};

use super::sync::{
    default_remote_branch, ensure_no_tracked_changes, fast_forward, identity_hint, merge_conflicts,
    RebaseOutcome,
};
use super::{git_error, Git};

impl Git {
    /// Replay the local commits on top of `<name>/<branch>` (`branch` empty =
    /// the remote's default). A branch strictly behind the remote is simply
    /// fast-forwarded. Conflicts stop the rebase with state kept on disk so the
    /// UI can offer Continue/Abort — nothing is force-pushed and nothing is
    /// discarded silently.
    pub fn rebase_remote(&self, name: &str, branch: &str) -> RebaseOutcome {
        match self.rebase_remote_inner(name, branch) {
            Ok((success, message, conflicts)) => RebaseOutcome {
                success,
                message,
                error: String::new(),
                conflicts,
            },
            Err(error) => RebaseOutcome {
                success: false,
                message: String::new(),
                error,
                conflicts: Vec::new(),
            },
        }
    }

    fn rebase_remote_inner(
        &self,
        name: &str,
        branch: &str,
    ) -> Result<(bool, String, Vec<String>), String> {
        let repo = self.repository()?;
        if !matches!(repo.state(), RepositoryState::Clean) {
            return Err(format!(
                "Finish or abort the current {:?} first",
                repo.state()
            ));
        }
        if !self.has_commits() {
            return Err(
                "No local commits to rebase — Merge adopts the remote branch instead".into(),
            );
        }
        ensure_no_tracked_changes(&repo, "rebasing")?;

        // Replaying commits creates one commit per step, so policy and identity
        // must stop the operation before the branch moves.
        crate::git::commit::ensure_commit_policy_supported(&repo)?;
        repo.committer_from_env().map_err(identity_hint)?;
        let name = self.resolve_remote(name)?;
        let branch = if branch.trim().is_empty() {
            default_remote_branch(&repo, &name)?
        } else {
            branch.trim().to_string()
        };
        let target = format!("{name}/{branch}");
        let onto_ref = repo
            .find_reference(&format!("refs/remotes/{target}"))
            .map_err(|_| format!("Remote branch {target} not found — fetch it first"))?;
        let onto = repo
            .reference_to_annotated_commit(&onto_ref)
            .map_err(git_error)?;
        drop(onto_ref);

        let head = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .map_err(git_error)?;
        let base = repo.merge_base(head.id(), onto.id()).map_err(git_error)?;
        if base == onto.id() {
            return Ok((
                true,
                format!("Already up to date with {target}"),
                Vec::new(),
            ));
        }
        // Strictly behind: there is nothing to replay, so this is a fast-forward.
        if base == head.id() {
            drop(head);
            fast_forward(&repo, onto.id(), &target)?;
            return Ok((true, format!("Fast-forwarded to {target}"), Vec::new()));
        }
        drop(head);

        let upstream = repo.find_annotated_commit(base).map_err(git_error)?;
        // `branch` is None so HEAD is rebased onto the remote tip, replaying only
        // the commits after the merge base (`upstream`).
        let rebase = repo
            .rebase(None, Some(&upstream), Some(&onto), None)
            .map_err(git_error)?;
        drop(rebase);
        let conflicts = self.apply_rebase(&repo)?;
        if conflicts.is_empty() {
            Ok((true, format!("Rebased onto {target}"), Vec::new()))
        } else {
            Ok((
                false,
                format!("{target} conflicts — resolve, stage, then Continue"),
                conflicts,
            ))
        }
    }

    /// Apply every pending rebase operation, committing the currently applied one
    /// first (the continue-after-conflict path). Returns the conflicted paths when
    /// the rebase stops — the on-disk state is left intact for Continue/Abort. An
    /// empty result means the rebase finished and the branch was moved.
    fn apply_rebase(&self, repo: &Repository) -> Result<Vec<String>, String> {
        let mut rebase = repo.open_rebase(None).map_err(git_error)?;
        if rebase.operation_current().is_some() {
            let committer = repo.committer_from_env().map_err(identity_hint)?;
            rebase
                .commit(None, &committer, None)
                .map_err(|error| self.rebase_step_error(repo, error))?;
        }
        loop {
            match rebase.next() {
                Some(Ok(_)) => {
                    let index = repo.index().map_err(git_error)?;
                    if index.has_conflicts() {
                        return merge_conflicts(repo);
                    }
                    drop(index);
                    let committer = repo.committer_from_env().map_err(identity_hint)?;
                    rebase
                        .commit(None, &committer, None)
                        .map_err(|error| self.rebase_step_error(repo, error))?;
                }
                None => {
                    let committer = repo.committer_from_env().map_err(identity_hint)?;
                    rebase.finish(Some(&committer)).map_err(git_error)?;
                    return Ok(Vec::new());
                }
                Some(Err(error)) => {
                    // libgit2 reports an apply failure here when the patch
                    // conflicts; a conflict is reported, and any other error is
                    // classified before the on-disk state is abandoned.
                    let conflicts = merge_conflicts(repo).unwrap_or_default();
                    if conflicts.is_empty() {
                        return Err(base::rebase_failure(git_error(error), repo.state()));
                    }
                    return Ok(conflicts);
                }
            }
        }
    }

    /// Turn a failed rebase step into an actionable error. A conflict stays
    /// resumable; anything else (identity, config) is reported with the
    /// rebase still abortable rather than silently stranded.
    fn rebase_step_error(&self, repo: &Repository, error: git2::Error) -> String {
        let conflicts = merge_conflicts(repo).unwrap_or_default();
        if !conflicts.is_empty() {
            return format!(
                "Conflicts in {} — resolve, stage, then Continue",
                conflicts.join(", ")
            );
        }
        base::rebase_failure(git_error(error), repo.state())
    }

    /// Finish a stopped rebase after its conflicts were resolved and staged.
    pub fn rebase_continue(&self) -> RebaseOutcome {
        match self.rebase_continue_inner() {
            Ok((success, message, conflicts)) => RebaseOutcome {
                success,
                message,
                error: String::new(),
                conflicts,
            },
            Err(error) => RebaseOutcome {
                success: false,
                message: String::new(),
                error,
                conflicts: Vec::new(),
            },
        }
    }

    fn rebase_continue_inner(&self) -> Result<(bool, String, Vec<String>), String> {
        let repo = self.repository()?;
        if !is_rebase_state(repo.state()) {
            return Err("No rebase in progress".into());
        }
        let index = repo.index().map_err(git_error)?;
        if index.has_conflicts() {
            return Err("Resolve all conflicts and stage them before continuing".into());
        }
        drop(index);

        // Continuing commits the resolved step under the same policy as the
        // rebase that started it, and before the branch moves.
        crate::git::commit::ensure_commit_policy_supported(&repo)?;

        let conflicts = self.apply_rebase(&repo)?;
        if conflicts.is_empty() {
            Ok((true, "Rebase completed".to_string(), Vec::new()))
        } else {
            Ok((
                false,
                "Conflicts remain — resolve, stage, then Continue".to_string(),
                conflicts,
            ))
        }
    }

    /// Undo an in-progress rebase, restoring the branch and worktree.
    pub fn rebase_abort(&self) -> Result<(), String> {
        let repo = self.repository()?;
        if !is_rebase_state(repo.state()) {
            return Err("No rebase in progress".into());
        }
        let mut rebase = repo.open_rebase(None).map_err(git_error)?;
        rebase.abort().map_err(git_error)
    }
}

/** Actions offered for a rebase that did not finish. A conflict leaves the
 *  rebase resumable; every other failure is reported as abortable, because the
 *  branch may already have moved. */
mod base {
    use git2::RepositoryState;

    pub(super) fn rebase_failure(message: String, state: RepositoryState) -> String {
        if super::is_rebase_state(state) {
            format!("{message} — Abort the rebase to restore the branch")
        } else {
            message
        }
    }
}

fn is_rebase_state(state: RepositoryState) -> bool {
    matches!(
        state,
        RepositoryState::Rebase
            | RepositoryState::RebaseInteractive
            | RepositoryState::RebaseMerge
            | RepositoryState::ApplyMailboxOrRebase
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_util::{
        attach_remote, bare_remote, cleanup, clone_local, commit_file, diverged_pair, local_repo,
    };

    #[test]
    fn rebase_replays_local_commits_on_top_of_the_remote() {
        let (remote_dir, url) = bare_remote("sync-rebase-remote");
        let (dir, g) = local_repo("sync-rebase");
        commit_file(&g, &dir, "a.md", "base\n", "first");
        attach_remote(&g, "origin", &url);
        assert!(g.push_checked().success);

        let (clone_dir, clone) = clone_local(&url, "sync-rebase-clone");
        commit_file(&clone, &clone_dir, "remote.md", "remote", "remote");
        assert!(clone.push_checked().success);

        commit_file(&g, &dir, "local.md", "local", "local");
        g.fetch_remote("origin").unwrap();

        let outcome = g.rebase_remote("origin", "main");
        assert!(outcome.success, "{}{}", outcome.error, outcome.message);
        assert!(
            outcome.message.contains("Rebased onto"),
            "{}",
            outcome.message
        );
        assert!(outcome.conflicts.is_empty());
        assert!(dir.join("remote.md").exists());
        assert!(dir.join("local.md").exists());

        // Linear history: the replayed commit sits directly on the remote tip.
        let repo = g.repository().unwrap();
        assert_eq!(repo.state(), RepositoryState::Clean);
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 1);
        assert_eq!(head.message().unwrap(), "local");
        let parent = head.parent(0).unwrap();
        assert_eq!(parent.message().unwrap(), "remote");
        drop(head);
        drop(parent);
        drop(repo);
        assert!(g.status_with_branch().unwrap().status.trim().is_empty());

        cleanup(&[&dir, &remote_dir, &clone_dir]);
    }

    #[test]
    fn rebase_fast_forwards_when_local_has_nothing_to_replay() {
        let (remote_dir, url) = bare_remote("sync-rebase-ff-remote");
        let (dir, g) = local_repo("sync-rebase-ff");
        commit_file(&g, &dir, "a.md", "a", "first");
        attach_remote(&g, "origin", &url);
        assert!(g.push_checked().success);

        let (clone_dir, clone) = clone_local(&url, "sync-rebase-ff-clone");
        commit_file(&clone, &clone_dir, "b.md", "b", "remote ahead");
        assert!(clone.push_checked().success);

        g.fetch_remote("origin").unwrap();
        let outcome = g.rebase_remote("origin", "main");
        assert!(outcome.success, "{}{}", outcome.error, outcome.message);
        assert!(
            outcome.message.contains("Fast-forwarded"),
            "{}",
            outcome.message
        );
        assert!(dir.join("b.md").exists());

        cleanup(&[&dir, &remote_dir, &clone_dir]);
    }

    #[test]
    fn rebase_stops_on_conflicts_then_continues_after_resolution() {
        let (dir, g, remote_dir, clone_dir) =
            diverged_pair("sync-rebase-conflict", "theirs\n", "ours\n");

        let outcome = g.rebase_remote("origin", "main");
        assert!(!outcome.success, "{}", outcome.message);
        assert_eq!(outcome.conflicts, vec!["a.md".to_string()]);
        assert!(
            is_rebase_state(g.repository().unwrap().state()),
            "a stopped rebase must stay resumable"
        );

        // The editor flow: resolve in the worktree, stage, then Continue.
        std::fs::write(dir.join("a.md"), "resolved\n").unwrap();
        g.add_all().unwrap();
        let continued = g.rebase_continue();
        assert!(
            continued.success,
            "{}{}",
            continued.error, continued.message
        );
        let repo = g.repository().unwrap();
        assert_eq!(repo.state(), RepositoryState::Clean);
        assert_eq!(
            repo.head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .parent_count(),
            1
        );
        drop(repo);
        assert_eq!(
            std::fs::read_to_string(dir.join("a.md")).unwrap(),
            "resolved\n"
        );
        assert!(g.status_with_branch().unwrap().status.trim().is_empty());

        cleanup(&[&dir, &remote_dir, &clone_dir]);
    }

    #[test]
    fn rebase_continue_refuses_while_conflicts_remain() {
        let (dir, g, remote_dir, clone_dir) =
            diverged_pair("sync-rebase-unresolved", "theirs\n", "ours\n");
        assert!(!g.rebase_remote("origin", "main").success);

        let outcome = g.rebase_continue();
        assert!(!outcome.success);
        assert!(
            outcome.error.contains("Resolve all conflicts"),
            "{}",
            outcome.error
        );

        cleanup(&[&dir, &remote_dir, &clone_dir]);
    }

    #[test]
    fn rebase_abort_restores_the_local_branch() {
        let (dir, g, remote_dir, clone_dir) =
            diverged_pair("sync-rebase-abort", "theirs\n", "ours\n");
        assert!(!g.rebase_remote("origin", "main").success);

        g.rebase_abort().unwrap();

        let repo = g.repository().unwrap();
        assert_eq!(repo.state(), RepositoryState::Clean);
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.message().unwrap(), "local");
        assert_eq!(head.parent_count(), 1);
        drop(head);
        drop(repo);
        assert_eq!(std::fs::read_to_string(dir.join("a.md")).unwrap(), "ours\n");

        cleanup(&[&dir, &remote_dir, &clone_dir]);
    }
    #[test]
    fn rebase_refuses_a_dirty_tracked_worktree() {
        let (dir, g) = local_repo("sync-rebase-dirty");
        commit_file(&g, &dir, "a.md", "base\n", "first");
        std::fs::write(dir.join("a.md"), "uncommitted\n").unwrap();

        let outcome = g.rebase_remote("origin", "main");
        assert!(!outcome.success);
        assert!(
            outcome.error.contains("before rebasing"),
            "{}",
            outcome.error
        );
        // Refused before the remote lookup, so the guard is what rejected it.
        assert!(
            !outcome.error.contains("No git remote"),
            "{}",
            outcome.error
        );

        cleanup(&[&dir]);
    }
    #[cfg(unix)]
    #[test]
    fn rebase_refuses_an_active_commit_hook_before_any_state_changes() {
        use std::os::unix::fs::PermissionsExt;

        let (dir, g, remote_dir, clone_dir) =
            diverged_pair("sync-rebase-hook", "remote\n", "local\n");

        let hook = g.repository().unwrap().path().join("hooks/pre-commit");
        std::fs::write(&hook, "#!/bin/sh\nexit 0\n").unwrap();
        let mut permissions = std::fs::metadata(&hook).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&hook, permissions).unwrap();

        let head_before = g.repository().unwrap().head().unwrap().target();
        let outcome = g.rebase_remote("origin", "main");
        assert!(!outcome.success);
        assert!(outcome.error.contains("pre-commit"), "{}", outcome.error);
        // The rebase never started: HEAD and the on-disk state are untouched.
        let repo = g.repository().unwrap();
        assert_eq!(repo.head().unwrap().target(), head_before);
        assert_eq!(repo.state(), RepositoryState::Clean);

        cleanup(&[&dir, &remote_dir, &clone_dir]);
    }
}
