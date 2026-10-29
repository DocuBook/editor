//! Git repository wrapper backed by libgit2 through `git2-rs`.
//!
//! The desktop and web server share this module tree. Public method contracts
//! stay stable because existing Tauri/server IPC handlers and Git UI consume
//! them directly.

pub mod branches;
pub mod commit;
pub mod credentials;
pub mod diff;
pub mod fetch;
pub mod identity;
pub mod merge;
pub(crate) mod paths;
pub mod pull;
pub mod push;
pub mod rebase;
pub mod remote;
pub mod repo;
pub mod staging;
pub mod status;
pub mod sync;

#[cfg(test)]
pub(crate) mod test_util;

use std::collections::BTreeSet;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use git2::{Config, Cred, Error, ErrorCode, RemoteCallbacks, Repository};

/// Git repository rooted at the current vault.
pub struct Git {
    pub repo_path: String,
}

/// Repositories with a mutating operation in flight. IPC handlers open each
/// command on a fresh `Repository`, so without this a Commit could stage into
/// the index mid-pull, or a checkout could land inside a rebase.
static RUNNING: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());

/// A `Git` that holds the repository's operation slot until dropped.
pub struct ExclusiveGit {
    git: Git,
    key: PathBuf,
}

impl Deref for ExclusiveGit {
    type Target = Git;

    fn deref(&self) -> &Git {
        &self.git
    }
}

impl Drop for ExclusiveGit {
    fn drop(&mut self) {
        RUNNING
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.key);
    }
}

impl Git {
    pub fn open(path: &str) -> Self {
        Self {
            repo_path: path.to_string(),
        }
    }

    /// Open for a mutating operation (stage, commit, sync, checkout, …). Fails
    /// fast instead of queueing: the UI already shows the running operation,
    /// and a queued click would act on state the user has not seen yet.
    /// Called once at the IPC boundary — core methods never take it, so
    /// composite operations (pull → fetch → rebase) do not deadlock.
    pub fn open_exclusive(path: &str) -> Result<ExclusiveGit, String> {
        let key = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
        let mut running = RUNNING.lock().unwrap_or_else(|error| error.into_inner());
        if !running.insert(key.clone()) {
            return Err("Another Git operation is still running — wait for it to finish".into());
        }
        Ok(ExclusiveGit {
            git: Self::open(path),
            key,
        })
    }

    pub(crate) fn repository(&self) -> Result<Repository, String> {
        Repository::open(&self.repo_path).map_err(git_error)
    }
}

pub(crate) fn git_error(error: Error) -> String {
    error.message().trim().to_string()
}

pub(crate) fn credential_config(repo: Option<&Repository>) -> Result<Config, String> {
    match repo {
        Some(repo) => repo.config().map_err(git_error),
        None => Config::open_default()
            .or_else(|_| Config::new())
            .map_err(git_error),
    }
}

pub(crate) fn config_string(config: &Config, name: &str) -> Result<Option<String>, String> {
    match config.get_string(name) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
        Err(error) => Err(git_error(error)),
    }
}

/// libgit2 deliberately does not execute client-side Git hooks. Refuse the
/// operation instead of silently bypassing repository policy.
pub(crate) fn ensure_no_active_hooks(repo: &Repository, names: &[&str]) -> Result<(), String> {
    let config = repo.config().map_err(git_error)?;
    let configured = match config.get_path("core.hooksPath") {
        Ok(path) => Some(path),
        Err(error) if error.code() == ErrorCode::NotFound => None,
        Err(error) => return Err(git_error(error)),
    };
    let hooks_dir = match configured {
        Some(path) if path.is_absolute() => path,
        Some(path) => repo.workdir().unwrap_or_else(|| repo.path()).join(path),
        // Linked worktrees share hooks with the main repository.
        None => repo.commondir().join("hooks"),
    };

    for name in names {
        let hook = hooks_dir.join(name);
        if is_executable_hook(&hook) {
            return Err(format!(
                "Git {name} hook is active; libgit2 cannot execute client hooks. Run this operation with system Git or disable the hook"
            ));
        }
    }
    Ok(())
}

fn is_executable_hook(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub(crate) fn auto_proxy() -> git2::ProxyOptions<'static> {
    let mut proxy = git2::ProxyOptions::new();
    proxy.auto();
    proxy
}

/// Credentials follow normal Git configuration without weakening certificate
/// or SSH host verification: an app-stored HTTPS token (web server only), the
/// credential helper, the SSH agent, then common keys.
pub(crate) fn remote_callbacks(config: Config) -> RemoteCallbacks<'static> {
    let mut callbacks = RemoteCallbacks::new();
    let mut stored_attempted = false;
    let mut stored_host: Option<String> = None;
    let mut helper_attempted = false;
    let mut ssh_attempt = 0usize;
    callbacks.credentials(move |url, username, allowed| {
        if allowed.is_username() && !allowed.is_ssh_key() && !allowed.is_user_pass_plaintext() {
            return Cred::username(username.unwrap_or("git"));
        }

        // Tried once: a rejected token falls through to the other sources
        // instead of being replayed until libgit2 gives up.
        if allowed.is_user_pass_plaintext() && !stored_attempted {
            stored_attempted = true;
            if let Some((host, user, secret)) = credentials::stored_credential(url) {
                stored_host = Some(host);
                return Cred::userpass_plaintext(&user, &secret);
            }
        }

        if allowed.is_user_pass_plaintext() && !helper_attempted {
            helper_attempted = true;
            if let Ok(credential) = Cred::credential_helper(&config, url, username) {
                return Ok(credential);
            }
        }

        if allowed.is_ssh_key() {
            let username = username.unwrap_or("git");
            if ssh_attempt == 0 {
                ssh_attempt += 1;
                if let Ok(credential) = Cred::ssh_key_from_agent(username) {
                    return Ok(credential);
                }
            }

            // Windows usually has no HOME; its profile directory holds `.ssh`.
            if let Some(home) = std::env::var_os("HOME")
                .filter(|home| !home.is_empty())
                .or_else(|| std::env::var_os("USERPROFILE"))
            {
                let ssh_dir = std::path::PathBuf::from(home).join(".ssh");
                let keys = ["id_ed25519", "id_ecdsa", "id_rsa"];
                while ssh_attempt <= keys.len() {
                    let key = ssh_dir.join(keys[ssh_attempt - 1]);
                    ssh_attempt += 1;
                    if key.is_file() {
                        return Cred::ssh_key(username, None, &key, None);
                    }
                }
            }
        }

        if allowed.is_default() {
            return Cred::default();
        }

        Err(Error::from_str(&credentials::missing_credentials_message(
            url,
            stored_host.as_deref(),
        )))
    });
    callbacks
}

#[cfg(test)]
mod tests {
    use super::{test_util, Git};

    #[test]
    fn exclusive_open_rejects_a_second_operation_until_released() {
        let dir = test_util::temp_git_repo("exclusive");
        let path = dir.to_str().unwrap();
        let first = Git::open_exclusive(path).unwrap();
        assert!(Git::open_exclusive(path).is_err());
        drop(first);
        assert!(Git::open_exclusive(path).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
