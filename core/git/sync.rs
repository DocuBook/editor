//! Shared core of remote synchronization: the outcome types exchanged with the
//! UI, plus the helpers the probe/fetch/pull/merge/rebase modules share.
//!
//! This is the local-first half of the Git UI. A vault is often initialized and
//! committed locally before the hosted repository exists, so "the remote" can
//! be empty (plain first push), hold commits we do not have (adopt or merge),
//! or diverge from us (real merge). Nothing here ever forces a push — an
//! unreachable or diverged remote is reported, never overwritten. The actual
//! operations live in the sibling modules (`fetch`, `pull`, `merge`, `rebase`).

use git2::{build::CheckoutBuilder, BranchType, Repository, StatusOptions};
use serde::{Deserialize, Serialize};

use super::{git_error, Git};

pub(super) const APP_MERGE_MARKER: &str = "DOCUBOOK_MERGE_HEAD";

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
    /// Remote a sync command should talk to: the requested one when given and
    /// known, else the resolved push target, else the first configured remote.
    pub(super) fn resolve_remote(&self, requested: &str) -> Result<String, String> {
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
}

/** A merge reconciles committed history, so staged or modified tracked files
 *  would be silently folded into it — or discarded by Abort. Untracked files
 *  (the generated `.gitignore`) are left alone. */
pub(super) fn ensure_no_tracked_changes(repo: &Repository, action: &str) -> Result<(), String> {
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

pub(crate) fn clear_app_merge_marker(repo: &Repository) -> Result<(), String> {
    match std::fs::remove_file(repo.path().join(APP_MERGE_MARKER)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot remove merge recovery marker: {error}")),
    }
}

pub(super) fn fast_forward(repo: &Repository, id: git2::Oid, target: &str) -> Result<(), String> {
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

pub(super) fn merge_conflicts(repo: &Repository) -> Result<Vec<String>, String> {
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

/** Remote HEAD when known, else a conventional default that actually exists. */
pub(super) fn default_remote_branch(repo: &Repository, name: &str) -> Result<String, String> {
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

pub(super) fn identity_hint(error: git2::Error) -> String {
    format!(
        "{}; set commit name and email in Git settings",
        git_error(error)
    )
}

#[cfg(test)]
mod tests {
    use crate::git::test_util::{attach_remote, bare_remote, cleanup, local_repo};

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
