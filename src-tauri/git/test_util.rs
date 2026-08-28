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
