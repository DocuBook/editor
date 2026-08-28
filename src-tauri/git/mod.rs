//! Git repository wrapper for add-commit-push operations, split by
//! responsibility — each file's name matches its concern:
//!
//! - `repo.rs`     — repository itself: `is_repo`, `init`, `clone_repo`
//! - `status.rs`   — worktree state: `status`, `status_with_branch`, parser
//! - `staging.rs`  — staging: `add_all`, `stage_path`
//! - `commit.rs`   — commits: `commit`, `commit_all`, `has_commits`
//! - `push.rs`     — pushing: `push_checked` (upstream-aware)
//! - `branches.rs` — branch listing + checkout (switcher contract lives here)
//! - `remote.rs`   — remotes: `remotes`, `add_remote`, `remove_remote`, URL check
//! - `identity.rs` — commit identity: `identity`, `set_identity`
//!
//! Both the desktop crate (`src-tauri/lib.rs -> mod git`) and the server crate
//! (`server/main.rs` via `#[path]`) compile this module tree.

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

/// A git repository opened at `repo_path` (the vault root). Every operation
/// shells out to git with argv-passed arguments — no shell interpolation.
pub struct Git { pub repo_path: String }

impl Git {
    /** Open a git repository at the given path. */
    pub fn open(path: &str) -> Self { Self { repo_path: path.to_string() } }
}
