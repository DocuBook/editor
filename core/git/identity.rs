//! Commit identity: inherited from the user's Git config, overridable per vault.
//!
//! A vault follows the global (or XDG/system) `user.name` / `user.email` like
//! any repository. Only an explicit edit writes the vault's own `.git/config`,
//! and clearing that override makes it follow the global identity again.

use git2::{Config, ConfigLevel, ErrorCode};
use serde::Serialize;

use super::{git_error, Git};

/// Where the effective identity comes from.
#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum IdentitySource {
    /// The vault's `.git/config` sets `user.name` or `user.email`.
    Local,
    /// Inherited from the global, XDG or system Git config.
    Global,
    /// No identity anywhere: committing fails until one is set.
    None,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    /// What a commit in this vault uses.
    pub name: String,
    pub email: String,
    pub source: IdentitySource,
    /// The inherited identity a cleared override falls back to.
    pub global_name: String,
    pub global_email: String,
}

impl Git {
    /// Effective `(name, email)` — the vault override, else the inherited one.
    pub fn identity(&self) -> Result<(String, String), String> {
        let info = self.identity_info()?;
        Ok((info.name, info.email))
    }

    pub fn identity_info(&self) -> Result<Identity, String> {
        let repo = self.repository()?;
        let config = repo.config().map_err(git_error)?;
        let local = config.open_level(ConfigLevel::Local).map_err(git_error)?;
        let overridden =
            string(&local, "user.name")?.is_some() || string(&local, "user.email")?.is_some();
        let name = string(&config, "user.name")?.unwrap_or_default();
        let email = string(&config, "user.email")?.unwrap_or_default();
        // Everything above the repository: global, XDG and system config.
        let (global_name, global_email) = match Config::open_default() {
            Ok(inherited) => (
                string(&inherited, "user.name")?.unwrap_or_default(),
                string(&inherited, "user.email")?.unwrap_or_default(),
            ),
            Err(_) => Default::default(),
        };
        let source = if overridden {
            IdentitySource::Local
        } else if !name.is_empty() || !email.is_empty() {
            IdentitySource::Global
        } else {
            IdentitySource::None
        };
        Ok(Identity {
            name,
            email,
            source,
            global_name,
            global_email,
        })
    }

    /// Override the identity for this vault only; the global config is untouched.
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

    /// Drop the vault override so commits use the inherited identity again.
    pub fn clear_identity(&self) -> Result<(), String> {
        let repo = self.repository()?;
        let config = repo.config().map_err(git_error)?;
        let mut local = config.open_level(ConfigLevel::Local).map_err(git_error)?;
        for key in ["user.name", "user.email"] {
            match local.remove(key) {
                Ok(()) => {}
                Err(error) if error.code() == ErrorCode::NotFound => {}
                Err(error) => return Err(git_error(error)),
            }
        }
        Ok(())
    }
}

/// A string config value; `None` when unset, an error only for a real failure.
fn string(config: &Config, key: &str) -> Result<Option<String>, String> {
    match config.get_string(key) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
        Err(error) => Err(git_error(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_util::{cleanup, temp_git_repo};

    #[test]
    fn set_identity_validation_without_repo() {
        let g = Git::open("/nonexistent");
        assert!(g.set_identity("", "a@b.c").is_err());
        assert!(g.set_identity("N", "").is_err());
    }

    #[test]
    fn init_does_not_pin_an_identity_into_the_vault() {
        let dir = temp_git_repo("identity-init");
        let g = Git::open(dir.to_str().unwrap());
        g.init("main").unwrap();

        let info = g.identity_info().unwrap();
        assert_ne!(info.source, IdentitySource::Local);
        // Whatever this machine's global config holds is what the vault uses.
        assert_eq!(
            (info.name, info.email),
            (info.global_name, info.global_email)
        );
        let local = std::fs::read_to_string(dir.join(".git/config")).unwrap();
        assert!(!local.contains("[user]"), "{local}");
        cleanup(&[&dir]);
    }

    #[test]
    fn an_override_is_local_and_clearing_it_follows_global_again() {
        let dir = temp_git_repo("identity-override");
        let g = Git::open(dir.to_str().unwrap());
        g.init("main").unwrap();
        let inherited = g.identity_info().unwrap();

        g.set_identity(" Vault Author ", "vault@example.com")
            .unwrap();
        let info = g.identity_info().unwrap();
        assert_eq!(info.source, IdentitySource::Local);
        assert_eq!(info.name, "Vault Author");
        assert_eq!(info.email, "vault@example.com");
        // The inherited identity is reported unchanged next to the override.
        assert_eq!(info.global_name, inherited.global_name);

        g.clear_identity().unwrap();
        g.clear_identity().unwrap(); // idempotent
        let info = g.identity_info().unwrap();
        assert_ne!(info.source, IdentitySource::Local);
        assert_eq!((info.name, info.email), (inherited.name, inherited.email));
        cleanup(&[&dir]);
    }
}
