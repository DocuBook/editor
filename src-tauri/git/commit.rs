//! Commit creation from the repository index.

use git2::{ErrorCode, Index, Oid, Repository, RepositoryState};
use serde::Serialize;

use super::{ensure_no_active_hooks, git_error, Git};

#[derive(Debug, Serialize)]
pub struct CommitResult {
    pub success: bool,
    pub commit: String,
    pub message: String,
    pub error: String,
}

impl Git {
    pub fn commit(&self, msg: &str) -> Result<String, String> {
        let mut repo = self.repository()?;
        let mut index = repo.index().map_err(git_error)?;
        if !commit_needed(&repo, &index)? {
            return Err("Nothing to commit".into());
        }
        ensure_commit_policy_supported(&repo)?;

        let parent_ids = commit_parent_ids(&mut repo)?;
        let tree_id = index.write_tree().map_err(git_error)?;
        let tree = repo.find_tree(tree_id).map_err(git_error)?;
        let author = repo.author_from_env().map_err(identity_error)?;
        let committer = repo.committer_from_env().map_err(identity_error)?;
        let parents = parent_ids
            .into_iter()
            .map(|id| repo.find_commit(id).map_err(git_error))
            .collect::<Result<Vec<_>, _>>()?;
        let parent_refs = parents.iter().collect::<Vec<_>>();
        let message = if msg.is_empty() {
            "Auto-commit from Editor"
        } else {
            msg
        };
        let id = repo
            .commit(
                Some("HEAD"),
                &author,
                &committer,
                message,
                &tree,
                &parent_refs,
            )
            .map_err(git_error)?;
        if repo.state() == RepositoryState::Merge {
            repo.cleanup_state().map_err(|error| {
                format!(
                    "Commit {id} created but merge state cleanup failed: {}",
                    git_error(error)
                )
            })?;
        }
        Ok(id.to_string())
    }

    pub fn commit_all(&self, msg: &str) -> CommitResult {
        if !self.is_repo() {
            return commit_error("Not a git repo");
        }
        let repo = match self.repository() {
            Ok(repo) => repo,
            Err(error) => return commit_error(&error),
        };
        let index = match repo.index() {
            Ok(index) => index,
            Err(error) => return commit_error(&git_error(error)),
        };
        match commit_needed(&repo, &index) {
            Ok(false) => CommitResult {
                success: true,
                commit: String::new(),
                message: "Nothing to commit".into(),
                error: String::new(),
            },
            Err(error) => commit_error(&error),
            Ok(true) => match self.commit(msg) {
                Ok(hash) => CommitResult {
                    success: true,
                    commit: hash,
                    message: "Committed".into(),
                    error: String::new(),
                },
                Err(error) => commit_error(&format!("Commit: {error}")),
            },
        }
    }

    pub(crate) fn has_commits(&self) -> bool {
        self.repository()
            .and_then(|repo| repo.head().map_err(git_error).map(|_| ()))
            .is_ok()
    }
}

fn commit_needed(repo: &Repository, index: &Index) -> Result<bool, String> {
    if index.has_conflicts() {
        return Err("Resolve merge conflicts before committing".into());
    }
    if repo.state() == RepositoryState::Merge {
        return Ok(true);
    }
    if repo.state() != RepositoryState::Clean {
        return Err(format!(
            "Cannot commit while repository state is {:?}",
            repo.state()
        ));
    }

    match repo.head().and_then(|head| head.peel_to_tree()) {
        Ok(tree) => repo
            .diff_tree_to_index(Some(&tree), Some(index), None)
            .map(|diff| diff.deltas().len() > 0)
            .map_err(git_error),
        Err(error) if matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
            Ok(!index.is_empty())
        }
        Err(error) => Err(git_error(error)),
    }
}

fn ensure_commit_policy_supported(repo: &Repository) -> Result<(), String> {
    ensure_no_active_hooks(repo, &["pre-commit", "prepare-commit-msg", "commit-msg"])?;
    let config = repo.config().map_err(git_error)?;
    match config.get_bool("commit.gpgSign") {
        Ok(true) => Err("commit.gpgSign is enabled; libgit2 cannot invoke a signing program. Commit with system Git or disable signing for this repository".into()),
        Ok(false) => Ok(()),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(()),
        Err(error) => Err(git_error(error)),
    }
}

fn identity_error(error: git2::Error) -> String {
    format!(
        "{}; set commit name and email in Git settings",
        git_error(error)
    )
}

fn commit_parent_ids(repo: &mut Repository) -> Result<Vec<Oid>, String> {
    let state = repo.state();
    if !matches!(state, RepositoryState::Clean | RepositoryState::Merge) {
        return Err(format!("Cannot commit while repository state is {state:?}"));
    }

    let mut ids = Vec::<Oid>::new();
    match repo.head().and_then(|head| head.peel_to_commit()) {
        Ok(parent) => ids.push(parent.id()),
        Err(error)
            if state == RepositoryState::Clean
                && matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {}
        Err(error) => return Err(git_error(error)),
    }
    if state == RepositoryState::Merge {
        repo.mergehead_foreach(|id| {
            if !ids.contains(id) {
                ids.push(*id);
            }
            true
        })
        .map_err(git_error)?;
        if ids.len() < 2 {
            return Err("Merge state has no distinct MERGE_HEAD parent".into());
        }
    }
    Ok(ids)
}

fn commit_error(error: &str) -> CommitResult {
    CommitResult {
        success: false,
        commit: String::new(),
        message: String::new(),
        error: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_util::temp_git_repo;

    #[test]
    fn commit_all_flow() {
        let dir = temp_git_repo("commit-all");
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        g.set_identity("T", "t@e.c").unwrap();
        let r1 = g.commit_all("Auto-commit: x");
        assert!(r1.success);
        assert_eq!(r1.message, "Nothing to commit");
        std::fs::write(dir.join("a.md"), "hello").unwrap();
        g.add_all().unwrap();
        let r2 = g.commit_all("Auto-commit: a.md");
        assert!(r2.success);
        assert_eq!(r2.message, "Committed");
        assert!(r2.commit.len() >= 7);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_commit_keeps_all_parents_and_cleans_state() {
        let dir = temp_git_repo("commit-merge");
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        g.set_identity("T", "t@e.c").unwrap();
        std::fs::write(dir.join("base.md"), "base").unwrap();
        g.add_all().unwrap();
        g.commit("base").unwrap();
        let base_branch = g.status_with_branch().unwrap().branch;

        let repo = g.repository().unwrap();
        let base = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &base, false).unwrap();
        drop(base);
        drop(repo);
        g.checkout_branch("feature", false).unwrap();
        std::fs::write(dir.join("feature.md"), "feature").unwrap();
        g.add_all().unwrap();
        let feature_id = g.commit("feature").unwrap();
        g.checkout_branch(&base_branch, false).unwrap();
        std::fs::write(dir.join("main.md"), "main").unwrap();
        g.add_all().unwrap();
        std::fs::write(
            g.repository().unwrap().path().join("MERGE_HEAD"),
            format!("{feature_id}\n"),
        )
        .unwrap();

        let merge_id = g.commit("merge feature").unwrap();
        let repo = g.repository().unwrap();
        assert_eq!(
            repo.find_commit(Oid::from_str(&merge_id).unwrap())
                .unwrap()
                .parent_count(),
            2
        );
        assert_eq!(repo.state(), RepositoryState::Clean);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_rejects_policy_libgit2_cannot_enforce() {
        let dir = temp_git_repo("commit-policy");
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        g.set_identity("T", "t@e.c").unwrap();
        std::fs::write(dir.join("a.md"), "a").unwrap();
        g.add_all().unwrap();
        let repo = g.repository().unwrap();
        repo.config()
            .unwrap()
            .set_bool("commit.gpgSign", true)
            .unwrap();
        drop(repo);
        assert!(g.commit("signed").unwrap_err().contains("commit.gpgSign"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
