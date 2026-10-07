//! Merge the current branch with a remote branch.
//!
//! Fast-forwards when the local branch is behind, adopts the remote branch when
//! there are no local commits yet, and otherwise creates a merge commit.
//! Conflicts are reported and left on disk for the editor to resolve.
//! `merge_abort` only discards a merge this app started — `APP_MERGE_MARKER`
//! records the original HEAD so a system-Git merge is never hard-reset.

use git2::{build::CheckoutBuilder, Repository, RepositoryState, ResetType, StatusOptions};

use super::sync::{
    clear_app_merge_marker, default_remote_branch, ensure_no_tracked_changes, fast_forward,
    identity_hint, merge_conflicts, MergeOutcome, APP_MERGE_MARKER,
};
use super::{git_error, Git};

impl Git {
    /// Reconcile the current branch with `<name>/<branch>` (`branch` empty =
    /// the remote's default). Fast-forwards when the local branch is behind,
    /// adopts the remote branch when we have no commits yet, and otherwise
    /// creates a merge commit. Conflicts are reported and left in place.
    pub fn merge_remote(&self, name: &str, branch: &str) -> MergeOutcome {
        match self.merge_remote_inner(name, branch) {
            Ok((success, message, conflicts)) => MergeOutcome {
                success,
                message,
                error: String::new(),
                conflicts,
            },
            Err(error) => MergeOutcome {
                success: false,
                message: String::new(),
                error,
                conflicts: Vec::new(),
            },
        }
    }

    fn merge_remote_inner(
        &self,
        name: &str,
        branch: &str,
    ) -> Result<(bool, String, Vec<String>), String> {
        let repo = self.repository()?;
        if !matches!(repo.state(), RepositoryState::Clean) {
            return Err(format!(
                "Finish the current {:?} before merging",
                repo.state()
            ));
        }
        // Refuse before `repo.merge` touches anything. Committing local work
        // first is the non-destructive path; once a merge state exists, Abort
        // is a hard reset that cannot tell app-started work from work the user
        // has not committed yet (see `merge_abort`).
        ensure_no_tracked_changes(&repo, "merging")?;
        let name = self.resolve_remote(name)?;

        let branch = if branch.trim().is_empty() {
            default_remote_branch(&repo, &name)?
        } else {
            branch.trim().to_string()
        };
        let target = format!("{name}/{branch}");
        let reference = repo
            .find_reference(&format!("refs/remotes/{target}"))
            .map_err(|_| format!("Remote branch {target} not found — fetch it first"))?;

        // No local history yet: adopting the remote branch is the only sensible
        // reconciliation (a merge has nothing to merge into).
        if !self.has_commits() {
            return self.adopt_remote_branch(&repo, &target, &reference);
        }

        let annotated = repo
            .reference_to_annotated_commit(&reference)
            .map_err(git_error)?;
        let (analysis, _) = repo.merge_analysis(&[&annotated]).map_err(git_error)?;

        if analysis.is_up_to_date() {
            return Ok((
                true,
                format!("Already up to date with {target}"),
                Vec::new(),
            ));
        }
        if analysis.is_fast_forward() {
            fast_forward(&repo, annotated.id(), &target)?;
            return Ok((true, format!("Fast-forwarded to {target}"), Vec::new()));
        }
        if !analysis.is_normal() {
            return Err(format!("Cannot merge {target} into the current branch"));
        }

        // Hooks, signing, and identity are checked while the repository is
        // still clean. Mark this exact HEAD pair before `repo.merge` so Abort can
        // reject merge states started by system Git instead of resetting them.
        crate::git::commit::ensure_commit_policy_supported(&repo)?;
        repo.author_from_env().map_err(identity_hint)?;
        repo.committer_from_env().map_err(identity_hint)?;
        let original_head = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .map_err(git_error)?
            .id();
        mark_app_merge(&repo, original_head, annotated.id())?;
        if let Err(error) = repo.merge(&[&annotated], None, None) {
            let merge_error = git_error(error);
            return match clear_app_merge_marker(&repo) {
                Ok(()) => Err(merge_error),
                Err(cleanup_error) => Err(format!("{merge_error}; {cleanup_error}")),
            };
        }
        let conflicts = merge_conflicts(&repo)?;
        if !conflicts.is_empty() {
            return Ok((
                false,
                format!("{target} has conflicts — resolve them and commit"),
                conflicts,
            ));
        }

        let commit = self
            .create_merge_commit(annotated.id(), &format!("Merge {target}"))
            .map_err(|error| {
                format!(
                    "{error} (the merge state stays on disk — fix the error and commit, or Abort)"
                )
            })?;
        let state_error = repo.cleanup_state().err().map(git_error);
        let marker_error = clear_app_merge_marker(&repo).err();
        if state_error.is_some() || marker_error.is_some() {
            let errors = [state_error, marker_error]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("; ");
            return Err(format!(
                "Commit {commit} created but merge cleanup failed: {errors}"
            ));
        }
        Ok((
            true,
            format!("Merged {target} ({})", short_commit(&commit)),
            Vec::new(),
        ))
    }

    /// Local repository has no commits yet: the remote branch becomes our
    /// history.
    ///
    /// A plain safe checkout refuses here because `init` leaves the generated
    /// `.gitignore` untracked in the worktree. Only paths whose content is
    /// byte-identical to the remote blob may be overwritten — anything else is
    /// reported back instead of being silently destroyed.
    fn adopt_remote_branch(
        &self,
        repo: &Repository,
        target: &str,
        reference: &git2::Reference<'_>,
    ) -> Result<(bool, String, Vec<String>), String> {
        let commit = reference.peel_to_commit().map_err(git_error)?;
        let tree = commit.tree().map_err(git_error)?;

        let mut blockers = Vec::new();
        let mut options = StatusOptions::new();
        options.include_untracked(true).recurse_untracked_dirs(true);
        for entry in repo.statuses(Some(&mut options)).map_err(git_error)?.iter() {
            let Ok(path) = entry.path() else { continue };
            let status = entry.status();
            if !(status.is_wt_new() || status.is_wt_modified()) {
                continue;
            }
            let Ok(tree_entry) = tree.get_path(std::path::Path::new(path)) else {
                continue; // the remote branch does not touch this path
            };
            let identical = tree_entry
                .to_object(repo)
                .ok()
                .and_then(|object| object.into_blob().ok())
                .zip(std::fs::read(std::path::Path::new(&self.repo_path).join(path)).ok())
                .map(|(blob, local)| local == blob.content())
                .unwrap_or(false);
            if !identical {
                blockers.push(path.to_string());
            }
        }
        if !blockers.is_empty() {
            return Err(format!(
                "Refusing to overwrite local files: {}",
                blockers.join(", ")
            ));
        }

        let short = target
            .split_once('/')
            .map(|(_, rest)| rest)
            .unwrap_or(target);
        let mut local = repo.branch(short, &commit, false).map_err(git_error)?;
        if let Err(error) = local.set_upstream(Some(target)).map_err(git_error) {
            let _ = local.delete();
            return Err(error);
        }

        // Force is safe: every overwritten path was verified identical above.
        let object = commit.into_object();
        let mut checkout = CheckoutBuilder::new();
        checkout.force();
        if let Err(error) = repo
            .checkout_tree(&object, Some(&mut checkout))
            .map_err(git_error)
        {
            let _ = local.delete();
            return Err(error);
        }
        repo.set_head(local.get().name().map_err(git_error)?)
            .map_err(git_error)?;
        Ok((true, format!("Checked out {target}"), Vec::new()))
    }

    /// Merge commit with HEAD + `other` as parents, honouring the same commit
    /// policies as a normal commit (`commit.rs`).
    ///
    /// Used only for a merge this app started from a clean worktree. The caller
    /// removes merge metadata and the app marker only after this commit succeeds,
    /// so a failure remains safely abortable.
    fn create_merge_commit(&self, other: git2::Oid, message: &str) -> Result<String, String> {
        let repo = self.repository()?;
        let mut index = repo.index().map_err(git_error)?;
        if index.has_conflicts() {
            return Err("Resolve merge conflicts before committing".into());
        }
        let tree_id = index.write_tree().map_err(git_error)?;
        let tree = repo.find_tree(tree_id).map_err(git_error)?;
        let head = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .map_err(git_error)?;
        let other = repo.find_commit(other).map_err(git_error)?;
        let author = repo.author_from_env().map_err(identity_hint)?;
        let committer = repo.committer_from_env().map_err(identity_hint)?;
        repo.commit(
            Some("HEAD"),
            &author,
            &committer,
            message,
            &tree,
            &[&head, &other],
        )
        .map(|id| id.to_string())
        .map_err(git_error)
    }
    /// Abandon an app-started merge. Pre-existing tracked changes were rejected
    /// before the merge began; changes made during conflict resolution are
    /// discarded. A marker containing both original HEAD and MERGE_HEAD prevents
    /// this hard reset from being used on a merge started by system Git.
    pub fn merge_abort(&self) -> Result<(), String> {
        let mut repo = self.repository()?;
        if !matches!(repo.state(), RepositoryState::Merge) {
            return Err("No merge in progress".into());
        }
        let (original_head, expected_merge_head) = app_merge_heads(&repo)?;
        let current_head = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .map_err(git_error)?
            .id();
        if current_head != original_head {
            return Err("Cannot abort this merge because HEAD changed after it started".into());
        }
        let mut expected_found = false;
        repo.mergehead_foreach(|id| {
            expected_found |= *id == expected_merge_head;
            true
        })
        .map_err(git_error)?;
        if !expected_found {
            return Err("Cannot abort this merge because it was not started by this app".into());
        }
        let original = repo.find_object(original_head, None).map_err(git_error)?;
        repo.reset(&original, ResetType::Hard, None)
            .map_err(git_error)?;
        repo.cleanup_state().map_err(git_error)?;
        clear_app_merge_marker(&repo)?;
        Ok(())
    }
}

/** Persist the exact app-started merge pair inside `.git`; conflicts survive
 *  app restart, while unrelated system-Git merge states cannot use app Abort. */
fn mark_app_merge(repo: &Repository, original: git2::Oid, other: git2::Oid) -> Result<(), String> {
    std::fs::write(
        repo.path().join(APP_MERGE_MARKER),
        format!("{original}\n{other}\n"),
    )
    .map_err(|error| error.to_string())
}

fn app_merge_heads(repo: &Repository) -> Result<(git2::Oid, git2::Oid), String> {
    let value = std::fs::read_to_string(repo.path().join(APP_MERGE_MARKER)).map_err(|_| {
        "Cannot abort this merge because it was not started by this app".to_string()
    })?;
    let mut lines = value.lines();
    let original = lines
        .next()
        .and_then(|value| value.parse().ok())
        .ok_or("Cannot abort this merge because its recovery marker is invalid")?;
    let other = lines
        .next()
        .and_then(|value| value.parse().ok())
        .ok_or("Cannot abort this merge because its recovery marker is invalid")?;
    Ok((original, other))
}

fn short_commit(commit: &str) -> String {
    commit.chars().take(7).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_util::{
        attach_remote, bare_remote, cleanup, clone_local, commit_file, diverged_pair, local_repo,
    };

    #[test]
    fn merge_remote_refuses_a_dirty_tracked_worktree_untouched() {
        let (dir, g, remote_dir, clone_dir) =
            diverged_pair("sync-merge-dirty", "theirs\n", "ours\n");

        // Uncommitted edits that already collide with the incoming remote change.
        std::fs::write(dir.join("a.md"), "uncommitted\n").unwrap();
        let head_before = g.repository().unwrap().head().unwrap().target();

        let outcome = g.merge_remote("origin", "main");
        assert!(!outcome.success);
        assert!(!outcome.error.is_empty(), "{}", outcome.message);
        assert!(
            outcome.error.contains("before merging"),
            "{}",
            outcome.error
        );

        // Nothing was reconciled: no merge state to abort, HEAD untouched, and
        // the user's uncommitted edit is still in the worktree.
        let repo = g.repository().unwrap();
        assert_eq!(repo.state(), RepositoryState::Clean);
        assert_eq!(repo.head().unwrap().target(), head_before);
        drop(repo);
        assert_eq!(
            std::fs::read_to_string(dir.join("a.md")).unwrap(),
            "uncommitted\n"
        );
        assert!(g.merge_abort().is_err(), "no merge state was created");

        cleanup(&[&dir, &remote_dir, &clone_dir]);
    }

    #[test]
    fn merge_abort_refuses_system_merge_with_local_edits() {
        let (remote_dir, url) = bare_remote("sync-merge-abort-system-remote");
        let (dir, g) = local_repo("sync-merge-abort-system");
        commit_file(&g, &dir, "a.md", "base\n", "first");
        attach_remote(&g, "origin", &url);

        // A merge state this app did not create (system Git wrote MERGE_HEAD),
        // as the previous middleware did. Aborting must not hard-reset here.
        let repo = g.repository().unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        std::fs::write(dir.join("b.md"), "incoming\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("b.md")).unwrap();
        index.write().unwrap();
        std::fs::write(repo.path().join("MERGE_HEAD"), format!("{}\n", head.id())).unwrap();
        drop(head);
        drop(repo);
        // Uncommitted work the user has not staged.
        std::fs::write(dir.join("a.md"), "scratch\n").unwrap();

        let error = g.merge_abort().unwrap_err();
        assert!(error.contains("not started by this app"), "{error}");
        let repo = g.repository().unwrap();
        assert_eq!(repo.state(), RepositoryState::Merge);
        assert!(!repo.path().join(APP_MERGE_MARKER).exists());
        drop(repo);
        assert_eq!(
            std::fs::read_to_string(dir.join("a.md")).unwrap(),
            "scratch\n"
        );

        cleanup(&[&dir, &remote_dir]);
    }

    #[test]
    fn fetch_then_merge_fast_forwards_local_branch() {
        let (remote_dir, url) = bare_remote("sync-ff-remote");
        let (dir, g) = local_repo("sync-ff");
        commit_file(&g, &dir, "a.md", "a", "first");
        attach_remote(&g, "origin", &url);
        assert!(g.push_checked().success);

        let (clone_dir, clone) = clone_local(&url, "sync-ff-clone");
        commit_file(&clone, &clone_dir, "b.md", "b", "remote ahead");
        assert!(clone.push_checked().success);

        g.fetch_remote("origin").unwrap();
        let outcome = g.merge_remote("origin", "main");
        assert!(outcome.success, "{}{}", outcome.error, outcome.message);
        assert!(
            outcome.message.contains("Fast-forward"),
            "{}",
            outcome.message
        );
        assert!(dir.join("b.md").exists());
        assert!(g.status_with_branch().unwrap().status.trim().is_empty());

        cleanup(&[&dir, &remote_dir, &clone_dir]);
    }

    #[test]
    fn merge_remote_creates_a_merge_commit_for_diverged_history() {
        let (remote_dir, url) = bare_remote("sync-merge-remote");
        let (dir, g) = local_repo("sync-merge");
        commit_file(&g, &dir, "a.md", "a", "first");
        attach_remote(&g, "origin", &url);
        assert!(g.push_checked().success);

        let (clone_dir, clone) = clone_local(&url, "sync-merge-clone");
        commit_file(&clone, &clone_dir, "remote.md", "remote", "remote");
        assert!(clone.push_checked().success);

        commit_file(&g, &dir, "local.md", "local", "local");
        g.fetch_remote("origin").unwrap();
        let outcome = g.merge_remote("origin", "main");
        assert!(outcome.success, "{}{}", outcome.error, outcome.message);
        assert!(outcome.message.contains("Merged"), "{}", outcome.message);
        assert!(dir.join("remote.md").exists());
        assert!(dir.join("local.md").exists());

        let repo = g.repository().unwrap();
        assert_eq!(repo.state(), RepositoryState::Clean);
        assert!(!repo.path().join(APP_MERGE_MARKER).exists());
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2);
        drop(head);
        drop(repo);
        assert!(g.status_with_branch().unwrap().status.trim().is_empty());

        cleanup(&[&dir, &remote_dir, &clone_dir]);
    }

    #[test]
    fn merge_remote_reports_conflicts_and_leaves_them_resolvable() {
        let (remote_dir, url) = bare_remote("sync-conflict-remote");
        let (dir, g) = local_repo("sync-conflict");
        commit_file(&g, &dir, "a.md", "base\n", "first");
        attach_remote(&g, "origin", &url);
        assert!(g.push_checked().success);

        let (clone_dir, clone) = clone_local(&url, "sync-conflict-clone");
        commit_file(&clone, &clone_dir, "a.md", "theirs\n", "theirs");
        assert!(clone.push_checked().success);

        commit_file(&g, &dir, "a.md", "ours\n", "ours");
        g.fetch_remote("origin").unwrap();

        let outcome = g.merge_remote("origin", "main");
        assert!(!outcome.success, "{}", outcome.message);
        assert_eq!(outcome.conflicts, vec!["a.md".to_string()]);
        assert_eq!(
            g.repository().unwrap().state(),
            RepositoryState::Merge,
            "conflicted merge must stay resolvable"
        );

        // The editor flow: resolve in the worktree, stage, commit.
        std::fs::write(dir.join("a.md"), "resolved\n").unwrap();
        g.add_all().unwrap();
        assert!(g.commit("resolve conflict").is_ok());
        let repo = g.repository().unwrap();
        assert_eq!(repo.state(), RepositoryState::Clean);
        assert_eq!(
            repo.head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .parent_count(),
            2
        );

        cleanup(&[&dir, &remote_dir, &clone_dir]);
    }

    #[test]
    fn merge_remote_adopts_remote_branch_when_local_has_no_commits() {
        let (remote_dir, url) = bare_remote("sync-adopt-remote");
        let (seed_dir, seed) = local_repo("sync-adopt-seed");
        commit_file(&seed, &seed_dir, "seed.md", "seed", "seed");
        attach_remote(&seed, "origin", &url);
        assert!(seed.push_checked().success);

        let (dir, g) = local_repo("sync-adopt");
        attach_remote(&g, "origin", &url);
        g.fetch_remote("origin").unwrap();

        let outcome = g.merge_remote("origin", "main");
        assert!(outcome.success, "{}{}", outcome.error, outcome.message);
        assert!(
            outcome.message.contains("Checked out"),
            "{}",
            outcome.message
        );
        assert!(dir.join("seed.md").exists());
        let status = g.status_with_branch().unwrap();
        assert_eq!(status.branch, "main");
        assert_eq!(status.upstream, "origin/main");

        cleanup(&[&dir, &remote_dir, &seed_dir]);
    }
    #[test]
    fn merge_refuses_a_dirty_tracked_worktree() {
        let (dir, g) = local_repo("sync-merge-dirty-guard");
        commit_file(&g, &dir, "a.md", "base\n", "first");
        std::fs::write(dir.join("a.md"), "uncommitted\n").unwrap();

        let outcome = g.merge_remote("origin", "main");
        assert!(!outcome.success);
        assert!(
            outcome.error.contains("before merging"),
            "{}",
            outcome.error
        );
        assert!(
            !outcome.error.contains("No git remote"),
            "{}",
            outcome.error
        );

        cleanup(&[&dir]);
    }
    #[test]
    fn merge_abort_discards_an_in_progress_merge() {
        let (dir, g, remote_dir, clone_dir) =
            diverged_pair("sync-merge-abort", "theirs\n", "ours\n");
        let outcome = g.merge_remote("origin", "main");
        assert!(!outcome.success, "{}", outcome.message);
        let repo = g.repository().unwrap();
        assert_eq!(repo.state(), RepositoryState::Merge);
        assert!(repo.path().join(APP_MERGE_MARKER).exists());
        drop(repo);

        g.merge_abort().unwrap();

        let repo = g.repository().unwrap();
        assert_eq!(repo.state(), RepositoryState::Clean);
        assert!(!repo.path().join(APP_MERGE_MARKER).exists());
        drop(repo);
        assert_eq!(std::fs::read_to_string(dir.join("a.md")).unwrap(), "ours\n");
        assert!(g.status_with_branch().unwrap().status.trim().is_empty());

        cleanup(&[&dir, &remote_dir, &clone_dir]);
    }
}
