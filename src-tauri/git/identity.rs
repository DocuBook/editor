//! Commit identity: read (`identity`) and set repo-local (`set_identity`).
//! Never touches the user's global git config. Validation runs before any git
//! call, so it is testable without a repository.

use std::process::Command;

use super::Git;

impl Git {
/** Read commit identity (local then global git config). Returns (name, email). */
    pub fn identity(&self) -> Result<(String, String), String> {
        Ok((self.config("user.name"), self.config("user.email")))
    }
    fn config(&self, key: &str) -> String {
        Command::new("git").args(["config", "--get", key]).current_dir(&self.repo_path).output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
    }
/** Set repo-local commit identity. Does NOT touch the user's global git config. */
    pub fn set_identity(&self, name: &str, email: &str) -> Result<(), String> {
        if name.trim().is_empty() || email.trim().is_empty() { return Err("Name and email are required".into()); }
        for (k, v) in [("user.name", name.trim()), ("user.email", email.trim())] {
            let out = Command::new("git").args(["config", k, v]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
            if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        }
        Ok(())
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
