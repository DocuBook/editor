//! Upstream-aware push through libgit2.

use git2::{BranchType, Config, Error, PushOptions, Repository};
use serde::Serialize;

use super::{
    auto_proxy, config_string, credential_config, ensure_no_active_hooks, git_error,
    remote_callbacks, Git,
};

#[derive(Debug, Serialize)]
pub struct PushResult {
    pub success: bool,
    pub commit: String,
    pub message: String,
    pub error: String,
}

impl Git {
    pub fn push_checked(&self) -> PushResult {
        if !self.is_repo() {
            return push_error("Not a git repo");
        }
        let status = match self.status_with_branch() {
            Ok(status) => status,
            Err(error) => return push_error(&error),
        };
        let no_upstream = status.upstream.is_empty();
        if no_upstream && !self.has_commits() {
            return push_success("Nothing to push");
        }
        if status.branch.is_empty() || status.branch.starts_with('(') {
            return push_error("Cannot push detached HEAD without an upstream");
        }

        let repo = match self.repository() {
            Ok(repo) => repo,
            Err(error) => return push_error(&error),
        };
        let config = match repo.config() {
            Ok(config) => config,
            Err(error) => return push_error(&git_error(error)),
        };
        if let Err(error) = ensure_push_policy_supported(&repo, &config) {
            return push_error(&error);
        }
        let remote_name = match push_remote(&repo, &config, &status.branch, &status.upstream) {
            Ok(name) => name,
            Err(error) => return push_error(&error),
        };
        let mut remote = match repo.find_remote(&remote_name) {
            Ok(remote) => remote,
            Err(error) => return push_error(&git_error(error)),
        };
        let configured_refspecs = match configured_push_refspecs(&remote) {
            Ok(refspecs) => refspecs,
            Err(error) => return push_error(&error),
        };
        let local_ref = format!("refs/heads/{}", status.branch);
        let local_id = match repo.refname_to_id(&local_ref) {
            Ok(id) => id,
            Err(error) => return push_error(&git_error(error)),
        };
        let (refspecs, remote_branch, set_upstream) = if configured_refspecs.is_empty() {
            match default_refspecs(
                &config,
                &status.branch,
                &status.upstream,
                &remote_name,
                no_upstream,
            ) {
                Ok(plan) => plan,
                Err(error) => return push_error(&error),
            }
        } else {
            (configured_refspecs, None, false)
        };

        if let Some(branch) = remote_branch.as_deref() {
            let expected_upstream = format!("{remote_name}/{branch}");
            if status.upstream == expected_upstream && status.ahead == 0 {
                return push_success("Nothing to push");
            }
        }

        let credentials = match credential_config(Some(&repo)) {
            Ok(config) => config,
            Err(error) => return push_error(&error),
        };
        let mut callbacks = remote_callbacks(credentials);
        callbacks.push_update_reference(|_, server_status| match server_status {
            Some(message) => Err(Error::from_str(message)),
            None => Ok(()),
        });
        let mut options = PushOptions::new();
        options
            .remote_callbacks(callbacks)
            .proxy_options(auto_proxy());
        if let Err(error) = remote.push(&refspecs, Some(&mut options)) {
            return push_error(&git_error(error));
        }
        drop(options);
        drop(remote);

        if let Some(remote_branch) = remote_branch {
            let tracking_ref = format!("refs/remotes/{remote_name}/{remote_branch}");
            if let Err(error) = repo.reference(
                &tracking_ref,
                local_id,
                true,
                "update remote-tracking branch after push",
            ) {
                return push_error(&format!(
                    "Push succeeded but local tracking update failed: {}",
                    git_error(error)
                ));
            }
            if set_upstream {
                match repo.find_branch(&status.branch, BranchType::Local) {
                    Ok(mut branch) => {
                        let upstream = format!("{remote_name}/{remote_branch}");
                        if let Err(error) = branch.set_upstream(Some(&upstream)) {
                            return push_error(&format!(
                                "Push succeeded but upstream setup failed: {}",
                                git_error(error)
                            ));
                        }
                    }
                    Err(error) => {
                        return push_error(&format!(
                            "Push succeeded but local branch lookup failed: {}",
                            git_error(error)
                        ));
                    }
                }
            }
        }
        push_success("Pushed")
    }
}

fn ensure_push_policy_supported(repo: &Repository, config: &Config) -> Result<(), String> {
    ensure_no_active_hooks(repo, &["pre-push"])?;
    if let Some(value) = config_string(config, "push.gpgSign")? {
        let disabled = matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "false" | "no" | "off" | "0"
        );
        if !disabled {
            return Err("push.gpgSign is enabled; libgit2 cannot create signed push certificates. Push with system Git or disable signed pushes for this repository".into());
        }
    }
    Ok(())
}

fn push_remote(
    repo: &Repository,
    config: &Config,
    branch: &str,
    upstream: &str,
) -> Result<String, String> {
    for key in [
        format!("branch.{branch}.pushRemote"),
        "remote.pushDefault".into(),
        format!("branch.{branch}.remote"),
    ] {
        if let Some(value) = config_string(config, &key)? {
            if value == "." {
                return Err(
                    "Pushing to the local dot-repository is not supported in the Git UI".into(),
                );
            }
            return Ok(value);
        }
    }
    if let Some((remote, _)) = upstream.split_once('/') {
        return Ok(remote.to_string());
    }

    let names = repo.remotes().map_err(git_error)?;
    let mut first = None;
    for name in names.iter() {
        let Some(name) = name.map_err(git_error)? else {
            continue;
        };
        if name == "origin" {
            return Ok(name.to_string());
        }
        first.get_or_insert_with(|| name.to_string());
    }
    first.ok_or_else(|| "No git remote configured".into())
}

fn configured_push_refspecs(remote: &git2::Remote<'_>) -> Result<Vec<String>, String> {
    let values = remote.push_refspecs().map_err(git_error)?;
    let mut refspecs = Vec::new();
    for value in values.iter() {
        if let Some(value) = value.map_err(git_error)? {
            if !value.is_empty() {
                refspecs.push(value.to_string());
            }
        }
    }
    Ok(refspecs)
}

fn default_refspecs(
    config: &Config,
    branch: &str,
    upstream: &str,
    remote: &str,
    no_upstream: bool,
) -> Result<(Vec<String>, Option<String>, bool), String> {
    if no_upstream {
        let local_ref = format!("refs/heads/{branch}");
        return Ok((
            vec![format!("{local_ref}:refs/heads/{branch}")],
            Some(branch.to_string()),
            true,
        ));
    }

    let (upstream_remote, upstream_branch) = upstream
        .split_once('/')
        .ok_or_else(|| "Invalid upstream configuration".to_string())?;
    let mode = config_string(config, "push.default")?
        .unwrap_or_else(|| "simple".into())
        .to_ascii_lowercase();
    let destination = match mode.as_str() {
        "nothing" => return Err("push.default is set to nothing".into()),
        "matching" => return Ok((vec![":".into()], None, false)),
        "current" => branch,
        "upstream" | "tracking" => {
            if remote != upstream_remote {
                return Err("push.default=upstream cannot push to a different remote".into());
            }
            upstream_branch
        }
        "simple" => {
            if remote == upstream_remote && branch != upstream_branch {
                return Err(format!(
                    "push.default=simple requires upstream branch \"{upstream_branch}\" to match local branch \"{branch}\""
                ));
            }
            branch
        }
        other => return Err(format!("Unsupported push.default value \"{other}\"")),
    };
    let local_ref = format!("refs/heads/{branch}");
    Ok((
        vec![format!("{local_ref}:refs/heads/{destination}")],
        Some(destination.to_string()),
        false,
    ))
}

fn push_success(message: &str) -> PushResult {
    PushResult {
        success: true,
        commit: String::new(),
        message: message.into(),
        error: String::new(),
    }
}

fn push_error(error: &str) -> PushResult {
    PushResult {
        success: false,
        commit: String::new(),
        message: String::new(),
        error: error.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_util::temp_git_repo;

    #[test]
    fn push_checked_nothing_to_push_without_remote() {
        let dir = temp_git_repo("push-checked");
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        let result = g.push_checked();
        assert!(result.success);
        assert_eq!(result.message, "Nothing to push");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn first_push_creates_upstream() {
        let dir = temp_git_repo("push-local");
        let remote_dir = temp_git_repo("push-remote");
        git2::Repository::init_bare(&remote_dir).unwrap();
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        g.set_identity("T", "t@e.c").unwrap();
        std::fs::write(dir.join("a.md"), "a").unwrap();
        g.add_all().unwrap();
        g.commit("first").unwrap();
        let repo = g.repository().unwrap();
        repo.remote("origin", remote_dir.to_str().unwrap()).unwrap();
        drop(repo);

        let result = g.push_checked();
        assert!(result.success, "{}", result.error);
        assert_eq!(result.message, "Pushed");
        let status = g.status_with_branch().unwrap();
        assert_eq!(status.upstream, format!("origin/{}", status.branch));
        assert_eq!(status.ahead, 0);
        assert!(git2::Repository::open_bare(&remote_dir)
            .unwrap()
            .refname_to_id(&format!("refs/heads/{}", status.branch))
            .is_ok());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&remote_dir);
    }

    #[test]
    fn branch_push_remote_overrides_upstream_remote() {
        let dir = temp_git_repo("push-remote-override");
        let origin_dir = temp_git_repo("push-origin");
        let publish_dir = temp_git_repo("push-publish");
        git2::Repository::init_bare(&origin_dir).unwrap();
        git2::Repository::init_bare(&publish_dir).unwrap();
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        g.set_identity("T", "t@e.c").unwrap();
        std::fs::write(dir.join("a.md"), "a").unwrap();
        g.add_all().unwrap();
        g.commit("first").unwrap();
        let repo = g.repository().unwrap();
        repo.remote("origin", origin_dir.to_str().unwrap()).unwrap();
        repo.remote("publish", publish_dir.to_str().unwrap())
            .unwrap();
        drop(repo);
        assert!(g.push_checked().success);

        std::fs::write(dir.join("a.md"), "b").unwrap();
        g.add_all().unwrap();
        g.commit("second").unwrap();
        let branch = g.status_with_branch().unwrap().branch;
        g.repository()
            .unwrap()
            .config()
            .unwrap()
            .set_str(&format!("branch.{branch}.pushRemote"), "publish")
            .unwrap();
        let result = g.push_checked();
        assert!(result.success, "{}", result.error);
        assert!(git2::Repository::open_bare(&publish_dir)
            .unwrap()
            .refname_to_id(&format!("refs/heads/{branch}"))
            .is_ok());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&origin_dir);
        let _ = std::fs::remove_dir_all(&publish_dir);
    }
}
