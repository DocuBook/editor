//! Commit identity: inherited reads and repository-local writes.

use git2::ConfigLevel;

use super::{git_error, Git};

impl Git {
    pub fn identity(&self) -> Result<(String, String), String> {
        let config = self.repository()?.config().map_err(git_error)?;
        Ok((
            config.get_string("user.name").unwrap_or_default(),
            config.get_string("user.email").unwrap_or_default(),
        ))
    }

    pub fn set_identity(&self, name: &str, email: &str) -> Result<(), String> {
        if name.trim().is_empty() || email.trim().is_empty() {
            return Err("Name and email are required".into());
        }
        let repo = self.repository()?;
        let config = repo.config().map_err(git_error)?;
        let mut local = config.open_level(ConfigLevel::Local).map_err(git_error)?;
        local.set_str("user.name", name.trim()).map_err(git_error)?;
        local.set_str("user.email", email.trim()).map_err(git_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_identity_validation_without_repo() {
        let g = Git::open("/nonexistent");
        assert!(g.set_identity("", "a@b.c").is_err());
        assert!(g.set_identity("N", "").is_err());
    }
}
