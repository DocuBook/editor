//! Remote configuration and URL validation.

use git2::Remote;

use super::{git_error, Git};

impl Git {
    #[allow(dead_code)]
    pub fn has_remote(&self) -> bool {
        self.repository()
            .and_then(|repo| repo.remotes().map_err(git_error))
            .map(|remotes| !remotes.is_empty())
            .unwrap_or(false)
    }

    pub fn remotes(&self) -> Result<Vec<(String, String)>, String> {
        let repo = self.repository()?;
        let names = repo.remotes().map_err(git_error)?;
        let mut remotes = Vec::new();
        for name in names.iter() {
            let Some(name) = name.map_err(git_error)? else {
                continue;
            };
            let remote = repo.find_remote(name).map_err(git_error)?;
            remotes.push((
                name.to_string(),
                remote.url().map_err(git_error)?.to_string(),
            ));
        }
        Ok(remotes)
    }

    pub fn add_remote(&self, name: &str, url: &str) -> Result<(), String> {
        if name.is_empty()
            || name.contains('/')
            || name.contains(' ')
            || name == "."
            || name.contains("..")
            || !Remote::is_valid_name(name)
        {
            return Err("Invalid remote name".into());
        }
        if !is_remote_url(url) {
            return Err(
                "Invalid remote URL — use https://, git@host:path, ssh://, or git://".into(),
            );
        }
        self.repository()?
            .remote(name, url)
            .map(|_| ())
            .map_err(git_error)
    }

    pub fn remove_remote(&self, name: &str) -> Result<(), String> {
        self.repository()?.remote_delete(name).map_err(git_error)
    }
}

pub(crate) fn is_remote_url(url: &str) -> bool {
    if url.is_empty() {
        return false;
    }
    if url.contains("://") {
        return !url.starts_with("file://");
    }
    let Some((host, path)) = url.split_once(':') else {
        return false;
    };
    let host = host.rsplit_once('@').map(|(_, h)| h).unwrap_or(host);
    !host.is_empty() && !host.contains('/') && !path.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_remote_validation_without_repo() {
        let g = Git::open("/nonexistent");
        assert!(g.add_remote("bad name", "https://x/y.git").is_err());
        assert!(g.add_remote("../evil", "https://x/y.git").is_err());
        assert!(g.add_remote("origin", "/tmp/local").is_err());
        assert!(g.add_remote("origin", "file:///tmp/x").is_err());
    }
}
