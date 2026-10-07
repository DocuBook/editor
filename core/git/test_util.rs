//! Shared unit-test helper: a unique temp directory for a git repo.
//! Unique per invocation — a stable {pid} suffix would collide across
//! parallel cargo-test threads if any second test reused this pattern.

pub(crate) fn temp_git_repo(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "docubook-test-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
use crate::git::Git;

/// Bare repository with a deterministic `main` HEAD, standing in for a
/// hosted remote (libgit2 talks to local paths without network access).
pub(crate) fn bare_remote(tag: &str) -> (std::path::PathBuf, String) {
    let dir = temp_git_repo(tag);
    let mut options = git2::RepositoryInitOptions::new();
    options.bare(true).initial_head("main");
    git2::Repository::init_opts(&dir, &options).unwrap();
    let url = dir.to_str().unwrap().to_string();
    (dir, url)
}

pub(crate) fn local_repo(tag: &str) -> (std::path::PathBuf, Git) {
    let dir = temp_git_repo(tag);
    let g = Git::open(dir.to_str().unwrap());
    g.init("main").unwrap();
    g.set_identity("T", "t@e.c").unwrap();
    (dir, g)
}

pub(crate) fn commit_file(
    g: &Git,
    dir: &std::path::Path,
    name: &str,
    content: &str,
    message: &str,
) {
    std::fs::write(dir.join(name), content).unwrap();
    g.add_all().unwrap();
    g.commit(message).unwrap();
}

pub(crate) fn attach_remote(g: &Git, name: &str, url: &str) {
    let repo = g.repository().unwrap();
    repo.remote(name, url).unwrap();
}

/// Clone the stand-in remote so a second working copy can add commits.
pub(crate) fn clone_local(url: &str, tag: &str) -> (std::path::PathBuf, Git) {
    let dir = temp_git_repo(tag);
    git2::build::RepoBuilder::new().clone(url, &dir).unwrap();
    let g = Git::open(dir.to_str().unwrap());
    g.set_identity("T", "t@e.c").unwrap();
    (dir, g)
}

pub(crate) fn cleanup(paths: &[&std::path::PathBuf]) {
    for path in paths {
        let _ = std::fs::remove_dir_all(path);
    }
}

/// Shared setup: local pushed `a.md`, the clone advanced the remote, and the
/// local copy then committed its own work — i.e. diverged history.
pub(crate) fn diverged_pair(
    tag: &str,
    remote_edit: &str,
    local_edit: &str,
) -> (
    std::path::PathBuf,
    Git,
    std::path::PathBuf,
    std::path::PathBuf,
) {
    let (remote_dir, url) = bare_remote(&format!("{tag}-remote"));
    let (dir, g) = local_repo(tag);
    commit_file(&g, &dir, "a.md", "base\n", "first");
    attach_remote(&g, "origin", &url);
    assert!(g.push_checked().success);

    let (clone_dir, clone) = clone_local(&url, &format!("{tag}-clone"));
    commit_file(&clone, &clone_dir, "a.md", remote_edit, "remote");
    assert!(clone.push_checked().success);

    commit_file(&g, &dir, "a.md", local_edit, "local");
    g.fetch_remote("origin").unwrap();
    (dir, g, remote_dir, clone_dir)
}
