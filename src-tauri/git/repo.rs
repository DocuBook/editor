//! Repository lifecycle: existence check, initialization, and remote clone.

use std::io::Write;

use git2::{build::RepoBuilder, Branch, Config, FetchOptions, Repository, RepositoryInitOptions};
use serde::Serialize;

use super::remote::is_remote_url;
use super::{auto_proxy, credential_config, git_error, remote_callbacks, Git};

/// Track only explicitly declared vault formats from `frontend/utils/fileKind.ts`.
const DEFAULT_GITIGNORE: &str = r#"# DocuBook: track supported vault files only.
*
!*/

# Markdown
!*.[mM][dD]
!*.[mM][dD][xX]

# Images
!*.[pP][nN][gG]
!*.[jJ][pP][gG]
!*.[jJ][pP][eE][gG]
!*.[gG][iI][fF]
!*.[wW][eE][bB][pP]
!*.[iI][cC][oO]
!*.[sS][vV][gG]

# Documents and media
!*.[pP][dD][fF]
!*.[mM][pP]3
!*.[mM][pP]4
!*.[mM][oO][vV]
!*.[aA][vV][iI]

# Never track hidden files or generated trees.
.*
node_modules/
.trash/

# Keep this policy in the repository.
!/.gitignore
"#;

/// Result of [`Git::init`]. `created: false` means a repository already existed
/// and nothing was re-initialized — connecting a hosted remote must only add
/// the remote to the existing repository.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitResult {
    pub created: bool,
    pub branch: String,
}

impl Git {
    pub fn is_repo(&self) -> bool {
        Repository::open(&self.repo_path).is_ok()
    }

    /// Initialize the vault as a git repository on `branch` (empty resolves
    /// `init.defaultBranch` from Git config, then falls back to `master`).
    ///
    /// Idempotent: an existing repository is reported without being touched, so
    /// a local repository created before the hosted one is never re-initialized.
    pub fn init(&self, branch: &str) -> Result<InitResult, String> {
        if self.is_repo() {
            return Ok(InitResult {
                created: false,
                branch: self.current_branch(),
            });
        }

        let branch = resolve_initial_branch(branch)?;
        let mut options = RepositoryInitOptions::new();
        options.initial_head(&branch);
        Repository::init_opts(&self.repo_path, &options).map_err(git_error)?;

        let path = std::path::Path::new(&self.repo_path).join(".gitignore");
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(mut file) => file
                .write_all(DEFAULT_GITIGNORE.as_bytes())
                .map_err(|error| error.to_string())?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }

        Ok(InitResult {
            created: true,
            branch,
        })
    }

    /// Branch name HEAD points at, read symbolically so an unborn HEAD (fresh
    /// repository, no commits) still reports the selected initial branch.
    pub(crate) fn current_branch(&self) -> String {
        let Ok(repo) = self.repository() else {
            return String::new();
        };
        let Ok(head) = repo.find_reference("HEAD") else {
            return String::new();
        };
        match head.symbolic_target() {
            Ok(Some(target)) => target.strip_prefix("refs/heads/").unwrap_or(target).to_string(),
            _ => head.shorthand().unwrap_or_default().to_string(),
        }
    }

    /// Clone into `parent/<url-name>` through libgit2. Local sources remain
    /// rejected because Open Folder already covers them.
    pub fn clone_repo(url: &str, parent: &str) -> Result<String, String> {
        let url = url.trim();
        if !is_remote_url(url) {
            return Err("Invalid repository URL — use https://, git@host:path, ssh://, or git:// (local paths are not supported; use Open Folder instead)".into());
        }
        let name = clone_name(url).ok_or_else(|| {
            format!("Invalid repository URL: cannot derive folder name from \"{url}\"")
        })?;
        let dest = std::path::Path::new(parent).join(&name);
        if dest.exists() {
            return Err(format!(
                "Folder \"{}\" already exists — pick another URL or parent folder",
                dest.display()
            ));
        }

        let mut fetch = FetchOptions::new();
        fetch
            .remote_callbacks(remote_callbacks(credential_config(None)?))
            .proxy_options(auto_proxy());
        let mut builder = RepoBuilder::new();
        builder.fetch_options(fetch);
        builder.clone(url, &dest).map_err(git_error)?;
        Ok(dest.to_string_lossy().to_string())
    }
}

/** Git's classic default. `init.defaultBranch` wins when configured; otherwise we
 *  keep libgit2's historical `master` rather than silently inventing `main` —
 *  the initial branch name is assumed to match the remote branch. */
const FALLBACK_INITIAL_BRANCH: &str = "master";

/** Configured initial branch (`init.defaultBranch`), else `master` — the UI uses
 *  this as the default value of its initial-branch field. */
pub(crate) fn configured_initial_branch() -> String {
    let config = Config::open_default().ok();
    initial_branch_from(config.as_ref())
}

/** Split out so the fallback is testable without touching the machine config. */
fn initial_branch_from(config: Option<&Config>) -> String {
    config
        .and_then(|config| config.get_string("init.defaultBranch").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| FALLBACK_INITIAL_BRANCH.to_string())
}

/** Validate an explicit initial branch, or resolve the configured default. */
fn resolve_initial_branch(branch: &str) -> Result<String, String> {
    let branch = branch.trim();
    let branch = if branch.is_empty() {
        configured_initial_branch()
    } else {
        branch.to_string()
    };
    if !Branch::name_is_valid(&branch).unwrap_or(false) {
        return Err(format!("Invalid branch name \"{branch}\""));
    }
    Ok(branch)
}

fn clone_name(url: &str) -> Option<String> {
    let name = url.trim_end_matches('/').rsplit('/').next()?.to_string();
    let name = name.strip_suffix(".git").unwrap_or(&name).to_string();
    if name.is_empty()
        || name == "."
        || name.contains("..")
        || name.contains('/')
        || name.contains('\\')
    {
        None
    } else {
        Some(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_util::temp_git_repo;

    #[test]
    fn clone_name_derives_from_url() {
        assert_eq!(
            clone_name("https://github.com/user/repo.git").as_deref(),
            Some("repo")
        );
        assert_eq!(
            clone_name("https://github.com/user/repo").as_deref(),
            Some("repo")
        );
        assert_eq!(
            clone_name("git@github.com:user/repo.git").as_deref(),
            Some("repo")
        );
        assert_eq!(
            clone_name("ssh://git@host:22/path/repo").as_deref(),
            Some("repo")
        );
        assert_eq!(clone_name("https://host/a/b/").as_deref(), Some("b"));
    }

    #[test]
    fn clone_name_rejects_traversal() {
        assert_eq!(clone_name("https://host/.."), None);
        assert_eq!(clone_name("https://host/."), None);
        assert_eq!(clone_name(""), None);
        assert_eq!(clone_name("https://host/").as_deref(), Some("host"));
    }

    #[test]
    fn init_creates_a_repo_and_default_gitignore() {
        let dir = temp_git_repo("init");
        let g = Git::open(dir.to_str().unwrap());
        assert!(!g.is_repo());
        let result = g.init("trunk").unwrap();
        assert!(result.created);
        assert_eq!(result.branch, "trunk");
        assert!(g.is_repo());
        assert_eq!(g.current_branch(), "trunk");
        assert_eq!(
            std::fs::read_to_string(dir.join(".gitignore")).unwrap(),
            DEFAULT_GITIGNORE
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn init_never_reinitializes_an_existing_repository() {
        let dir = temp_git_repo("init-existing-repo");
        let g = Git::open(dir.to_str().unwrap());
        assert_eq!(g.init("trunk").unwrap().branch, "trunk");

        let again = g.init("other").unwrap();
        assert!(!again.created);
        assert_eq!(again.branch, "trunk");
        assert_eq!(g.current_branch(), "trunk");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn init_rejects_invalid_branch_name() {
        let dir = temp_git_repo("init-invalid-branch");
        let g = Git::open(dir.to_str().unwrap());
        assert!(g.init("bad branch").is_err());
        assert!(!g.is_repo());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn init_preserves_existing_gitignore() {
        let dir = temp_git_repo("init-existing-ignore");
        std::fs::write(dir.join(".gitignore"), "custom\n").unwrap();
        Git::open(dir.to_str().unwrap()).init("main").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(".gitignore")).unwrap(),
            "custom\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn initial_branch_prefers_config_then_falls_back_to_master() {
        assert_eq!(initial_branch_from(None), "master");

        // `Config::new()` is read-only, so read a real on-disk config file.
        let dir = temp_git_repo("init-branch-config");
        let path = dir.join("config");
        std::fs::write(&path, "[init]\n\tdefaultBranch = trunk\n").unwrap();
        let config = Config::open(&path).unwrap();
        assert_eq!(initial_branch_from(Some(&config)), "trunk");

        std::fs::write(&path, "[init]\n\tdefaultBranch = \"\"\n").unwrap();
        let config = Config::open(&path).unwrap();
        assert_eq!(initial_branch_from(Some(&config)), "master");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn init_without_a_branch_uses_the_resolved_default() {
        let dir = temp_git_repo("init-default-branch");
        let g = Git::open(dir.to_str().unwrap());
        let result = g.init("").unwrap();
        assert!(result.created);
        assert_eq!(result.branch, configured_initial_branch());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clone_repo_validates_url_without_network() {
        assert!(Git::clone_repo("", "/tmp").is_err());
        assert!(Git::clone_repo("file:///etc", "/tmp").is_err());
        assert!(Git::clone_repo("https://host/..", "/tmp").is_err());
        assert!(Git::clone_repo("/tmp/foo", "/tmp").is_err());
        assert!(Git::clone_repo("~/repo", "/tmp").is_err());
        assert!(Git::clone_repo("./repo", "/tmp").is_err());
        assert!(Git::clone_repo("repo", "/tmp").is_err());
        assert!(is_remote_url("https://github.com/user/repo.git"));
        assert!(is_remote_url("http://host/repo.git"));
        assert!(is_remote_url("ssh://git@host:22/path/repo"));
        assert!(is_remote_url("git://host/repo"));
        assert!(is_remote_url("git@github.com:user/repo.git"));
        assert!(is_remote_url("host:user/repo"));
        assert!(!is_remote_url(""));
        assert!(!is_remote_url("file:///tmp/x"));
        assert!(!is_remote_url("/tmp/x"));
        assert!(!is_remote_url("~/x"));
        assert!(!is_remote_url("./x"));
        assert!(!is_remote_url("plainname"));
    }
}
