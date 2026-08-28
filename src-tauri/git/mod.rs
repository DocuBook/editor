
use std::process::Command;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct PushResult { pub success: bool, pub commit: String, pub message: String, pub error: String }

/** Parsed `status --porcelain=v2 -b` summary: branch name, v1-style status
 *  lines (`XY path`), upstream tracking ref (empty = never pushed), and
 *  ahead/behind counts vs that upstream. */
#[derive(Debug, Default, Serialize)]
pub struct WorktreeStatus {
    pub branch: String,
    pub upstream: String,
    pub status: String,
    pub ahead: usize,
    pub behind: usize,
}

/** Result of `commit_all` — an empty worktree is a success with `Nothing to commit`. */
#[derive(Debug, Serialize)]
pub struct CommitResult { pub success: bool, pub commit: String, pub message: String, pub error: String }

/** A branch for the switcher: local (`remote: false`) or a remote-tracking
 *  ref (`remote: true`, full name like `origin/dev`). Sourced from the actual
 *  refs — never assumed/hardcoded. */
#[derive(Debug, Serialize, PartialEq)]
pub struct BranchRef {
    pub name: String,
    pub remote: bool,
}

/// Git repository wrapper for add-commit-push operations.
pub struct Git { pub repo_path: String }

impl Git {
/** Open a git repository at the given path. */
    pub fn open(path: &str) -> Self { Self { repo_path: path.to_string() } }
/** Check if the path is a valid git repository (exit status, not just command ran).
 *  Uses .output() (pipes stdout) so git does not print to the app terminal —
 *  .status() inherits stdout and would spam `git rev-parse --git-dir` output (".git"). */
    pub fn is_repo(&self)  -> bool {
        Command::new("git").args(["rev-parse", "--git-dir"]).current_dir(&self.repo_path).output().map(|o| o.status.success()).unwrap_or(false)
    }
    /** Check whether at least one remote is configured. */
    #[allow(dead_code)] // Shared server build does not use this desktop-only query.
    pub fn has_remote(&self) -> bool {
        Command::new("git").arg("remote").current_dir(&self.repo_path).output().map(|o| o.status.success() && !o.stdout.is_empty()).unwrap_or(false)
    }
/** Return git status as porcelain string. */
    pub fn status(&self) -> Result<String, String> {
        let out = Command::new("git").args(["status", "--porcelain"]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    /** Branch + status + ahead/behind in ONE git subprocess (PERF: the old
     *  two-command rev-parse + status cost ~2× per 3s poll). Runs
     *  `status --porcelain=v2 -b`, maps v2 lines back to v1-style `XY path`
     *  (frontend parsers unchanged) and parses ahead/behind vs upstream. */
    pub fn status_with_branch(&self) -> Result<WorktreeStatus, String> {
        let out = Command::new("git")
            .args(["status", "--porcelain=v2", "-b"])
            .current_dir(&self.repo_path)
            .output()
            .map_err(|e| e.to_string())?;
        Ok(parse_porcelain_v2(&String::from_utf8_lossy(&out.stdout)))
    }
/** Stage all changes, excluding the vault `.trash/` (deleted notes must not be
 *  committed as moves into the trash). Pathspec works for any repo, no
 *  .gitignore required. */
    pub fn add_all(&self) -> Result<(), String> {
        let out = Command::new("git").args(["add", "-A", "--", ".", ":!.trash"]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        Ok(())
    }
/** Stage a single path (the active tab) — never touches other files, unlike
 *  add_all. The `.trash` exclusion from add_all does not apply: editor saves
 *  only ever target live vault files. */
    pub fn stage_path(&self, path: &str) -> Result<(), String> {
        let out = Command::new("git").args(["add", "--", path]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        Ok(())
    }
/** Commit with message. Returns commit hash. */
    pub fn commit(&self, msg: &str) -> Result<String, String> {
        let m = if msg.is_empty() { "Auto-commit from Editor" } else { msg };
        let out = Command::new("git").args(["commit", "-m", m]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        let hash = Command::new("git").args(["rev-parse", "HEAD"]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&hash.stdout).trim().to_string())
    }
/** Commit what is staged. An empty worktree is a success with
 *  `Nothing to commit` (the commit box stays open, no error state). */
    pub fn commit_all(&self, msg: &str) -> CommitResult {
        if !self.is_repo() { return CommitResult { success: false, commit: String::new(), message: String::new(), error: "Not a git repo".into() } }
        let status = match self.status() { Ok(s) => s, Err(e) => return CommitResult { success: false, commit: String::new(), message: String::new(), error: e.to_string() } };
        if status.trim().is_empty() { return CommitResult { success: true, commit: String::new(), message: "Nothing to commit".into(), error: String::new() } }
        match self.commit(msg) {
            Ok(h) => CommitResult { success: true, commit: h, message: "Committed".into(), error: String::new() },
            Err(e) => CommitResult { success: false, commit: String::new(), message: String::new(), error: format!("Commit: {}", e) },
        }
    }
/** Push commits to the configured upstream. Nothing ahead → `Nothing to push`
 *  (success, no-op). Independent of the worktree state, fixing the old
 *  push_full retry trap: a clean worktree after a failed push used to report
 *  "Nothing to push" forever, stranding the un-pushed commit.
 *
 *  Branch without upstream (first push): push with `-u <remote> <branch>` so
 *  the tracking ref is created — the StatusBar shows the branch as untracked
 *  until then instead of blocking Push (ahead is meaningless without upstream). */
    pub fn push_checked(&self) -> PushResult {
        if !self.is_repo() { return PushResult { success: false, commit: String::new(), message: String::new(), error: "Not a git repo".into() } }
        let ws = match self.status_with_branch() { Ok(w) => w, Err(e) => return PushResult { success: false, commit: String::new(), message: String::new(), error: e.to_string() } };
        let no_upstream = ws.upstream.is_empty();
        if !no_upstream && ws.ahead == 0 {
            return PushResult { success: true, commit: String::new(), message: "Nothing to push".into(), error: String::new() };
        }
        if no_upstream && !self.has_commits() {
            // Brand-new repo (no commits yet): nothing to push — and git would
            // reject the empty refspec even with -u.
            return PushResult { success: true, commit: String::new(), message: "Nothing to push".into(), error: String::new() };
        }
        let mut cmd = Command::new("git");
        cmd.arg("push").current_dir(&self.repo_path);
        if no_upstream {
            // Detached HEAD ("(HEAD detached at …)") cannot take -u — fall back
            // to a plain push whose stderr explains the situation.
            if !ws.branch.starts_with('(') {
                let remotes = self.remotes().unwrap_or_default();
                let remote = if remotes.iter().any(|(n, _)| n == "origin") { "origin" } else { remotes.first().map(|(n, _)| n.as_str()).unwrap_or("origin") };
                cmd.arg("-u").arg(remote).arg(&ws.branch);
            }
        }
        let out = match cmd.output() { Ok(o) => o, Err(e) => return PushResult { success: false, commit: String::new(), message: String::new(), error: e.to_string() } };
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return PushResult { success: false, commit: String::new(), message: String::new(), error: if stderr.is_empty() { "Push failed".into() } else { stderr } };
        }
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        PushResult { success: true, commit: String::new(), message: if stdout.is_empty() { "Pushed".into() } else { stdout }, error: String::new() }
    }
/** True if HEAD points at a commit (a brand-new repository with no commits
 *  cannot be pushed even with -u — git rejects the empty refspec). */
    fn has_commits(&self) -> bool {
        Command::new("git").args(["rev-parse", "--verify", "HEAD"]).current_dir(&self.repo_path).output().map(|o| o.status.success()).unwrap_or(false)
    }
/** List branches from actual refs — local (`refs/heads`) first, then
 *  remote-tracking (`refs/remotes`). A remote ref whose short name already
 *  exists locally is skipped: switching there should use the local branch.
 *
 *  Remotes are surfaced as their full ref name (`origin/dev`) so the switcher
 *  can check them out as new local tracking branches. */
    pub fn branches(&self) -> Result<Vec<BranchRef>, String> {
        let out = Command::new("git").args(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        let mut refs: Vec<BranchRef> = Vec::new();
        let mut local: Vec<String> = Vec::new();
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("refs/heads/") {
                local.push(rest.to_string());
                refs.push(BranchRef { name: rest.to_string(), remote: false });
            } else if let Some(rest) = line.strip_prefix("refs/remotes/") {
                let short = rest.rsplit('/').next().unwrap_or(rest).to_string();
                if !local.contains(&short) {
                    refs.push(BranchRef { name: rest.to_string(), remote: true });
                }
            }
        }
        Ok(refs)
    }
/** Switch branches. `remote: false` → plain `git checkout <name>`; `remote:
 *  true` (name like `origin/dev`) → `git switch -c dev --track origin/dev`,
 *  creating the local tracking branch. Name is argv-passed (no shell
 *  injection) and validated so it can never be parsed as a flag. */
    pub fn checkout_branch(&self, name: &str, remote: bool) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() || name.starts_with('-') { return Err("Invalid branch name".into()); }
        if remote {
            let Some((_, short)) = name.split_once('/') else { return Err("Invalid remote branch name".into()); };
            if short.is_empty() || short.starts_with('-') { return Err("Invalid remote branch name".into()); }
            let out = Command::new("git").args(["switch", "-c", short, "--track", name]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
            if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
            return Ok(());
        }
        let out = Command::new("git").args(["checkout", name]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        Ok(())
    }
}

/** Derive a safe folder name from a repository URL (last path segment, minus .git).
 *  Rejects empty/traversal names ("", ".", "..", "/", "\\"). */
fn clone_name(url: &str) -> Option<String> {
    let name = url.trim_end_matches('/').rsplit('/').next()?.to_string();
    let name = name.strip_suffix(".git").unwrap_or(&name).to_string();
    if name.is_empty() || name == "." || name.contains("..") || name.contains('/') || name.contains('\\') { None } else { Some(name) }
}

impl Git {
/** Initialize a git repository in the vault folder (git init). */
    pub fn init(&self) -> Result<(), String> {
        let out = Command::new("git").arg("init").current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        Ok(())
    }
/** List configured remotes as (name, url) pairs (git remote -v, deduped). */
    pub fn remotes(&self) -> Result<Vec<(String, String)>, String> {
        let out = Command::new("git").args(["remote", "-v"]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        let mut v: Vec<(String, String)> = Vec::new();
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 && !v.iter().any(|(n, u)| n == parts[0] && u == parts[1]) {
                v.push((parts[0].to_string(), parts[1].to_string()));
            }
        }
        Ok(v)
    }
/** Add a remote (git remote add <name> <url>). URL validated as remote-only (no local paths). */
    pub fn add_remote(&self, name: &str, url: &str) -> Result<(), String> {
        if name.is_empty() || name.contains('/') || name.contains(' ') || name == "." || name.contains("..") {
            return Err("Invalid remote name".into());
        }
        if !is_remote_url(url) {
            return Err("Invalid remote URL — use https://, git@host:path, ssh://, or git://".into());
        }
        let out = Command::new("git").args(["remote", "add", name, url]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        Ok(())
    }
/** Remove a remote. */
    pub fn remove_remote(&self, name: &str) -> Result<(), String> {
        let out = Command::new("git").args(["remote", "remove", name]).current_dir(&self.repo_path).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
        Ok(())
    }
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
/** Clone a remote repository into `parent/<name>` (name derived from URL).
 *  Returns the cloned directory path. Safe: URL passed as argv (no shell injection),
 *  folder name validated against traversal. Only remote sources are accepted
 *  (https/http/ssh/git schemes or scp-like [user@]host:path); local paths are
 *  rejected — "Open Folder" covers those. Falls back to the system git binary,
 *  so existing vaults / credentials (SSH key, keychain credential helper) work unchanged. */
    pub fn clone_repo(url: &str, parent: &str) -> Result<String, String> {
        let url = url.trim();
        if !is_remote_url(url) {
            return Err("Invalid repository URL — use https://, git@host:path, ssh://, or git:// (local paths are not supported; use Open Folder instead)".into());
        }
        let name = clone_name(url).ok_or_else(|| format!("Invalid repository URL: cannot derive folder name from \"{url}\""))?;
        let dest = std::path::Path::new(parent).join(&name);
        if dest.exists() {
            return Err(format!("Folder \"{}\" already exists — pick another URL or parent folder", dest.display()));
        }
        let out = Command::new("git")
            .args(["clone", url, dest.to_str().ok_or("Invalid path")?])
            .output()
            .map_err(|e| format!("git binary not found: {}", e))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(dest.to_string_lossy().to_string())
    }
}

/** True if the URL is a remote repository source: a scheme:// URL (except file://)
 *  or an scp-like [user@]host:path form. Local paths (/…, ~/…, ./…, plain name)
 *  are rejected. */
fn is_remote_url(url: &str) -> bool {
    if url.is_empty() { return false; }
    if url.contains("://") { return !url.starts_with("file://"); }
    // scp-like: [user@]host:path — no spaces, host has no '/' , path non-empty
    let Some((host, path)) = url.split_once(':') else { return false };
    let host = host.rsplit_once('@').map(|(_, h)| h).unwrap_or(host);
    !host.is_empty() && !host.contains('/') && !path.is_empty()
}

/** Parse `git status --porcelain=v2 -b` output into branch + v1-style lines +
 *  ahead/behind. Pure (no git calls) so it is unit-testable offline. */
fn parse_porcelain_v2(text: &str) -> WorktreeStatus {
    let mut branch = String::new();
    let mut upstream = String::new();
    let mut ahead = 0usize;
    let mut behind = 0usize;
    let mut lines: Vec<String> = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            branch = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // e.g. "# branch.ab +2 -1" — signs included
            let mut it = rest.split_whitespace();
            if let Some(a) = it.next() { ahead = a.trim_start_matches('+').parse().unwrap_or(0) }
            if let Some(b) = it.next() { behind = b.trim_start_matches('-').parse().unwrap_or(0) }
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            upstream = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("1 ") {
            // v2: 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path> → v1: XY path
            let mut it = rest.split_whitespace();
            if let (Some(xy), Some(path)) = (it.next(), it.last()) {
                lines.push(format!("{xy} {path}"));
            }
        } else if let Some(rest) = line.strip_prefix("? ") {
            lines.push(format!("? {}", rest.trim()));
        }
    }
    WorktreeStatus { branch, upstream, status: lines.join("\n"), ahead, behind }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clone_name_derives_from_url() {
        assert_eq!(clone_name("https://github.com/user/repo.git").as_deref(), Some("repo"));
        assert_eq!(clone_name("https://github.com/user/repo").as_deref(), Some("repo"));
        assert_eq!(clone_name("git@github.com:user/repo.git").as_deref(), Some("repo"));
        assert_eq!(clone_name("ssh://git@host:22/path/repo").as_deref(), Some("repo"));
        assert_eq!(clone_name("https://host/a/b/").as_deref(), Some("b"));
    }

    #[test]
    fn clone_name_rejects_traversal() {
        assert_eq!(clone_name("https://host/.."), None);
        assert_eq!(clone_name("https://host/."), None);
        assert_eq!(clone_name(""), None);
        // bare-host URL derives a safe folder name; git itself will fail the clone
        assert_eq!(clone_name("https://host/").as_deref(), Some("host"));
    }

    #[test]
    fn init_creates_a_repo() {
        // Unique dir per invocation — a stable {pid} suffix would collide across
        // parallel cargo-test threads if any second test reuses this pattern.
        let dir = std::env::temp_dir().join(format!(
            "docubook-test-init-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let g = Git::open(dir.to_str().unwrap());
        assert!(!g.is_repo());
        g.init().unwrap();
        assert!(g.is_repo());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_settings_validation_without_repo() {
        // add_remote validation runs before any git call — testable without a repo
        let g = Git::open("/nonexistent");
        assert!(g.add_remote("bad name", "https://x/y.git").is_err());
        assert!(g.add_remote("../evil", "https://x/y.git").is_err());
        assert!(g.add_remote("origin", "/tmp/local").is_err());
        assert!(g.add_remote("origin", "file:///tmp/x").is_err());
        assert!(g.set_identity("", "a@b.c").is_err());
        assert!(g.set_identity("N", "").is_err());
    }

    #[test]
    fn clone_repo_validates_url_without_network() {
        assert!(Git::clone_repo("", "/tmp").is_err());
        assert!(Git::clone_repo("file:///etc", "/tmp").is_err());
        assert!(Git::clone_repo("https://host/..", "/tmp").is_err());
        // local paths are rejected (use Open Folder instead)
        assert!(Git::clone_repo("/tmp/foo", "/tmp").is_err());
        assert!(Git::clone_repo("~/repo", "/tmp").is_err());
        assert!(Git::clone_repo("./repo", "/tmp").is_err());
        assert!(Git::clone_repo("repo", "/tmp").is_err());
        // valid remotes still accepted
        assert!(is_remote_url("https://github.com/user/repo.git"));
        assert!(is_remote_url("http://host/repo.git"));
        assert!(is_remote_url("ssh://git@host:22/path/repo"));
        assert!(is_remote_url("git://host/repo"));
        assert!(is_remote_url("git@github.com:user/repo.git"));
        assert!(is_remote_url("host:user/repo"));
        // non-remotes
        assert!(!is_remote_url(""));
        assert!(!is_remote_url("file:///tmp/x"));
        assert!(!is_remote_url("/tmp/x"));
        assert!(!is_remote_url("~/x"));
        assert!(!is_remote_url("./x"));
        assert!(!is_remote_url("plainname"));
    }

    /** Unique temp dir per invocation — a stable {pid} suffix would collide across
     *  parallel cargo-test threads if any second test reuses this pattern. */
    fn temp_git_repo(tag: &str) -> std::path::PathBuf {
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

    #[test]
    fn parse_porcelain_v2_summary() {
        let ws = parse_porcelain_v2(
            "# branch.oid aabbcc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 M. N... 100644 100644 100644 a b src/a.md\n? untracked.md",
        );
        assert_eq!(ws.branch, "main");
        assert_eq!(ws.upstream, "origin/main");
        assert_eq!((ws.ahead, ws.behind), (2, 1));
        assert_eq!(ws.status, "M. src/a.md\n? untracked.md");
    }

    #[test]
    fn parse_porcelain_v2_no_upstream_defaults_to_zero() {
        // Detached HEAD / no upstream → no branch.ab line → 0/0, so push
        // correctly reports "Nothing to push" instead of a doomed push.
        let ws = parse_porcelain_v2("# branch.oid abc\n# branch.head (HEAD detached at abc)");
        assert!(ws.status.is_empty());
        assert!(ws.upstream.is_empty());
        assert_eq!((ws.ahead, ws.behind), (0, 0));
    }

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
    fn stage_path_stages_only_that_file() {
        let dir = temp_git_repo("stage-path");
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        std::fs::write(dir.join("a.md"), "a").unwrap();
        std::fs::write(dir.join("b.md"), "b").unwrap();
        g.stage_path("a.md").unwrap();
        let ws = g.status_with_branch().unwrap();
        // XY pair "A." = staged add, worktree unchanged; b.md is only
        // reported as untracked ("? b.md") — never staged.
        assert!(ws.status.contains("A. a.md"));
        assert!(ws.status.contains("? b.md"));
        assert!(!ws.status.contains("A. b.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn push_checked_nothing_to_push_without_remote() {
        let dir = temp_git_repo("push-checked");
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        // No commits yet → "Nothing to push" (never attempts a doomed -u push).
        let r = g.push_checked();
        assert!(r.success);
        assert_eq!(r.message, "Nothing to push");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn branches_list_and_checkout() {
        let dir = temp_git_repo("branches");
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        g.set_identity("T", "t@e.c").unwrap();
        std::fs::write(dir.join("a.md"), "a").unwrap();
        g.add_all().unwrap();
        g.commit("first").unwrap();
        let names = |g: &Git| g.branches().unwrap().into_iter().map(|b| (b.name, b.remote)).collect::<Vec<_>>();
        let base = names(&g);
        assert_eq!(base.len(), 1);
        Command::new("git").args(["switch", "-c", "dev"]).current_dir(&dir).output().unwrap();
        let bs = names(&g);
        assert!(bs.contains(&("dev".to_string(), false)));
        assert_eq!(bs.len(), 2);
        g.checkout_branch(base[0].0.as_str(), false).unwrap();
        assert!(names(&g).contains(&("dev".to_string(), false)));
        // flag injection and empty names are rejected before reaching git
        assert!(g.checkout_branch("", false).is_err());
        assert!(g.checkout_branch("-x", false).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn branches_include_remote_refs_and_switch_creates_tracking() {
        let dir = temp_git_repo("branches-remote");
        let g = Git::open(dir.to_str().unwrap());
        g.init().unwrap();
        g.set_identity("T", "t@e.c").unwrap();
        std::fs::write(dir.join("a.md"), "a").unwrap();
        g.add_all().unwrap();
        g.commit("first").unwrap();
        // Simulate a fetched remote without network: configured remote + ref
        g.add_remote("origin", "https://example.invalid/repo.git").unwrap();
        Command::new("git").args(["update-ref", "refs/remotes/origin/feat", "HEAD"]).current_dir(&dir).output().unwrap();
        let names = g.branches().unwrap();
        assert!(names.contains(&BranchRef { name: "origin/feat".into(), remote: true }));
        // Checking out the remote ref creates a local tracking branch "feat"
        g.checkout_branch("origin/feat", true).unwrap();
        let state = g.status_with_branch().unwrap();
        assert_eq!(state.branch, "feat");
        // Malformed remote names are rejected
        assert!(g.checkout_branch("origin", true).is_err());
        assert!(g.checkout_branch("origin/-x", true).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
