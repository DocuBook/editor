//! Index staging through libgit2.

use std::path::Path;

use git2::IndexAddOption;

use super::{git_error, Git};

impl Git {
    /// Stage all additions, updates, and deletions while excluding `.trash/`
    /// and untracked nested repositories.
    pub fn add_all(&self) -> Result<(), String> {
        let repo = self.repository()?;
        let workdir = repo.workdir().ok_or("Repository has no working tree")?;
        let mut index = repo.index().map_err(git_error)?;
        // `add_all` drops conflict entries and would stage files that still
        // hold conflict markers; conflicts are resolved one path at a time.
        if index.has_conflicts() {
            return Err("Resolve merge conflicts and stage each file before committing".into());
        }
        let mut update_filter = |path: &Path, _: &[u8]| skip_trash(path);
        index
            .update_all(["*"], Some(&mut update_filter))
            .map_err(git_error)?;
        // libgit2 fails the whole call on an untracked directory that holds
        // its own `.git` (a cloned repo inside the vault); leave it untracked.
        let mut add_filter = |path: &Path, _: &[u8]| {
            if workdir.join(path).join(".git").exists() {
                1
            } else {
                skip_trash(path)
            }
        };
        index
            .add_all(["*"], IndexAddOption::DEFAULT, Some(&mut add_filter))
            .map_err(git_error)?;
        index.write().map_err(git_error)
    }

    /// Stage one repository-relative path (plain or quoted as in status),
    /// including deletion of a tracked file.
    pub fn stage_path(&self, path: &str) -> Result<(), String> {
        let path = super::paths::repo_relative(path)?;
        let path = path.as_path();

        let repo = self.repository()?;
        let workdir = repo.workdir().ok_or("Repository has no working tree")?;
        let mut index = repo.index().map_err(git_error)?;
        match std::fs::symlink_metadata(workdir.join(path)) {
            Ok(_) => {
                // `add_path` follows symlinked parent directories; the leaf
                // may be a symlink, but its directory must stay inside the vault.
                let inside = match (
                    workdir.canonicalize(),
                    workdir.join(path).parent().map(Path::canonicalize),
                ) {
                    (Ok(root), Some(Ok(parent))) => parent.starts_with(root),
                    _ => false,
                };
                if !inside {
                    return Err("Path resolves outside the repository".into());
                }
                if index.get_path(path, 0).is_none()
                    && repo.status_should_ignore(path).map_err(git_error)?
                {
                    return Err("Path is ignored by .gitignore".into());
                }
                index.add_path(path).map_err(git_error)?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if index.get_path(path, 0).is_none() && index.conflict_get(path).is_err() {
                    return Err("Path is not in the working tree or the index".into());
                }
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
        g.init("").unwrap();
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
    fn default_gitignore_tracks_supported_formats_only() {
        let dir = temp_git_repo("stage-whitelist");
        let g = Git::open(dir.to_str().unwrap());
        g.init("").unwrap();

        let supported = [
            "note.md",
            "page.mdx",
            "image.png",
            "image.jpg",
            "image.jpeg",
            "image.gif",
            "image.webp",
            "image.ico",
            "image.svg",
            "document.pdf",
            "audio.mp3",
            "video.mp4",
            "video.mov",
            "video.avi",
        ];
        for name in supported {
            std::fs::write(dir.join(name), "content").unwrap();
        }
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("assets/IMAGE.PNG"), "content").unwrap();
        let excluded = [
            "notes.txt",
            "image.bmp",
            "image.avif",
            "archive.zip",
            "archive.tar",
            "archive.gz",
            "archive.rar",
            "binary.exe",
            "binary.dmg",
            "binary.pkg",
            "binary.bin",
        ];
        for name in excluded {
            std::fs::write(dir.join(name), "ignored").unwrap();
        }
        std::fs::write(dir.join(".env"), "SECRET=value").unwrap();
        std::fs::write(dir.join(".env.local"), "SECRET=value").unwrap();
        std::fs::write(dir.join(".DS_Store"), "ignored").unwrap();
        std::fs::write(dir.join(".hidden.md"), "ignored").unwrap();
        std::fs::create_dir_all(dir.join(".trash")).unwrap();
        std::fs::write(dir.join(".trash/deleted.md"), "ignored").unwrap();
        std::fs::create_dir_all(dir.join("node_modules/package")).unwrap();
        std::fs::write(dir.join("node_modules/package/readme.md"), "ignored").unwrap();

        let status = g.status_with_branch().unwrap().status;
        assert!(status.contains("?? note.md"));
        for name in excluded.into_iter().chain([
            ".env",
            ".env.local",
            ".DS_Store",
            ".hidden.md",
            ".trash/deleted.md",
            "node_modules/package/readme.md",
        ]) {
            assert!(!status.contains(name), "{name}");
        }

        g.add_all().unwrap();
        let index = g.repository().unwrap().index().unwrap();
        for name in supported {
            assert!(index.get_path(Path::new(name), 0).is_some(), "{name}");
        }
        assert!(index.get_path(Path::new("assets/IMAGE.PNG"), 0).is_some());
        assert!(index.get_path(Path::new(".gitignore"), 0).is_some());
        for name in excluded.into_iter().chain([
            ".env",
            ".env.local",
            ".DS_Store",
            ".hidden.md",
            ".trash/deleted.md",
            "node_modules/package/readme.md",
        ]) {
            assert!(index.get_path(Path::new(name), 0).is_none(), "{name}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stage_path_rejects_ignored_untracked_file() {
        let dir = temp_git_repo("stage-ignored-path");
        let g = Git::open(dir.to_str().unwrap());
        g.init("").unwrap();
        std::fs::write(dir.join(".env"), "SECRET=value").unwrap();

        assert_eq!(
            g.stage_path(".env").unwrap_err(),
            "Path is ignored by .gitignore"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_all_excludes_trash_and_stages_deletions() {
        let dir = temp_git_repo("stage-all");
        let g = Git::open(dir.to_str().unwrap());
        g.init("").unwrap();
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
        assert!(!status.contains(".trash/deleted.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_all_refuses_while_conflicts_are_unresolved() {
        let (dir, g) = crate::git::test_util::local_repo("stage-all-conflict");
        crate::git::test_util::commit_file(&g, &dir, "a.md", "base\n", "base");
        let repo = g.repository().unwrap();
        let mut index = repo.index().unwrap();
        let entry = index.get_path(Path::new("a.md"), 0).unwrap();
        index.remove_path(Path::new("a.md")).unwrap();
        for stage in 1..=3u16 {
            index
                .add(&git2::IndexEntry {
                    flags: (entry.flags & !0x3000) | (stage << 12),
                    path: entry.path.clone(),
                    ..entry
                })
                .unwrap();
        }
        index.write().unwrap();
        std::fs::write(dir.join("a.md"), "<<<<<<< ours\n=======\n>>>>>>> theirs\n").unwrap();

        assert!(g.add_all().is_err());
        assert!(repo.index().unwrap().has_conflicts());
        crate::git::test_util::cleanup(&[&dir]);
    }

    #[test]
    fn add_all_skips_untracked_nested_repository() {
        let dir = temp_git_repo("stage-all-nested");
        let g = Git::open(dir.to_str().unwrap());
        g.init("").unwrap();
        std::fs::write(dir.join("a.md"), "a").unwrap();
        git2::Repository::init(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/b.md"), "b").unwrap();

        g.add_all().unwrap();
        let index = g.repository().unwrap().index().unwrap();
        assert!(index.get_path(Path::new("a.md"), 0).is_some());
        assert!(index.get_path(Path::new("sub/b.md"), 0).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stage_path_rejects_unknown_missing_path() {
        let dir = temp_git_repo("stage-missing");
        let g = Git::open(dir.to_str().unwrap());
        g.init("").unwrap();
        assert!(g.stage_path("nope.md").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn stage_path_rejects_file_behind_symlinked_directory() {
        use std::os::unix::fs::symlink;

        let dir = temp_git_repo("stage-symlink-dir");
        let outside = temp_git_repo("stage-symlink-outside");
        let g = Git::open(dir.to_str().unwrap());
        g.init("").unwrap();
        std::fs::write(outside.join("secret.md"), "SECRET").unwrap();
        symlink(&outside, dir.join("linkdir")).unwrap();

        assert!(g.stage_path("linkdir/secret.md").is_err());
        let index = g.repository().unwrap().index().unwrap();
        assert!(index.get_path(Path::new("linkdir/secret.md"), 0).is_none());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn stage_path_stages_broken_symlink_as_symlink() {
        use std::os::unix::fs::symlink;

        let dir = temp_git_repo("stage-broken-symlink");
        let g = Git::open(dir.to_str().unwrap());
        g.init("").unwrap();
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

    #[cfg(unix)]
    #[test]
    fn unusual_file_names_round_trip_through_status_stage_and_diff() {
        use std::os::unix::ffi::OsStrExt;

        let (dir, g) = crate::git::test_util::local_repo("stage-quoted");
        let mut names: Vec<&[u8]> = Vec::new();
        for name in [b"line\nbreak.md" as &[u8], b"caf\xe9.md", b" padded.md"] {
            match std::fs::write(dir.join(std::ffi::OsStr::from_bytes(name)), "body\n") {
                Ok(()) => names.push(name),
                // APFS refuses non-UTF-8 names (EILSEQ), so that case only runs elsewhere.
                Err(e)
                    if cfg!(target_os = "macos")
                        && std::str::from_utf8(name).is_err()
                        && e.raw_os_error() == Some(92) => {}
                Err(e) => panic!("{e}"),
            }
        }

        let status = g.status_with_branch().unwrap().status;
        let lines: Vec<&str> = status
            .lines()
            .filter(|line| line.starts_with("?? \""))
            .collect();
        assert_eq!(lines.len(), names.len(), "{status}");
        for line in lines {
            let path = &line[3..];
            assert!(path.starts_with('"'), "{line}");
            g.stage_path(path).unwrap();
            let diff: serde_json::Value =
                serde_json::from_str(&g.diff_file(path, true).unwrap()).unwrap();
            assert_eq!(diff["new"], "body\n", "{line}");
        }
        let index = g.repository().unwrap().index().unwrap();
        for name in names {
            assert!(index
                .get_path(std::path::Path::new(std::ffi::OsStr::from_bytes(name)), 0)
                .is_some());
        }
        crate::git::test_util::cleanup(&[&dir]);
    }
}
