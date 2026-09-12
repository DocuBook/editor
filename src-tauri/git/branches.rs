//! Branch listing, creation, and safe worktree switching.

use std::collections::HashSet;

use git2::{build::CheckoutBuilder, Branch, BranchType, ErrorCode, ObjectType, Repository};
use serde::Serialize;

use super::{git_error, Git};

#[derive(Debug, Serialize, PartialEq)]
pub struct BranchRef {
    pub name: String,
    pub remote: bool,
}

impl Git {
    pub fn branches(&self) -> Result<Vec<BranchRef>, String> {
        let repo = self.repository()?;
        let mut result = Vec::new();
        let mut local_names = HashSet::new();

        for branch in repo.branches(Some(BranchType::Local)).map_err(git_error)? {
            let (branch, _) = branch.map_err(git_error)?;
            let name = String::from_utf8_lossy(branch.name_bytes().map_err(git_error)?).to_string();
            local_names.insert(name.clone());
            result.push(BranchRef {
                name,
                remote: false,
            });
        }

        for branch in repo.branches(Some(BranchType::Remote)).map_err(git_error)? {
            let (branch, _) = branch.map_err(git_error)?;
            let name = String::from_utf8_lossy(branch.name_bytes().map_err(git_error)?).to_string();
            if name.ends_with("/HEAD") {
                continue;
            }
            let short = name.split_once('/').map(|(_, rest)| rest).unwrap_or(&name);
            if !local_names.contains(short) {
                result.push(BranchRef { name, remote: true });
            }
        }
        Ok(result)
    }

    pub fn create_branch(&self, name: &str) -> Result<(), String> {
        let name = valid_branch_name(name)?;
        let repo = self.repository()?;
        let head_commit = repo.head().and_then(|head| head.peel_to_commit());
        match head_commit {
            Ok(commit) => {
                let mut branch = repo.branch(name, &commit, false).map_err(git_error)?;
                if let Err(error) = checkout_branch_object(&repo, branch.get()) {
                    let _ = branch.delete();
                    return Err(error);
                }
                repo.set_head(branch.get().name().map_err(git_error)?)
                    .map_err(git_error)
            }
            Err(error) if matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
                if repo.find_branch(name, BranchType::Local).is_ok() {
                    return Err(format!("Branch \"{name}\" already exists"));
                }
                repo.set_head(&format!("refs/heads/{name}"))
                    .map_err(git_error)
            }
            Err(error) => Err(git_error(error)),
        }
    }

    pub fn checkout_branch(&self, name: &str, remote: bool) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() || name.starts_with('-') {
            return Err("Invalid branch name".into());
        }
        let repo = self.repository()?;
        if !remote {
            return checkout_local(&repo, valid_branch_name(name)?);
        }

        let Some((_, short)) = name.split_once('/') else {
            return Err("Invalid remote branch name".into());
        };
        if short.is_empty() || short.starts_with('-') || short == "HEAD" {
            return Err("Invalid remote branch name".into());
        }
        let short =
            valid_branch_name(short).map_err(|_| "Invalid remote branch name".to_string())?;
        if repo.find_branch(short, BranchType::Local).is_ok() {
            return checkout_local(&repo, short);
        }

        let tracking = repo
            .find_branch(name, BranchType::Remote)
            .map_err(git_error)?;
        let commit = tracking
            .get()
            .peel(ObjectType::Commit)
            .and_then(|object| {
                object
                    .into_commit()
                    .map_err(|_| git2::Error::from_str("Remote branch does not point to a commit"))
            })
            .map_err(git_error)?;
        let mut local = repo.branch(short, &commit, false).map_err(git_error)?;
        if let Err(error) = local.set_upstream(Some(name)).map_err(git_error) {
            let _ = local.delete();
            return Err(error);
        }
        if let Err(error) = checkout_branch_object(&repo, local.get()) {
            let _ = local.delete();
            return Err(error);
        }
        repo.set_head(local.get().name().map_err(git_error)?)
            .map_err(git_error)
    }
}

fn valid_branch_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty()
        || name.starts_with('-')
        || !Branch::name_is_valid(name).map_err(git_error)?
    {
        Err("Invalid branch name".into())
    } else {
        Ok(name)
    }
}

fn checkout_local(repo: &Repository, name: &str) -> Result<(), String> {
    let branch = repo
        .find_branch(name, BranchType::Local)
        .map_err(git_error)?;
    checkout_branch_object(repo, branch.get())?;
    repo.set_head(branch.get().name().map_err(git_error)?)
        .map_err(git_error)
}

fn checkout_branch_object(
    repo: &Repository,
    reference: &git2::Reference<'_>,
) -> Result<(), String> {
    let object = reference.peel(ObjectType::Commit).map_err(git_error)?;
    let mut checkout = CheckoutBuilder::new();
    checkout.safe();
    repo.checkout_tree(&object, Some(&mut checkout))
        .map_err(git_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_util::temp_git_repo;

    fn committed_repo(tag: &str) -> (std::path::PathBuf, Git) {
        let dir = temp_git_repo(tag);
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        g.set_identity("T", "t@e.c").unwrap();
        std::fs::write(dir.join("a.md"), "a").unwrap();
        g.add_all().unwrap();
        g.commit("first").unwrap();
        (dir, g)
    }

    #[test]
    fn branches_list_and_checkout() {
        let (dir, g) = committed_repo("branches");
        let names = |g: &Git| {
            g.branches()
                .unwrap()
                .into_iter()
                .map(|branch| (branch.name, branch.remote))
                .collect::<Vec<_>>()
        };
        let base = names(&g);
        assert_eq!(base.len(), 1);
        let repo = g.repository().unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("dev", &head, false).unwrap();
        drop(head);
        drop(repo);
        assert!(names(&g).contains(&("dev".to_string(), false)));
        g.checkout_branch("dev", false).unwrap();
        assert_eq!(g.status_with_branch().unwrap().branch, "dev");
        assert!(g.checkout_branch("", false).is_err());
        assert!(g.checkout_branch("-x", false).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_branch_validates_and_checks_out() {
        let (dir, g) = committed_repo("create-branch");
        g.create_branch("feature/new").unwrap();
        assert_eq!(g.status_with_branch().unwrap().branch, "feature/new");
        assert!(g.branches().unwrap().contains(&BranchRef {
            name: "feature/new".into(),
            remote: false,
        }));
        assert!(g.create_branch("feature/new").is_err());
        assert!(g.create_branch("bad name").is_err());
        assert!(g.create_branch("-x").is_err());
        assert!(g.create_branch("").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn checkout_preserves_intentionally_deleted_tracked_file() {
        let (dir, g) = committed_repo("checkout-deleted");
        let base_branch = g.status_with_branch().unwrap().branch;
        g.create_branch("other").unwrap();
        g.checkout_branch(&base_branch, false).unwrap();
        std::fs::remove_file(dir.join("a.md")).unwrap();

        g.checkout_branch("other", false).unwrap();
        assert!(!dir.join("a.md").exists());
        assert!(g.status_with_branch().unwrap().status.contains(".D a.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nested_remote_branch_dedupes_and_checkout_is_idempotent() {
        let (dir, g) = committed_repo("branches-nested");
        g.add_remote("origin", "https://example.invalid/repo.git")
            .unwrap();
        g.create_branch("feature/x").unwrap();
        let repo = g.repository().unwrap();
        let head = repo.head().unwrap().target().unwrap();
        repo.reference(
            "refs/remotes/origin/feature/x",
            head,
            true,
            "test remote ref",
        )
        .unwrap();
        drop(repo);
        let names = g.branches().unwrap();
        assert!(names.contains(&BranchRef {
            name: "feature/x".into(),
            remote: false,
        }));
        assert!(!names
            .iter()
            .any(|branch| branch.remote && branch.name == "origin/feature/x"));
        g.checkout_branch("origin/feature/x", true).unwrap();
        assert_eq!(g.status_with_branch().unwrap().branch, "feature/x");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn branches_include_remote_refs_and_switch_creates_tracking() {
        let (dir, g) = committed_repo("branches-remote");
        g.add_remote("origin", "https://example.invalid/repo.git")
            .unwrap();
        let repo = g.repository().unwrap();
        let head = repo.head().unwrap().target().unwrap();
        repo.reference("refs/remotes/origin/feat", head, true, "test remote ref")
            .unwrap();
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/feat",
            true,
            "test remote head",
        )
        .unwrap();
        drop(repo);
        let names = g.branches().unwrap();
        assert!(names.contains(&BranchRef {
            name: "origin/feat".into(),
            remote: true,
        }));
        assert!(!names.iter().any(|branch| branch.name == "origin/HEAD"));
        g.checkout_branch("origin/feat", true).unwrap();
        let state = g.status_with_branch().unwrap();
        assert_eq!(state.branch, "feat");
        assert_eq!(state.upstream, "origin/feat");
        assert!(g.checkout_branch("origin", true).is_err());
        assert!(g.checkout_branch("origin/-x", true).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
