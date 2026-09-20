use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};

pub mod mentions;

#[derive(Debug, Clone, Serialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub file_type: String, // "0"=file, "1"=dir
}

pub(crate) fn is_ignored_entry(name: &str) -> bool {
    matches!(name, ".git" | ".DS_Store" | "node_modules" | ".trash")
}

/// Content version of a file: the FNV-1a 64-bit hash of its exact bytes.
///
/// This is the optimistic-concurrency token for edits. A writer sends the hash
/// it was based on; the vault refuses the write if the file on disk no longer
/// matches. It is deliberately NOT a security primitive — collisions only mean
/// a missed conflict, never a corrupt write, and it must be identical for equal
/// content so the frontend can compare hashes across reloads.
///
/// Dependency-free on purpose: this crate already ships `sha2`-free and adding
/// a hashing crate for change detection is not worth the compile time.
pub fn content_version(content: &[u8]) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET;
    for byte in content {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

/// Result of an optimistic write attempt.
///
/// `Written` means the guard matched (or was not requested) and disk now holds
/// the new content. `Conflict` means someone else changed the file since the
/// caller read it: the write was *rejected*, and the caller gets both sides so
/// it can present a choice instead of silently clobbering a teammate's edit.
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictReason {
    VersionMismatch,
    TargetExists,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WriteOutcome {
    Written { version: String },
    Conflict { disk: String, version: String, reason: ConflictReason },
}

#[derive(Clone, Copy)]
pub enum WalkKind { Markdown, Renderable, All }

#[derive(Debug, Clone, Serialize)]
pub struct TrashEntry {
    pub name: String,      // stable entry ID; `.trash` name on web, Finder URL on macOS
    pub original: String,  // original vault-relative path, or Finder display name
    pub deleted_at: u64,   // unix millis when available
    pub is_dir: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct TrashMetadata {
    original: String,
    deleted_at: u64,
}

/// Filesystem-based vault that wraps a directory path.
#[derive(Debug)]
pub struct Vault {
    root: PathBuf,
    /// Cache: dir → whether its subtree contains any renderable file.
    /// Built lazily on the first lookup and dropped by mutations, so opening a
    /// vault does not pay for a walk nobody (currently) reads.
    renderable: RefCell<Option<HashMap<PathBuf, bool>>>,
    /// Cache: every markdown file, in walk order. Search runs it on each
    /// keystroke and the wiki index scans it at open, so re-walking per call is
    /// the difference between a few ms and a few hundred on a large vault.
    markdown: RefCell<Option<Arc<Vec<String>>>>,
    checked_write_lock: Mutex<()>,
}

impl Vault {
/** Create a new vault from a directory path. */
    pub fn new(path: &str) -> Result<Self, String> {
        let root = PathBuf::from(path);
        if !root.is_dir() { return Err(format!("Not a directory: {}", path)); }
        Ok(Self { root, renderable: RefCell::new(None), markdown: RefCell::new(None), checked_write_lock: Mutex::new(()) })
    }
/** Get the vault root path. Used by both crates: file serving and the wiki
     *  index reads. */
    pub fn root(&self) -> &Path { &self.root }
/** Get the vault directory name. */
    pub fn name(&self) -> String {
        self.root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
    }
/** Walk a directory and return sorted file list (dirs first, alphabetical). */
/** Resolve a vault-relative path safely.
 *  Rejects absolute paths and any path that resolves (after symlink resolution
 *  and `..` normalization) outside the vault root. Targets that do not exist
 *  yet are checked via their deepest existing ancestor, so create/write flows
 *  stay safe too. */
    fn safe_path(&self, path: &str) -> Result<PathBuf, String> {
        let p = Path::new(path);
        if p.is_absolute() {
            return Err("Path traversal blocked".to_string());
        }
        let root = self.root.canonicalize().map_err(|e| format!("Vault root: {}", e))?;
        let joined = self.root.join(path);
        // canonicalize the deepest EXISTING ancestor (resolves symlinks),
        // then re-append the non-existent tail so new files are checked too
        let mut existing = joined.as_path();
        let mut suffix: Vec<std::ffi::OsString> = Vec::new();
        while !existing.exists() {
            match (existing.parent(), existing.file_name()) {
                (Some(parent), Some(name)) => { suffix.push(name.to_os_string()); existing = parent; }
                _ => break,
            }
        }
        let mut resolved = existing.canonicalize().map_err(|e| format!("Path: {}", e))?;
        for s in suffix.iter().rev() { resolved.push(s); }
        if !resolved.starts_with(&root) {
            return Err("Path traversal blocked".to_string());
        }
        Ok(joined)
    }

    /// Extensions shown in the tree: markdown (editable) + images (previewable).
    /// Everything else (pdf/audio/zip/…) is skipped — no way to open them yet.
    fn is_renderable(name: &str) -> bool {
        if crate::markdown::is_markdown_name(name) { return true; }
        let lower = name.to_ascii_lowercase();
        [".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".bmp", ".avif"]
            .iter().any(|e| lower.ends_with(e))
    }

    /// True if the subtree at `dir` contains at least one renderable file
    /// (recursive, skipping hidden/system dirs). Drives folder visibility.
    /// Builds the map on first use — O(1) after that.
    #[allow(dead_code)]
    fn dir_has_renderable(&self, dir: &Path) -> bool {
        if self.renderable.borrow().is_none() {
            let map = self.build_renderable_cache();
            *self.renderable.borrow_mut() = Some(map);
        }
        self.renderable.borrow().as_ref().and_then(|m| m.get(dir).copied()).unwrap_or(false)
    }

    /// Build the `dir → has_renderable` map bottom-up in one shared walk.
    fn build_renderable_cache(&self) -> HashMap<PathBuf, bool> {
        let mut map: HashMap<PathBuf, bool> = HashMap::new();
        for rel in self.walk("", WalkKind::Renderable) {
            let mut dir = self.root.join(rel).parent().map(Path::to_path_buf);
            while let Some(path) = dir {
                if !path.starts_with(&self.root) { break; }
                map.insert(path.clone(), true);
                if path == self.root { break; }
                dir = path.parent().map(Path::to_path_buf);
            }
        }
        map
    }

    /// Drop the caches after filesystem mutations so the next lookup rebuilds.
    fn invalidate_caches(&self) {
        *self.renderable.borrow_mut() = None;
        *self.markdown.borrow_mut() = None;
    }

    /// Enumerate files recursively beneath a vault-relative directory.
    /// Results are relative to the vault root and sorted lexically.
    pub fn walk(&self, subpath: &str, kind: WalkKind) -> Vec<String> {
        let Ok(base) = self.safe_path(subpath) else { return vec![] };
        let mut paths = Vec::new();
        let mut stack = vec![base];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            let mut entries: Vec<_> = entries.flatten().collect();
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries.into_iter().rev() {
                let name = entry.file_name().to_string_lossy().to_string();
                if is_ignored_entry(&name) { continue; }
                let path = entry.path();
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    stack.push(path);
                } else if match kind {
                    WalkKind::Markdown => crate::markdown::is_markdown_name(&name),
                    WalkKind::Renderable => Self::is_renderable(&name),
                    WalkKind::All => true,
                } {
                    if let Ok(rel) = path.strip_prefix(&self.root) { paths.push(rel.to_string_lossy().to_string()); }
                }
            }
        }
        paths.sort();
        paths
    }

    /** Cached markdown file list (same order as `walk("", Markdown)`). Shared
     *  through `Arc` so callers — search per keystroke, the wiki index at open —
     *  never copy it or re-walk the vault. */
    pub(crate) fn markdown_files(&self) -> Arc<Vec<String>> {
        if let Some(cached) = self.markdown.borrow().as_ref() { return cached.clone(); }
        let files = Arc::new(self.walk("", WalkKind::Markdown));
        *self.markdown.borrow_mut() = Some(files.clone());
        files
    }

    /// Resolve an exact vault path, then an extension-less Markdown path.
    pub fn resolve_directory(&self, token: &str) -> Option<String> {
        let path = self.safe_path(token).ok()?;
        path.is_dir().then(|| token.to_string())
    }

    pub fn resolve_target(&self, token: &str) -> Option<String> {
        let exact = self.safe_path(token).ok()?;
        if exact.is_file() { return Some(token.to_string()); }
        if Path::new(token).extension().is_none() {
            for ext in ["md", "mdx"] {
                let candidate = format!("{token}.{ext}");
                if self.safe_path(&candidate).ok()?.is_file() { return Some(candidate); }
            }
        }
        None
    }

    pub fn tree(&self, subpath: &str) -> Vec<FileInfo> {
        let dir = match self.safe_path(subpath) { Ok(d) => d, Err(_) => return vec![] };
        let mut dirs = vec![]; let mut files = vec![];
        if let Ok(read) = std::fs::read_dir(&dir) {
            for e in read.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if is_ignored_entry(&name) { continue; }
                let rel = if subpath.is_empty() { name.clone() } else { format!("{}/{}", subpath, name) };
                let ft = if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { "1" } else { "0" };
                // Show markdown (editable) + images (previewable) in the tree;
                // folders with nothing renderable are hidden.
                if ft == "0" && !Self::is_renderable(&name) { continue; }
                let info = FileInfo { path: rel, name, file_type: ft.to_string() };
                if ft == "1" { dirs.push(info) } else { files.push(info) }
            }
        }
        dirs.sort_by_key(|a| a.name.to_lowercase());
        files.sort_by_key(|a| a.name.to_lowercase());
        [dirs, files].concat()
    }
    /** Bounded byte read for an index-owned path. `pub(crate)` so the wiki index
     *  can read `Vault::walk` output without holding the vault lock. */
    pub(crate) fn read_limited(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
        let file = std::fs::File::open(path).map_err(|e| format!("Read: {}", e))?;
        let mut data = Vec::new();
        file.take(max_bytes.saturating_add(1))
            .read_to_end(&mut data)
            .map_err(|e| format!("Read: {}", e))?;
        if data.len() as u64 > max_bytes {
            return Err("Read: file too large".to_string());
        }
        Ok(data)
    }

/** Read file content as UTF-8 string for desktop IPC callers. */
    #[allow(dead_code)] // unused by the web server crate, retained for desktop IPC
    pub fn read_file(&self, path: &str) -> Result<String, String> {
        let target = self.resolve_target(path).ok_or_else(|| format!("Read: not found: {path}"))?;
        let data = std::fs::read(self.safe_path(&target)?).map_err(|e| format!("Read: {e}"))?;
        Ok(String::from_utf8_lossy(&data).to_string())
    }

/** Read UTF-8 content with a bounded allocation for web/API callers. */
    #[allow(dead_code)] // used by the web server crate for bounded API reads
    pub fn read_file_limited(&self, path: &str, max_bytes: u64) -> Result<String, String> {
        self.read_bounded(path, max_bytes)
    }

    /// Read UTF-8 text with a byte limit; extension-less paths complete to .md/.mdx.
    pub fn read_bounded(&self, path: &str, max_bytes: u64) -> Result<String, String> {
        let target = self.resolve_target(path).ok_or_else(|| format!("Read: not found: {path}"))?;
        let data = Self::read_limited(&self.safe_path(&target)?, max_bytes)?;
        Ok(String::from_utf8_lossy(&data).to_string())
    }
/** Read a binary file as base64 (images etc). Same path-traversal protection
 *  as read_file; used for previews where the raw bytes must round-trip intact. */
    #[allow(dead_code)] // wired only in the desktop crate (web serves via /api/file)
    pub fn read_file_binary(&self, path: &str) -> Result<String, String> {
        use base64::Engine;
        let f = self.safe_path(path)?;
        let data = std::fs::read(&f).map_err(|e| format!("Read: {}", e))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(data))
    }
/** Write content to a file, creating parent directories if needed. */
    pub fn write_file(&self, path: &str, content: &str) -> Result<(), String> {
        let f = self.safe_path(path)?;
        if let Some(p) = f.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
        std::fs::write(&f, content).map_err(|e| e.to_string())?;
        self.invalidate_caches();
        Ok(())
    }

/// Content version of a file on disk, or `None` when it does not exist.
    /// Callers hold this token between read and write so an edit can be rejected
    /// rather than silently overwriting an external change.
    pub fn version_of(&self, path: &str) -> Result<Option<String>, String> {
        let target = match self.resolve_target(path) {
            Some(t) => t,
            None => return Ok(None),
        };
        let f = self.safe_path(&target)?;
        match std::fs::read(&f) {
            Ok(bytes) => Ok(Some(content_version(&bytes))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("Read: {e}")),
        }
    }

/// Write only if the file still matches `base_version` (optimistic concurrency).
    ///
    /// `base_version` semantics:
    /// - `None` — caller believes the file does not exist yet; the write fails with
    ///   a conflict if something appeared in the meantime.
    /// - `Some(token)` — the write fails if disk content hashes to anything else.
    ///
    /// The window between the check and the write is not atomic across processes;
    /// this is a best-effort guard against the *common* case (external editor, git
    /// checkout, another device) rather than a lock. Callers that need hard
    /// serialization should hold a vault-level lock instead.
    pub fn write_file_checked(
        &self,
        path: &str,
        content: &str,
        base_version: Option<&str>,
    ) -> Result<WriteOutcome, String> {
        let _write_guard = self.checked_write_lock.lock().map_err(|_| "Write lock poisoned".to_string())?;
        let existed = self.resolve_target(path);
        match base_version {
            Some(expected) => {
                let actual = match existed {
                    Some(target) => {
                        let bytes = std::fs::read(self.safe_path(&target)?)
                            .map_err(|e| format!("Read: {e}"))?;
                        Some((content_version(&bytes), String::from_utf8_lossy(&bytes).to_string()))
                    }
                    None => None,
                };
                match actual {
                    Some((version, _disk)) if version == expected => {}
                    Some((version, disk)) => {
                        return Ok(WriteOutcome::Conflict { disk, version, reason: ConflictReason::VersionMismatch });
                    }
                    // The caller based its edit on a file that has since vanished;
                    // recreating it silently would resurrect a deleted note.
                    None => {
                        return Ok(WriteOutcome::Conflict { disk: String::new(), version: String::new(), reason: ConflictReason::VersionMismatch });
                    }
                }
            }
            // No baseline: only proceed while the target still does not exist.
            None => {
                if let Some(target) = existed {
                    let bytes = std::fs::read(self.safe_path(&target)?)
                        .map_err(|e| format!("Read: {e}"))?;
                    return Ok(WriteOutcome::Conflict {
                        disk: String::from_utf8_lossy(&bytes).to_string(),
                        version: content_version(&bytes),
                        reason: ConflictReason::TargetExists,
                    });
                }
            }
        }
        self.write_file(path, content)?;
        Ok(WriteOutcome::Written { version: content_version(content.as_bytes()) })
    }
/** Create an empty file, creating parent directories if needed. */
    pub fn create_file(&self, path: &str) -> Result<String, String> {
        let f = self.safe_path(path)?;
        if let Some(p) = f.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
        if !f.exists() { std::fs::write(&f, "").map_err(|e| e.to_string())?; }
        self.invalidate_caches();
        Ok(path.to_string())
    }

/** Create an empty directory (and parents). */
    pub fn create_directory(&self, path: &str) -> Result<(), String> {
        std::fs::create_dir_all(self.safe_path(path)?).map_err(|e| format!("Create dir: {}", e))?;
        self.invalidate_caches();
        Ok(())
    }

/** Move to trash. macOS uses Finder's system Trash; web/Docker and other
 *  platforms use `.trash/` inside the vault so list/restore remain available. */
    pub fn delete_file(&self, path: &str) -> Result<(), String> {
        if path.is_empty() || path == "." || path == ".trash" || path.starts_with(".trash/") {
            return Err("Invalid trash target".to_string());
        }
        let f = self.safe_path(path)?;
        #[cfg(not(target_os = "macos"))]
        {
            let trash_dir = self.safe_path(".trash")?;
            let metadata_dir = self.safe_path(".trash/.metadata")?;
            std::fs::create_dir_all(&metadata_dir).map_err(|e| e.to_string())?;
            let name = f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let mut ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            let (trash_name, dst) = loop {
                let trash_name = format!("{ts}-{name}");
                let dst = trash_dir.join(&trash_name);
                if !dst.exists() { break (trash_name, dst); }
                ts += 1;
            };
            let metadata_path = metadata_dir.join(format!("{trash_name}.json"));
            let metadata = serde_json::to_vec(&TrashMetadata { original: path.to_string(), deleted_at: ts }).map_err(|e| e.to_string())?;
            std::fs::write(&metadata_path, metadata).map_err(|e| format!("Trash metadata: {e}"))?;
            if let Err(error) = std::fs::rename(&f, &dst) {
                let _ = std::fs::remove_file(metadata_path);
                return Err(format!("Trash: {error}"));
            }
        }
        #[cfg(target_os = "macos")]
        {
            trash::delete(&f).map_err(|e| format!("Trash: {}", e))?;
        }
        self.invalidate_caches();
        Ok(())
    }

/** Resolve a `.trash/` entry safely, including symlink containment. */
    #[allow(dead_code)]
    fn trash_path(&self, name: &str) -> Result<PathBuf, String> {
        if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
            return Err("Invalid trash entry".to_string());
        }
        self.safe_path(&format!(".trash/{name}"))
    }

    fn trash_metadata_path(&self, name: &str) -> Result<PathBuf, String> {
        let _ = self.trash_path(name)?;
        self.safe_path(&format!(".trash/.metadata/{name}.json"))
    }

/** List vault-local deleted items, newest first. */
    #[allow(dead_code)]
    pub fn list_trash(&self) -> Vec<TrashEntry> {
        let mut entries = Vec::new();
        let trash_dir = match self.safe_path(".trash") { Ok(path) => path, Err(_) => return entries };
        if let Ok(read) = std::fs::read_dir(trash_dir) {
            for e in read.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name == ".metadata" { continue; }
                let (ts, fallback_original): (String, String) = match name.split_once('-') {
                    Some((t, o)) if !t.is_empty() && t.chars().all(|c| c.is_ascii_digit()) => (t.to_string(), o.to_string()),
                    _ => (String::new(), name.clone()),
                };
                let metadata = self.trash_metadata_path(&name).ok()
                    .and_then(|path| std::fs::read(path).ok())
                    .and_then(|data| serde_json::from_slice::<TrashMetadata>(&data).ok());
                entries.push(TrashEntry {
                    name,
                    original: metadata.as_ref().map(|value| value.original.clone()).unwrap_or(fallback_original),
                    deleted_at: metadata.map(|value| value.deleted_at).unwrap_or_else(|| ts.parse().unwrap_or(0)),
                    is_dir: e.file_type().map(|kind| kind.is_dir()).unwrap_or(false),
                });
            }
        }
        entries.sort_by_key(|e| std::cmp::Reverse(e.deleted_at));
        entries
    }

/** Restore a vault-local trash entry to the vault root. */
    #[allow(dead_code)]
    pub fn restore_file(&self, trash_name: &str) -> Result<(), String> {
        let src = self.trash_path(trash_name)?;
        let metadata_path = self.trash_metadata_path(trash_name)?;
        let fallback = trash_name.split_once('-').map(|(_, original)| original.to_string()).unwrap_or_else(|| trash_name.to_string());
        let original = std::fs::read(&metadata_path).ok()
            .and_then(|data| serde_json::from_slice::<TrashMetadata>(&data).ok())
            .map(|metadata| metadata.original)
            .unwrap_or(fallback);
        let dst = self.safe_path(&original)?;
        if dst.exists() { return Err(format!("A file named \"{original}\" already exists")); }
        if let Some(parent) = dst.parent() { std::fs::create_dir_all(parent).map_err(|e| format!("Restore: {e}"))?; }
        std::fs::rename(&src, &dst).map_err(|e| format!("Restore: {}", e))?;
        let _ = std::fs::remove_file(metadata_path);
        self.invalidate_caches();
        Ok(())
    }

    fn remove_trash_path(path: &Path) -> Result<(), String> {
        let kind = std::fs::symlink_metadata(path).map_err(|e| format!("Delete permanently: {e}"))?.file_type();
        if kind.is_dir() {
            std::fs::remove_dir_all(path).map_err(|e| format!("Delete permanently: {e}"))
        } else {
            std::fs::remove_file(path).map_err(|e| format!("Delete permanently: {e}"))
        }
    }

/** Permanently delete one vault-local trash entry. */
    #[allow(dead_code)]
    pub fn delete_trash_item(&self, trash_name: &str) -> Result<(), String> {
        Self::remove_trash_path(&self.trash_path(trash_name)?)?;
        let _ = std::fs::remove_file(self.trash_metadata_path(trash_name)?);
        self.invalidate_caches();
        Ok(())
    }

/** Rename/move a file or directory. */
    pub fn rename_file(&self, from: &str, to: &str) -> Result<(), String> {
        let src = self.safe_path(from)?;
        let dst = self.safe_path(to)?;
        if let Some(p) = dst.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
        std::fs::rename(&src, &dst).map_err(|e| format!("Rename: {}", e))?;
        self.invalidate_caches();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_name_from_directory() {
        let v = Vault { root: PathBuf::from("/some/path/my-vault"), renderable: RefCell::new(None), markdown: RefCell::new(None), checked_write_lock: Mutex::new(()) };
        assert_eq!(v.name(), "my-vault");
    }

    #[test]
    fn vault_name_root() {
        // root's file_name is None on some platforms, empty on others
        let v = Vault { root: PathBuf::from("/"), renderable: RefCell::new(None), markdown: RefCell::new(None), checked_write_lock: Mutex::new(()) };
        assert_eq!(v.name(), "");
    }

    #[test]
    fn safe_path_rejects_escape_and_accepts_legit() {
        let dir = std::env::temp_dir().join(format!("docubook-sec-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("notes.md"), "x").unwrap();
        std::fs::create_dir(dir.join("folder")).unwrap();
        std::os::unix::fs::symlink("/etc", dir.join("link")).unwrap();

        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        // traversal: absolute, .. escapes, nested ..
        assert!(v.safe_path("/etc/passwd").is_err());
        assert!(v.safe_path("../../etc/passwd").is_err());
        assert!(v.safe_path("a/../../b").is_err());
        // symlink escape
        assert!(v.safe_path("link/passwd").is_err());
        // legit paths (existing + not-yet-existing target)
        assert!(v.safe_path("notes.md").is_ok());
        assert!(v.safe_path("folder/sub.md").is_ok());
        assert!(v.safe_path("newfile.md").is_ok());
        // "./" prefix (GFM-relative links like ![x](./img.png)) resolves fine
        assert!(v.safe_path("./folder/sub.md").is_ok());
        assert!(v.safe_path("./notes.md").is_ok());
        // filename containing ".." is not a traversal component
        assert!(v.safe_path("a..b.md").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tree_file_sort_order() {
        let dir = std::env::temp_dir().join("vault-test-sort");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("b.md"), "").unwrap();
        std::fs::write(dir.join("a.md"), "").unwrap();
        std::fs::create_dir(dir.join("z-dir")).unwrap();
        std::fs::create_dir(dir.join("a-dir")).unwrap();
        std::fs::write(dir.join("z-dir/note.md"), "").unwrap();
        std::fs::write(dir.join("a-dir/note.md"), "").unwrap();

        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        let tree = v.tree("");
        // dirs first, alphabetical
        assert_eq!(tree[0].name, "a-dir");
        assert_eq!(tree[0].file_type, "1");
        assert_eq!(tree[1].name, "z-dir");
        assert_eq!(tree[1].file_type, "1");
        // then files
        assert_eq!(tree[2].name, "a.md");
        assert_eq!(tree[2].file_type, "0");
        assert_eq!(tree[3].name, "b.md");
        assert_eq!(tree[3].file_type, "0");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tree_shows_empty_folders_and_renderable_files() {
        let dir = std::env::temp_dir().join("vault-test-hide-nomd");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::create_dir_all(dir.join("docs/inner")).unwrap();
        std::fs::write(dir.join("assets/logo.png"), "x").unwrap();
        std::fs::write(dir.join("docs/readme.md"), "").unwrap();
        std::fs::write(dir.join("docs/inner/no-md.txt"), "x").unwrap();

        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        let tree = v.tree("");
        // All non-ignored folders stay visible, including folders with no
        // renderable files, matching normal file-tree behavior.
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].name, "assets");
        assert_eq!(tree[1].name, "docs");
        let docs = v.tree("docs");
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0].name, "inner");
        assert_eq!(docs[1].name, "readme.md");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn renderable_cache_invalidates_after_create() {
        let dir = std::env::temp_dir().join("vault-test-cache-invalidate");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("empty")).unwrap();
        std::fs::write(dir.join("a.md"), "").unwrap();

        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        // Empty folders remain visible before and after file creation.
        assert_eq!(v.tree("").len(), 2);
        assert_eq!(v.tree("")[0].name, "empty");

        // create a renderable file inside empty/ → cache must refresh
        v.create_file("empty/note.md").unwrap();
        let tree = v.tree("");
        assert_eq!(tree.len(), 2, "empty/ harus muncul setelah ada .md");
        let names: Vec<&str> = tree.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"empty"), "tree: {:?}", names);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn markdown_list_cache_invalidates_after_mutation() {
        let dir = std::env::temp_dir().join("vault-test-markdown-cache");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "").unwrap();
        std::fs::write(dir.join("b.mdx"), "").unwrap();

        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        assert_eq!(*v.markdown_files(), vec!["a.md".to_string(), "b.mdx".to_string()]);

        // Create + rename must drop the cached list: search reads it on every
        // keystroke and the wiki index scans it after each save, so a stale list
        // would keep offering paths that no longer exist.
        v.create_file("c.md").unwrap();
        assert_eq!(v.markdown_files().len(), 3);
        v.rename_file("c.md", "notes/d.md").unwrap();
        assert!(v.markdown_files().iter().any(|p| p == "notes/d.md"), "{:?}", v.markdown_files());
        assert!(!v.markdown_files().iter().any(|p| p == "c.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tree_skips_hidden_and_trash_dirs() {
        let dir = std::env::temp_dir().join("vault-test-trash-skip");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".trash")).unwrap();
        std::fs::write(dir.join(".trash/old.md"), "").unwrap();
        std::fs::create_dir(dir.join(".git")).unwrap();
        std::fs::write(dir.join("notes.md"), "").unwrap();

        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        let tree = v.tree("");
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].name, "notes.md");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn delete_file_moves_to_vault_trash_on_linux() {
        let dir = std::env::temp_dir().join("vault-test-delete-trash");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("notes.md"), "content").unwrap();
        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        v.delete_file("notes.md").unwrap();
        assert!(!dir.join("notes.md").exists());
        let trash = dir.join(".trash");
        assert!(trash.is_dir());
        let moved: Vec<_> = std::fs::read_dir(&trash).unwrap().flatten()
            .filter(|e| e.file_name().to_string_lossy() != ".metadata")
            .collect();
        assert_eq!(moved.len(), 1);
        assert!(moved[0].file_name().to_string_lossy().ends_with("notes.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn delete_and_restore_preserves_original_folder() {
        let dir = std::env::temp_dir().join("vault-test-trash-original-folder");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("folder")).unwrap();
        std::fs::write(dir.join("folder/notes.md"), "x").unwrap();
        let v = Vault::new(dir.to_str().unwrap()).unwrap();

        v.delete_file("folder/notes.md").unwrap();
        let trash = v.list_trash();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].original, "folder/notes.md");
        v.restore_file(&trash[0].name).unwrap();
        assert!(dir.join("folder/notes.md").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_list_restore_empty_roundtrip() {
        let dir = std::env::temp_dir().join("vault-test-trash-roundtrip");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".trash")).unwrap();
        std::fs::write(dir.join(".trash/1700000000000-notes.md"), "x").unwrap();
        std::fs::write(dir.join(".trash/1700000001000-plan.md"), "y").unwrap();
        let v = Vault::new(dir.to_str().unwrap()).unwrap();

        // list: newest first, prefix stripped into original + deleted_at
        let list = v.list_trash();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].original, "plan.md");
        assert_eq!(list[0].deleted_at, 1700000001000);
        assert_eq!(list[1].original, "notes.md");
        assert_eq!(list[1].deleted_at, 1700000000000);

        // restore: strips prefix, back at vault root
        v.restore_file(&list[0].name).unwrap();
        assert!(dir.join("plan.md").exists());
        assert!(!dir.join(".trash/1700000001000-plan.md").exists());

        // collision: refuse restore when the name exists
        std::fs::write(dir.join("notes.md"), "existing").unwrap();
        assert!(v.restore_file(&list[1].name).is_err());
        std::fs::remove_file(dir.join("notes.md")).unwrap();
        v.restore_file(&list[1].name).unwrap();
        assert!(dir.join("notes.md").exists());

        // per-item permanent delete cannot escape `.trash`
        std::fs::write(dir.join(".trash/1700000002000-old.md"), "z").unwrap();
        v.delete_trash_item("1700000002000-old.md").unwrap();
        assert!(!dir.join(".trash/1700000002000-old.md").exists());
        assert!(v.delete_trash_item("../notes.md").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_file_limited_rejects_content_over_limit() {
        let dir = std::env::temp_dir().join(format!("vault-test-read-limit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("large.md"), "12345").unwrap();
        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        assert_eq!(v.read_file_limited("large.md", 5).unwrap(), "12345");
        assert!(v.read_file_limited("large.md", 4).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_file_falls_back_to_md_for_extensionless_paths() {
        let dir = std::env::temp_dir().join(format!("vault-test-md-fallback-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("roadmap.md"), "# Roadmap").unwrap();
        std::fs::write(dir.join("plan.txt"), "txt").unwrap();
        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        // extension-less → completes to .md
        assert!(v.read_file("roadmap").unwrap().contains("Roadmap"));
        // explicit .md still works, never double-appended
        assert!(v.read_file("roadmap.md").unwrap().contains("Roadmap"));
        // non-.md file without extension is NOT rewritten as .md
        assert!(v.read_file("plan").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn vault_new_rejects_missing_dir() {
        let result = Vault::new("/tmp/nonexistent-12345");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Not a directory"));
    }

    #[test]
    fn content_version_is_stable_and_content_sensitive() {
        // Equal content must hash equal across calls, or every save would look
        // like a conflict; any byte change must hash differently.
        assert_eq!(content_version(b"hello"), content_version(b"hello"));
        assert_ne!(content_version(b"hello"), content_version(b"hello "));
        assert_ne!(content_version(b""), content_version(b"a"));
        // Different lengths sharing a prefix must not collide trivially.
        assert_ne!(content_version(b"ab"), content_version(b"abc"));
    }

    #[test]
    fn checked_write_accepts_matching_baseline_and_rejects_stale_one() {
        let dir = std::env::temp_dir().join(format!("vault-test-checked-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("note.md"), "v1").unwrap();
        let v = Vault::new(dir.to_str().unwrap()).unwrap();

        let base = v.version_of("note.md").unwrap().expect("file exists");

        // A write based on the current version succeeds and advances the version.
        let ok = v.write_file_checked("note.md", "v2", Some(&base)).unwrap();
        let new_version = match ok {
            WriteOutcome::Written { version } => version,
            other => panic!("expected Written, got {other:?}"),
        };
        assert_ne!(new_version, base);
        assert_eq!(v.read_file("note.md").unwrap(), "v2");

        // A write still holding the OLD token must be rejected and must leave
        // the disk untouched — this is what protects a concurrent editor.
        let stale = v.write_file_checked("note.md", "clobber", Some(&base)).unwrap();
        match stale {
            WriteOutcome::Conflict { disk, version, .. } => {
                assert_eq!(disk, "v2");
                assert_eq!(version, new_version);
            }
            other => panic!("expected Conflict, got {other:?}"),
        }
        assert_eq!(v.read_file("note.md").unwrap(), "v2");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn checked_write_without_baseline_refuses_to_clobber_existing_file() {
        let dir = std::env::temp_dir().join(format!("vault-test-nobase-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("taken.md"), "existing").unwrap();
        let v = Vault::new(dir.to_str().unwrap()).unwrap();

        // No baseline means "I believe this file is new" — an existing file is a conflict.
        let conflict = v.write_file_checked("taken.md", "mine", None).unwrap();
        assert!(matches!(conflict, WriteOutcome::Conflict { .. }));
        assert_eq!(v.read_file("taken.md").unwrap(), "existing");

        // Same call for a genuinely new path writes normally.
        let ok = v.write_file_checked("fresh.md", "mine", None).unwrap();
        assert!(matches!(ok, WriteOutcome::Written { .. }));
        assert_eq!(v.read_file("fresh.md").unwrap(), "mine");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn checked_write_conflicts_when_baselined_file_was_deleted() {
        let dir = std::env::temp_dir().join(format!("vault-test-deleted-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("gone.md"), "v1").unwrap();
        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        let base = v.version_of("gone.md").unwrap().unwrap();

        std::fs::remove_file(dir.join("gone.md")).unwrap();

        // Losing the file underneath an open editor must surface as a conflict
        // rather than silently recreating a note someone deleted.
        let conflict = v.write_file_checked("gone.md", "v2", Some(&base)).unwrap();
        assert!(matches!(conflict, WriteOutcome::Conflict { .. }));
        assert!(!dir.join("gone.md").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn version_of_missing_file_is_none() {
        let dir = std::env::temp_dir().join(format!("vault-test-ver-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        assert!(v.version_of("nope.md").unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Cross-runtime parity: the frontend re-implements this hash in TypeScript
    /// (`contentVersion` in `frontend/stores/sync.ts`) so the offline queue can
    /// answer "does disk already hold this?" without a round trip. The two
    /// implementations MUST agree, or every checked write would be rejected as
    /// stale and the editor would report a conflict on every save.
    ///
    /// These expected values were produced by the TypeScript implementation and
    /// are pinned here so any drift on EITHER side fails this test.
    #[test]
    fn cross_runtime_hash_parity() {
        assert_eq!(content_version(b""), "cbf29ce484222325");
        assert_eq!(content_version(b"a"), "af63dc4c8601ec8c");
        assert_eq!(content_version(b"hello"), "a430d84680aabd0b");
        assert_eq!(content_version(b"hello world"), "779a65e7023cd2e7");
        // Multi-byte UTF-8 must hash over bytes, not code points: JS encodes to
        // UTF-8 before hashing, so both sides see the same byte sequence.
        assert_eq!(
            content_version("# Title\n\nbody with émoji 🎉".as_bytes()),
            "92709619a2fcf94b"
        );
    }
}
