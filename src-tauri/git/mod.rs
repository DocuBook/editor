//! Git repository wrapper backed by libgit2 through `git2-rs`.
//!
//! The desktop and web server share this module tree. Public method contracts
//! stay stable because existing Tauri/server IPC handlers and Git UI consume
//! them directly.

pub mod branches;
pub mod commit;
pub mod identity;
pub mod push;
pub mod remote;
pub mod repo;
pub mod staging;
pub mod status;

#[cfg(test)]
pub(crate) mod test_util;

use std::path::Path;

use git2::{Config, Cred, Error, ErrorCode, RemoteCallbacks, Repository};

/// Git repository rooted at the current vault.
pub struct Git {
    pub repo_path: String,
}

impl Git {
    pub fn open(path: &str) -> Self {
        Self {
            repo_path: path.to_string(),
        }
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
        None => repo.path().join("hooks"),
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
/// or SSH host verification: credential helper, SSH agent, then common keys.
pub(crate) fn remote_callbacks(config: Config) -> RemoteCallbacks<'static> {
    let mut callbacks = RemoteCallbacks::new();
    let mut helper_attempted = false;
    let mut ssh_attempt = 0usize;
    callbacks.credentials(move |url, username, allowed| {
        if allowed.is_username() && !allowed.is_ssh_key() && !allowed.is_user_pass_plaintext() {
            return Cred::username(username.unwrap_or("git"));
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

            if let Some(home) = std::env::var_os("HOME") {
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

        Err(Error::from_str(
            "No supported Git credentials found; configure a credential helper or SSH agent",
        ))
    });
    callbacks
}
