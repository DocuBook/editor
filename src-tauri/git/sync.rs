//! Remote synchronization: connectivity probe, fetch, and reconciliation merge.
//!
//! This is the local-first half of the Git UI. A vault is often initialized and
//! committed locally before the hosted repository exists, so "the remote" can
//! be empty (plain first push), hold commits we do not have (adopt or merge),
//! or diverge from us (real merge). Nothing here ever forces a push — an
//! unreachable or diverged remote is reported, never overwritten.

use git2::{
    build::CheckoutBuilder, BranchType, Direction, FetchOptions, Repository, RepositoryState,
    ResetType, StatusOptions,
};
use serde::{Deserialize, Serialize};

use super::{auto_proxy, credential_config, git_error, remote_callbacks, Git};

const APP_MERGE_MARKER: &str = "DOCUBOOK_MERGE_HEAD";

/// What a remote looks like before any local history is exchanged.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProbe {
    /// The remote answered (credentials + host reachable).
    pub reachable: bool,
    /// The remote has no branches yet — a safe plain first push target.
    pub empty: bool,
    /// Branch the remote's HEAD points at (`main`), empty when unknown.
    pub default_branch: String,
    /// Number of advertised `refs/heads/*`.
    pub branches: usize,
    /// Failure reason when `reachable` is false.
    pub error: String,
}

/// Outcome of reconciling local history with a remote branch.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub success: bool,
    pub message: String,
    pub error: String,
    /// Conflicted paths — non-empty means the repository is left in a merge
    /// state for the user to resolve in the editor and commit.
    pub conflicts: Vec<String>,
}

/// Outcome of replaying local commits on top of a remote branch.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseOutcome {
    pub success: bool,
    pub message: String,
    pub error: String,
    /// Conflicted paths — non-empty means the repository is left mid-rebase for
    /// the user to resolve, stage, and then Continue (or Abort).
    pub conflicts: Vec<String>,
}

/// Full pull request shared by desktop and web IPC.
#[derive(Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitPullRequest {
    /// Empty resolves through branch push target, then the first configured remote.
    #[serde(default)]
    pub remote: String,
    /// Empty uses the fetched remote's default branch.
    #[serde(default)]
    pub branch: String,
    /// `auto`, `rebase`, or `merge`.
    #[serde(default)]
    pub strategy: PullStrategy,
}

#[derive(Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PullStrategy {
    #[default]
    Auto,
    Rebase,
    Merge,
}

/// Pull result includes fetched-origin state, pre-integration divergence, and
/// any resumable conflicts.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullOutcome {
    pub success: bool,
    pub state: String,
    pub strategy: String,
    pub remote: String,
    pub branch: String,
    pub remote_changed: bool,
    pub ahead: usize,
    pub behind: usize,
    pub message: String,
    pub error: String,
    pub conflicts: Vec<String>,
}

impl Git {
    /// Connect to `name` and list its branches without transferring objects.
    /// Never fails: an unreachable remote is reported through `error`.
    pub fn probe_remote(&self, name: &str) -> RemoteProbe {
        self.probe_remote_inner(name)
            .unwrap_or_else(|error| RemoteProbe {
                reachable: false,
                empty: true,
                default_branch: String::new(),
                branches: 0,
                error: probe_error(&error),
            })
    }

    fn probe_remote_inner(&self, name: &str) -> Result<RemoteProbe, String> {
        let repo = self.repository()?;
        let name = self.resolve_remote(name)?;
        let mut remote = repo.find_remote(&name).map_err(git_error)?;
        let credentials = credential_config(Some(&repo))?;
        remote
            .connect_auth(
                Direction::Fetch,
                Some(remote_callbacks(credentials)),
                Some(auto_proxy()),
            )
            .map_err(git_error)?;

        let (branches, default_branch) = {
            let heads = remote.list().map_err(git_error)?;
            let branches = heads
                .iter()
                .filter(|head| head.name().starts_with("refs/heads/"))
                .count();
            let default_branch = remote
                .default_branch()
                .ok()
                .and_then(|buf| {
                    buf.as_str()
                        .ok()
                        .map(|value| value.trim_start_matches("refs/heads/").to_string())
                })
                .unwrap_or_default();
            (branches, default_branch)
        };
        let _ = remote.disconnect();

        Ok(RemoteProbe {
            reachable: true,
            empty: branches == 0,
            default_branch,
            branches,
            error: String::new(),
        })
    }

    /// Fetch every branch of `name` into `refs/remotes/<name>/*` and refresh the
    /// remote's symbolic HEAD, so the branch switcher and merge flow see it.
    pub fn fetch_remote(&self, name: &str) -> Result<(), String> {
        let repo = self.repository()?;
        let name = self.resolve_remote(name)?;
        let mut remote = repo.find_remote(&name).map_err(git_error)?;
        let refspecs = fetch_refspecs(&remote, &name)?;
        let credentials = credential_config(Some(&repo))?;
        let mut options = FetchOptions::new();
        options
            .remote_callbacks(remote_callbacks(credentials))
            .proxy_options(auto_proxy());
        remote
            .fetch(&refspecs, Some(&mut options), None)
            .map_err(git_error)?;

        if let Ok(buf) = remote.default_branch() {
            if let Ok(target) = buf.as_str() {
                if let Some(branch) = target.strip_prefix("refs/heads/") {
                    let _ = repo.reference_symbolic(
                        &format!("refs/remotes/{name}/HEAD"),
                        &format!("refs/remotes/{name}/{branch}"),
                        true,
                        "update remote HEAD after fetch",
                    );
                }
            }
        }
        let _ = remote.disconnect();
        Ok(())
    }

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

    /// Remote a sync command should talk to: the requested one when given and
    /// known, else the resolved push target, else the first configured remote.
    fn resolve_remote(&self, requested: &str) -> Result<String, String> {
        let repo = self.repository()?;
        let requested = requested.trim();
        if !requested.is_empty() {
            repo.find_remote(requested)
                .map_err(|_| format!("Unknown remote \"{requested}\""))?;
            return Ok(requested.to_string());
        }

        let target = self.push_target();
        if !target.is_empty() && repo.find_remote(&target).is_ok() {
            return Ok(target);
        }
        self.remotes()?
            .into_iter()
            .next()
            .map(|(name, _)| name)
            .ok_or_else(|| "No git remote configured".to_string())
    }

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

/** A merge reconciles committed history, so staged or modified tracked files
 *  would be silently folded into it — or discarded by Abort. Untracked files
 *  (the generated `.gitignore`) are left alone. */
fn ensure_no_tracked_changes(repo: &Repository, action: &str) -> Result<(), String> {
    let mut options = StatusOptions::new();
    options.include_untracked(false);
    for entry in repo.statuses(Some(&mut options)).map_err(git_error)?.iter() {
        let status = entry.status();
        if status.is_conflicted()
            || status.is_index_new()
            || status.is_index_modified()
            || status.is_index_deleted()
            || status.is_wt_modified()
            || status.is_wt_deleted()
            || status.is_wt_typechange()
        {
            let path = entry.path().unwrap_or("(unknown)");
            return Err(format!(
                "Commit or discard local changes to {path} before {action}"
            ));
        }
    }
    Ok(())
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

pub(crate) fn clear_app_merge_marker(repo: &Repository) -> Result<(), String> {
    match std::fs::remove_file(repo.path().join(APP_MERGE_MARKER)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot remove merge recovery marker: {error}")),
    }
}

/** Default fetch refspec: the configured ones, or the Git default when the
 *  remote was added without one (`git remote add` always writes one). */
fn fetch_refspecs(remote: &git2::Remote<'_>, name: &str) -> Result<Vec<String>, String> {
    let values = remote.fetch_refspecs().map_err(git_error)?;
    let mut refspecs = Vec::new();
    for value in values.iter() {
        if let Some(value) = value.map_err(git_error)? {
            let value = value.trim();
            if !value.is_empty() {
                refspecs.push(value.to_string());
            }
        }
    }
    if refspecs.is_empty() {
        // Hand-rolled refspec: Git's default is to write
        // `+refs/heads/*:refs/remotes/<name>/<branch>` per branch, but without
        // one the remote's branches would never be reachable, so the glob is
        // scoped to this remote under `refs/remotes/`.
        refspecs.push(format!("+refs/heads/*:refs/remotes/{name}/*"));
    }
    Ok(refspecs)
}

fn fast_forward(repo: &Repository, id: git2::Oid, target: &str) -> Result<(), String> {
    let object = repo.find_object(id, None).map_err(git_error)?;
    let mut checkout = CheckoutBuilder::new();
    checkout.safe();
    repo.checkout_tree(&object, Some(&mut checkout))
        .map_err(git_error)?;

    let head_name = repo
        .find_reference("HEAD")
        .map_err(git_error)?
        .symbolic_target()
        .ok()
        .flatten()
        .map(|name| name.to_string())
        .ok_or("Cannot fast-forward a detached HEAD")?;
    repo.reference(&head_name, id, true, "fast-forward merge")
        .map_err(git_error)?;

    if let Some(short) = head_name.strip_prefix("refs/heads/") {
        if let Ok(mut local) = repo.find_branch(short, BranchType::Local) {
            let _ = local.set_upstream(Some(target));
        }
    }
    Ok(())
}

fn merge_conflicts(repo: &Repository) -> Result<Vec<String>, String> {
    let index = repo.index().map_err(git_error)?;
    let mut paths = Vec::new();
    for conflict in index.conflicts().map_err(git_error)? {
        let conflict = conflict.map_err(git_error)?;
        let entry = conflict.our.or(conflict.their).or(conflict.ancestor);
        if let Some(entry) = entry {
            let path = String::from_utf8_lossy(&entry.path).to_string();
            if !path.is_empty() && !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    Ok(paths)
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

/** Remote HEAD when known, else a conventional default that actually exists. */
fn default_remote_branch(repo: &Repository, name: &str) -> Result<String, String> {
    if let Ok(head) = repo.find_reference(&format!("refs/remotes/{name}/HEAD")) {
        if let Ok(Some(target)) = head.symbolic_target() {
            let prefix = format!("refs/remotes/{name}/");
            return Ok(target.strip_prefix(&prefix).unwrap_or(target).to_string());
        }
    }
    for candidate in ["main", "master"] {
        if repo
            .find_reference(&format!("refs/remotes/{name}/{candidate}"))
            .is_ok()
        {
            return Ok(candidate.to_string());
        }
    }
    Err(format!(
        "Cannot determine the {name} default branch — fetch the remote first"
    ))
}

fn short_commit(commit: &str) -> String {
    commit.chars().take(7).collect()
}

fn identity_hint(error: git2::Error) -> String {
    format!(
        "{}; set commit name and email in Git settings",
        git_error(error)
    )
}

/** Raw transport failures carry libgit2's wording (host, port, TLS/SSH detail)
 *  into the sync UI, where it reads as noise. Keep the local setup errors that
 *  tell the user what to fix and replace the rest with one actionable line. */
fn probe_error(error: &str) -> String {
    if error.contains("No git remote") || error.starts_with("Unknown remote \"") {
        return error.to_string();
    }
    "Remote is unreachable — check the URL, your network, and your Git credentials".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_util::temp_git_repo;

    /// Bare repository with a deterministic `main` HEAD, standing in for a
    /// hosted remote (libgit2 talks to local paths without network access).
    fn bare_remote(tag: &str) -> (std::path::PathBuf, String) {
        let dir = temp_git_repo(tag);
        let mut options = git2::RepositoryInitOptions::new();
        options.bare(true).initial_head("main");
        git2::Repository::init_opts(&dir, &options).unwrap();
        let url = dir.to_str().unwrap().to_string();
        (dir, url)
    }

    fn local_repo(tag: &str) -> (std::path::PathBuf, Git) {
        let dir = temp_git_repo(tag);
        let g = Git::open(dir.to_str().unwrap());
        g.init("main").unwrap();
        g.set_identity("T", "t@e.c").unwrap();
        (dir, g)
    }

    fn commit_file(g: &Git, dir: &std::path::Path, name: &str, content: &str, message: &str) {
        std::fs::write(dir.join(name), content).unwrap();
        g.add_all().unwrap();
        g.commit(message).unwrap();
    }

    fn attach_remote(g: &Git, name: &str, url: &str) {
        let repo = g.repository().unwrap();
        repo.remote(name, url).unwrap();
    }

    /// Clone the stand-in remote so a second working copy can add commits.
    fn clone_local(url: &str, tag: &str) -> (std::path::PathBuf, Git) {
        let dir = temp_git_repo(tag);
        git2::build::RepoBuilder::new().clone(url, &dir).unwrap();
        let g = Git::open(dir.to_str().unwrap());
        g.set_identity("T", "t@e.c").unwrap();
        (dir, g)
    }

    fn cleanup(paths: &[&std::path::PathBuf]) {
        for path in paths {
            let _ = std::fs::remove_dir_all(path);
        }
    }

    #[test]
    fn probe_reports_empty_then_populated_remote() {
        let (remote_dir, url) = bare_remote("sync-probe-remote");
        let (dir, g) = local_repo("sync-probe");
        attach_remote(&g, "origin", &url);

        let empty = g.probe_remote("origin");
        assert!(empty.reachable, "{}", empty.error);
        assert!(empty.empty);
        assert_eq!(empty.branches, 0);

        let (seed_dir, seed) = local_repo("sync-probe-seed");
        commit_file(&seed, &seed_dir, "seed.md", "seed", "seed");
        attach_remote(&seed, "origin", &url);
        assert!(seed.push_checked().success);

        let populated = g.probe_remote("origin");
        assert!(populated.reachable, "{}", populated.error);
        assert!(!populated.empty);
        assert_eq!(populated.branches, 1);
        assert_eq!(populated.default_branch, "main");

        cleanup(&[&dir, &remote_dir, &seed_dir]);
    }

    #[test]
    fn probe_error_is_actionable_and_hides_transport_detail() {
        // libgit2's raw wording (host, port, TLS/SSH detail) is replaced.
        let raw = "failed to resolve address for docubook-sync-missing.invalid: nodename nor servname provided, or not known";
        let sanitized = probe_error(raw);
        assert!(!sanitized.contains("nodename"), "{sanitized}");
        assert!(sanitized.contains("unreachable"), "{sanitized}");
        // Local setup errors survive: they are the ones the user can act on.
        assert_eq!(
            probe_error("No git remote configured"),
            "No git remote configured"
        );
        assert_eq!(
            probe_error("Unknown remote \"nope\""),
            "Unknown remote \"nope\""
        );
    }

    #[test]
    fn probe_reports_unreachable_remote_without_failing() {
        let (dir, g) = local_repo("sync-probe-missing");
        attach_remote(&g, "origin", "/nonexistent/docubook-sync-missing.git");

        let probe = g.probe_remote("origin");
        assert!(!probe.reachable);
        assert!(probe.empty);
        assert!(!probe.error.is_empty());
        assert!(
            !probe.error.contains("docubook-sync-missing"),
            "{}",
            probe.error
        );

        cleanup(&[&dir]);
    }

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

    /// Shared setup: local pushed `a.md`, the clone advanced the remote, and the
    /// local copy then committed its own work — i.e. diverged history.
    fn diverged_pair(
        tag: &str,
        remote_edit: &str,
        local_edit: &str,
    ) -> (
        std::path::PathBuf,
        Git,
        std::path::PathBuf,
        std::path::PathBuf,
    ) {
        let (remote_dir, url) = bare_remote(&format!("{tag}-remote"));
        let (dir, g) = local_repo(tag);
        commit_file(&g, &dir, "a.md", "base\n", "first");
        attach_remote(&g, "origin", &url);
        assert!(g.push_checked().success);

        let (clone_dir, clone) = clone_local(&url, &format!("{tag}-clone"));
        commit_file(&clone, &clone_dir, "a.md", remote_edit, "remote");
        assert!(clone.push_checked().success);

        commit_file(&g, &dir, "a.md", local_edit, "local");
        g.fetch_remote("origin").unwrap();
        (dir, g, remote_dir, clone_dir)
    }

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

    #[test]
    fn sync_commands_resolve_the_push_target_when_no_remote_is_named() {
        let (remote_dir, url) = bare_remote("sync-resolve-remote");
        let (dir, g) = local_repo("sync-resolve");
        attach_remote(&g, "origin", &url);

        // Empty name falls back to the resolved push target (`origin`).
        g.fetch_remote("").unwrap();
        let probe = g.probe_remote("");
        assert!(probe.reachable, "{}", probe.error);
        assert!(probe.empty);

        assert!(g.rebase_remote("", "").error.contains("No local commits"));
        // Resolution works: the failure is about the (empty) remote branch, not
        // about a missing/ambiguous remote.
        let merge = g.merge_remote("", "");
        assert!(!merge.success);
        assert!(!merge.error.contains("No git remote"), "{}", merge.error);

        cleanup(&[&dir, &remote_dir]);
    }
}
