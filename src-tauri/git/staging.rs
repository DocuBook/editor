//! Index staging through libgit2.

use std::path::{Component, Path};

use git2::IndexAddOption;

use super::{git_error, Git};

impl Git {
    /// Stage all additions, updates, and deletions while excluding `.trash/`.
    pub fn add_all(&self) -> Result<(), String> {
        let repo = self.repository()?;
        let mut index = repo.index().map_err(git_error)?;
        let mut update_filter = |path: &Path, _: &[u8]| skip_trash(path);
        index
            .update_all(["*"], Some(&mut update_filter))
            .map_err(git_error)?;
        let mut add_filter = |path: &Path, _: &[u8]| skip_trash(path);
        index
            .add_all(["*"], IndexAddOption::DEFAULT, Some(&mut add_filter))
            .map_err(git_error)?;
        index.write().map_err(git_error)
    }

    /// Stage one repository-relative path, including deletion of a tracked file.
    pub fn stage_path(&self, path: &str) -> Result<(), String> {
        let path = Path::new(path);
        if path.as_os_str().is_empty()
            || path
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("Invalid repository-relative path".into());
        }

        let repo = self.repository()?;
        let workdir = repo.workdir().ok_or("Repository has no working tree")?;
        let mut index = repo.index().map_err(git_error)?;
        match std::fs::symlink_metadata(workdir.join(path)) {
            Ok(_) => index.add_path(path).map_err(git_error)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                index.remove_path(path).map_err(git_error)?
            }
            Err(error) => return Err(error.to_string()),
        }
        index.write().map_err(git_error)
    }
}

fn skip_trash(path: &Path) -> i32 {
    if path == Path::new(".trash") || path.starts_with(".trash") {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_util::temp_git_repo;

    #[test]
    fn stage_path_stages_only_that_file() {
        let dir = temp_git_repo("stage-path");
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        std::fs::write(dir.join("a.md"), "a").unwrap();
        std::fs::write(dir.join("b.md"), "b").unwrap();
        g.stage_path("a.md").unwrap();
        let ws = g.status_with_branch().unwrap();
        assert!(ws.status.contains("A. a.md"));
        assert!(ws.status.contains("?? b.md"));
        assert!(!ws.status.contains("A. b.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_all_excludes_trash_and_stages_deletions() {
        let dir = temp_git_repo("stage-all");
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        g.set_identity("T", "t@e.c").unwrap();
        std::fs::write(dir.join("old.md"), "old").unwrap();
        g.add_all().unwrap();
        g.commit("first").unwrap();
        std::fs::remove_file(dir.join("old.md")).unwrap();
        std::fs::create_dir_all(dir.join(".trash")).unwrap();
        std::fs::write(dir.join(".trash/deleted.md"), "deleted").unwrap();

        g.add_all().unwrap();
        let status = g.status_with_branch().unwrap().status;
        assert!(status.contains("D. old.md"));
        assert!(status.contains("?? .trash/deleted.md"));
        assert!(!status.contains("A. .trash/deleted.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn stage_path_stages_broken_symlink_as_symlink() {
        use std::os::unix::fs::symlink;

        let dir = temp_git_repo("stage-broken-symlink");
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        symlink("missing-target", dir.join("link.md")).unwrap();
        g.stage_path("link.md").unwrap();

        let repo = g.repository().unwrap();
        let entry = repo
            .index()
            .unwrap()
            .get_path(Path::new("link.md"), 0)
            .unwrap();
        assert_eq!(entry.mode, 0o120000);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
