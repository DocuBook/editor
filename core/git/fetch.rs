//! Remote probe and fetch: can the remote be used, and what does it have?
//!
//! `probe_remote` answers that without transferring objects and never fails, so
//! the UI can render an unreachable remote as data. `fetch_remote` updates the
//! remote-tracking refs that pull/merge/rebase read.

use git2::{Direction, FetchOptions};

use super::sync::RemoteProbe;
use super::{auto_proxy, credential_config, git_error, remote_callbacks, Git};

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
    use crate::git::test_util::{attach_remote, bare_remote, cleanup, commit_file, local_repo};

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
}
