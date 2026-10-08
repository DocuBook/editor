//! Per-file diff for the Changes panel: the two sides of a path, staged or not.
//!
//! The panel opens a read-only diff in the editor surface instead of the
//! WYSIWYG editor, so the frontend needs the raw before/after text rather than a
//! rendered patch — computing the line diff itself keeps the view dependency-free.

use git2::Repository;
use std::path::Path;

use super::{git_error, Git};

impl Git {
    /// JSON `{"old": …, "new": …}` for ONE path.
    ///
    /// `staged` compares the index against HEAD (what a commit would record);
    /// otherwise the working tree against the index (what staging would capture).
    /// A side that does not exist — a newly added or deleted file — is an empty
    /// string, so the frontend renders it as a full insertion or deletion.
    pub fn diff_file(&self, path: &str, staged: bool) -> Result<String, String> {
        let repo = self.repository()?;
        let head = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
        let index = repo.index().map_err(git_error)?;
        let (old, new) = if staged {
            (
                head.as_ref()
                    .map(|tree| tree_content(&repo, tree, path))
                    .unwrap_or_default(),
                index_content(&repo, &index, path),
            )
        } else {
            (
                index_content(&repo, &index, path),
                worktree_content(&repo, path),
            )
        };
        Ok(serde_json::json!({ "old": old, "new": new }).to_string())
    }
}

/// Blob content at `path` in `tree`, empty when the path is absent there.
fn tree_content(repo: &Repository, tree: &git2::Tree<'_>, path: &str) -> String {
    tree.get_path(Path::new(path))
        .ok()
        .and_then(|entry| entry.to_object(repo).ok())
        .and_then(|object| object.peel_to_blob().ok())
        .map(|blob| String::from_utf8_lossy(blob.content()).to_string())
        .unwrap_or_default()
}

/// Staged blob content for `path`, empty when it is not in the index.
fn index_content(repo: &Repository, index: &git2::Index, path: &str) -> String {
    index
        .get_path(Path::new(path), 0)
        .and_then(|entry| repo.find_blob(entry.id).ok())
        .map(|blob| String::from_utf8_lossy(blob.content()).to_string())
        .unwrap_or_default()
}

/// Working-tree content for `path`, empty when the file is gone or unreadable.
fn worktree_content(repo: &Repository, path: &str) -> String {
    repo.workdir()
        .map(|dir| dir.join(path))
        .and_then(|full| std::fs::read(full).ok())
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use crate::git::test_util::{cleanup, commit_file, local_repo};

    fn side(json: &str, key: &str) -> String {
        serde_json::from_str::<serde_json::Value>(json).unwrap()[key]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn diff_file_reports_the_base_and_target_of_each_range() {
        let (dir, g) = local_repo("diff-file");
        commit_file(&g, &dir, "a.md", "one\n", "first");

        // Unstaged edit: the index still holds "one", the worktree holds "two".
        std::fs::write(dir.join("a.md"), "two\n").unwrap();
        let unstaged = g.diff_file("a.md", false).unwrap();
        assert_eq!(side(&unstaged, "old"), "one\n");
        assert_eq!(side(&unstaged, "new"), "two\n");

        // Stage it: now HEAD ("one") is the base and the index ("two") is the target.
        g.add_all().unwrap();
        let staged = g.diff_file("a.md", true).unwrap();
        assert_eq!(side(&staged, "old"), "one\n");
        assert_eq!(side(&staged, "new"), "two\n");

        // A brand-new path has an empty base, so the view renders a full insertion.
        std::fs::write(dir.join("b.md"), "fresh\n").unwrap();
        g.add_all().unwrap();
        let added = g.diff_file("b.md", true).unwrap();
        assert_eq!(side(&added, "old"), "");
        assert_eq!(side(&added, "new"), "fresh\n");

        cleanup(&[&dir]);
    }

    #[test]
    fn diff_file_is_empty_when_the_path_is_unchanged() {
        let (dir, g) = local_repo("diff-file-clean");
        commit_file(&g, &dir, "a.md", "same\n", "first");

        let clean = g.diff_file("a.md", false).unwrap();
        assert_eq!(side(&clean, "old"), "same\n");
        assert_eq!(side(&clean, "new"), "same\n");

        cleanup(&[&dir]);
    }
}
