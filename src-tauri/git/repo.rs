//! Repository lifecycle: existence check, initialization, and remote clone.

use std::io::Write;

use git2::{build::RepoBuilder, FetchOptions, Repository};

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

impl Git {
    pub fn is_repo(&self) -> bool {
        Repository::open(&self.repo_path).is_ok()
    }

    pub fn init(&self) -> Result<(), String> {
        Repository::init(&self.repo_path).map_err(git_error)?;
        let path = std::path::Path::new(&self.repo_path).join(".gitignore");
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(mut file) => file
                .write_all(DEFAULT_GITIGNORE.as_bytes())
                .map_err(|error| error.to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(error.to_string()),
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
        g.init().unwrap();
        assert!(g.is_repo());
        assert_eq!(
            std::fs::read_to_string(dir.join(".gitignore")).unwrap(),
            DEFAULT_GITIGNORE
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn init_preserves_existing_gitignore() {
        let dir = temp_git_repo("init-existing-ignore");
        std::fs::write(dir.join(".gitignore"), "custom\n").unwrap();
        Git::open(dir.to_str().unwrap()).init().unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(".gitignore")).unwrap(),
            "custom\n"
        );
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
