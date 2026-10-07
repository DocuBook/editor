use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};

pub mod mentions;

/// Largest file the vault will read into memory in one call. One source of
/// truth shared by the desktop IPC and the web API (`httpm::MAX_FILE_BYTES`
/// aliases it) so the same vault cannot open a file in one runtime and reject
/// it in the other. Kept modest because both paths materialize the whole file:
/// desktop inlines it as a base64 data URL, web sends it as one response body.
pub const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// Vault-relative root of the WYSIWYG snapshot cache. Ignored by tree/walk/
/// search, and kept out of git by a self-ignoring `.gitignore` written inside it.
const SNAPSHOT_ROOT: &str = ".docubook";
/// Directory (under [`SNAPSHOT_ROOT`]) holding one JSON snapshot per document.
const SNAPSHOT_DIR: &str = ".docubook/wysiwyg";

#[derive(Debug, Clone, Serialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub file_type: String, // "0"=file, "1"=dir
}

pub(crate) fn is_ignored_entry(name: &str) -> bool {
    matches!(name, ".git" | ".DS_Store" | "node_modules" | ".trash" | SNAPSHOT_ROOT)
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
    pub fn markdown_files(&self) -> Arc<Vec<String>> {
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

/** Read file content as UTF-8 string for desktop IPC callers. Bounded by
 *  `MAX_FILE_BYTES`, the same cap the web API enforces, so a huge note fails
 *  the same way on both runtimes instead of freezing the desktop webview. */
    #[allow(dead_code)] // unused by the web server crate, retained for desktop IPC
    pub fn read_file(&self, path: &str) -> Result<String, String> {
        self.read_bounded(path, MAX_FILE_BYTES)
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
        // Same cap as text reads: a pathological image must not become a
        // multi-hundred-MB base64 string pinned in the webview's DOM.
        let data = Self::read_limited(&f, MAX_FILE_BYTES)?;
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

/// Vault-relative path of a document's WYSIWYG snapshot.
    fn snapshot_path(doc_path: &str) -> String {
        format!("{SNAPSHOT_DIR}/{doc_path}.json")
    }

/// Read a document's WYSIWYG snapshot, or `None` when it has never been written.
    ///
    /// The snapshot is a DISPOSABLE cache, never a source of truth: callers apply
    /// it only while its stored Markdown still matches the file on disk. A missing
    /// or unreadable snapshot therefore degrades to "no formatting", never to an
    /// error the editor has to surface.
    pub fn read_snapshot(&self, doc_path: &str) -> Result<Option<String>, String> {
        let f = self.safe_path(&Self::snapshot_path(doc_path))?;
        match std::fs::read(&f) {
            Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("Read: {e}")),
        }
    }

/// Write a document's WYSIWYG snapshot. Deliberately does NOT invalidate the
    /// tree/search caches: [`SNAPSHOT_ROOT`] is an ignored entry, so nothing those
    /// caches read can change — and this runs on every autosave.
    pub fn write_snapshot(&self, doc_path: &str, content: &str) -> Result<(), String> {
        let f = self.safe_path(&Self::snapshot_path(doc_path))?;
        if let Some(p) = f.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
        std::fs::write(&f, content).map_err(|e| e.to_string())?;
        self.ensure_snapshot_gitignore()
    }

/// Keep [`SNAPSHOT_ROOT`] out of git without touching the user's root
    /// `.gitignore`: a `.gitignore` containing `*` ignores every sibling —
    /// including itself — so the whole directory stays untracked.
    fn ensure_snapshot_gitignore(&self) -> Result<(), String> {
        let f = self.safe_path(".docubook/.gitignore")?;
        if !f.exists() {
            if let Some(p) = f.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
            std::fs::write(&f, "*\n").map_err(|e| e.to_string())?;
        }
        Ok(())
    }

/// Snapshot file path for a document (file) entry.
    fn snapshot_file_path(doc_path: &str) -> String {
        format!("{SNAPSHOT_DIR}/{doc_path}.json")
    }

/// Snapshot directory for a vault directory entry: its documents' snapshots
    /// live under `SNAPSHOT_DIR/<dir>/…`, so a folder rename/move maps 1:1.
    fn snapshot_dir_path(dir_path: &str) -> String {
        format!("{SNAPSHOT_DIR}/{dir_path}")
    }

/// Drop the snapshot(s) for a deleted entry. Best-effort: the cache is
    /// disposable, so a failure here must never fail the delete itself.
    pub fn remove_snapshot(&self, rel: &str, is_dir: bool) {
        let mapped = if is_dir { Self::snapshot_dir_path(rel) } else { Self::snapshot_file_path(rel) };
        if let Ok(p) = self.safe_path(&mapped) {
            if p.is_dir() { let _ = std::fs::remove_dir_all(&p); } else { let _ = std::fs::remove_file(&p); }
        }
        self.prune_empty_snapshot_dirs(rel);
    }

/// Move the snapshot(s) with a renamed/moved entry. Best-effort (see
    /// `remove_snapshot`); a missing source snapshot is a no-op.
    pub fn move_snapshot(&self, from: &str, to: &str, is_dir: bool) {
        let (src_rel, dst_rel) = if is_dir {
            (Self::snapshot_dir_path(from), Self::snapshot_dir_path(to))
        } else {
            (Self::snapshot_file_path(from), Self::snapshot_file_path(to))
        };
        let (Ok(src), Ok(dst)) = (self.safe_path(&src_rel), self.safe_path(&dst_rel)) else { return };
        if !src.exists() { return; }
        if let Some(p) = dst.parent() { let _ = std::fs::create_dir_all(p); }
        let _ = std::fs::rename(&src, &dst);
        self.prune_empty_snapshot_dirs(from);
    }

/// Copy the snapshot(s) with a copied entry, so a pasted document keeps the
    /// formatting Markdown drops. Best-effort (see `remove_snapshot`).
    pub fn copy_snapshot(&self, from: &str, to: &str, is_dir: bool) {
        let (src_rel, dst_rel) = if is_dir {
            (Self::snapshot_dir_path(from), Self::snapshot_dir_path(to))
        } else {
            (Self::snapshot_file_path(from), Self::snapshot_file_path(to))
        };
        let (Ok(src), Ok(dst)) = (self.safe_path(&src_rel), self.safe_path(&dst_rel)) else { return };
        if !src.exists() { return; }
        if let Some(p) = dst.parent() { let _ = std::fs::create_dir_all(p); }
        if is_dir { let _ = copy_dir_all(&src, &dst); } else { let _ = std::fs::copy(&src, &dst); }
    }

/// Remove snapshot directories left empty by a delete/move, stopping at the
    /// first non-empty one (or the snapshot root). Keeps the cache from filling
    /// with empty folders.
    fn prune_empty_snapshot_dirs(&self, rel: &str) {
        let Ok(root) = self.safe_path(SNAPSHOT_DIR) else { return };
        let Some(parent) = Path::new(rel).parent() else { return };
        let mut current = self.safe_path(&format!("{SNAPSHOT_DIR}/{}", parent.to_string_lossy())).ok();
        while let Some(dir) = current {
            if dir == root || !dir.starts_with(&root) { break; }
            if std::fs::remove_dir(&dir).is_err() { break; } // non-empty (or gone) → stop
            current = dir.parent().map(Path::to_path_buf);
        }
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
        let is_dir = std::fs::symlink_metadata(&f).map(|m| m.file_type().is_dir()).unwrap_or(false);
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
        self.remove_snapshot(path, is_dir);
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
        let is_dir = std::fs::symlink_metadata(&src).map(|m| m.file_type().is_dir()).unwrap_or(false);
        if let Some(p) = dst.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
        std::fs::rename(&src, &dst).map_err(|e| format!("Rename: {}", e))?;
        self.move_snapshot(from, to, is_dir);
        self.invalidate_caches();
        Ok(())
    }

/** Copy a file or directory into `to_dir`, resolving a name collision with a
 *  Finder-style suffix: `note.md` → `note copy.md` → `note copy 2.md`.
 *  Returns the vault-relative path of the copy (the name is final only after
 *  the collision walk, so the caller cannot predict it). */
    pub fn copy_path(&self, from: &str, to_dir: &str) -> Result<String, String> {
        let src = self.safe_path(from)?;
        let dst_dir = self.safe_path(to_dir)?;
        if !src.exists() {
            return Err(format!("Source no longer exists: {from}"));
        }
        let is_dir = std::fs::symlink_metadata(&src)
            .map_err(|e| format!("Copy: {e}"))?
            .file_type()
            .is_dir();
        // A folder cannot be pasted into itself or a descendant of itself:
        // the recursion would read the subtree it is still growing.
        if is_dir && dst_dir.starts_with(&src) {
            return Err("Cannot paste a folder into itself".to_string());
        }
        let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if name.is_empty() {
            return Err("Invalid copy source".to_string());
        }
        let target_name = unique_copy_name(&dst_dir, &name)?;
        let target = dst_dir.join(&target_name);
        if is_dir {
            copy_dir_all(&src, &target)?;
        } else {
            std::fs::copy(&src, &target).map_err(|e| format!("Copy: {e}"))?;
        }
        let landed = if to_dir.is_empty() { target_name } else { format!("{to_dir}/{target_name}") };
        self.copy_snapshot(from, &landed, is_dir);
        self.invalidate_caches();
        Ok(landed)
    }

/** Move a file or directory into `to_dir`. Unlike a copy, a name collision is
 *  refused instead of resolved: silently renaming a moved entry would break the
 *  one thing cut-and-paste promises — it keeps its name, or nothing happens.
 *  A move within the same folder is a no-op. Returns the vault-relative path
 *  the entry landed at. */
    pub fn move_path(&self, from: &str, to_dir: &str) -> Result<String, String> {
        let src = self.safe_path(from)?;
        let dst_dir = self.safe_path(to_dir)?;
        if !src.exists() {
            return Err(format!("Source no longer exists: {from}"));
        }
        // Already where it would land.
        if src.parent() == Some(dst_dir.as_path()) {
            return Ok(from.to_string());
        }
        let is_dir = std::fs::symlink_metadata(&src)
            .map_err(|e| format!("Move: {e}"))?
            .file_type()
            .is_dir();
        // A folder cannot be moved into itself or a descendant of itself.
        if is_dir && dst_dir.starts_with(&src) {
            return Err("Cannot move a folder into itself".to_string());
        }
        let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if name.is_empty() {
            return Err("Invalid move source".to_string());
        }
        if dir_names(&dst_dir)?.iter().any(|entry| *entry == name.to_lowercase()) {
            return Err(format!("{name} already exists in the destination folder"));
        }
        let target = dst_dir.join(&name);
        std::fs::rename(&src, &target).map_err(|e| format!("Move: {e}"))?;
        let landed = if to_dir.is_empty() { name } else { format!("{to_dir}/{name}") };
        self.move_snapshot(from, &landed, is_dir);
        self.invalidate_caches();
        Ok(landed)
    }
}

/** Lowercased names inside `dir` — the collision set copy and move both check.
 *  Case-insensitive because one vault is read through a case-insensitive
 *  filesystem on the desktop and a case-sensitive one on the server: the tree
 *  must never hold two names a user reads as one. */
fn dir_names(dir: &Path) -> Result<Vec<String>, String> {
    Ok(std::fs::read_dir(dir)
        .map_err(|e| format!("Destination: {e}"))?
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_lowercase())
        .collect())
}

/** A name free for use inside `dir`: the candidate itself when nothing holds
 *  it, otherwise the Finder-style `copy` / `copy 2` walk. */
fn unique_copy_name(dir: &Path, name: &str) -> Result<String, String> {
    let existing = dir_names(dir)?;
    let taken = |candidate: &str| existing.iter().any(|entry| *entry == candidate.to_lowercase());
    if !taken(name) {
        return Ok(name.to_string());
    }
    let (base, extension) = split_extension(name);
    for n in 1u32.. {
        let candidate = if n == 1 { format!("{base} copy{extension}") } else { format!("{base} copy {n}{extension}") };
        if !taken(&candidate) {
            return Ok(candidate);
        }
    }
    unreachable!("copy name search exhausted")
}

/** Split a name into (stem, extension-with-dot). A leading dot belongs to the
 *  stem: `.env` has no extension, so its copies read `.env copy`, never
 *  `.env.copy`. */
fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(at) if at > 0 => name.split_at(at),
        _ => (name, ""),
    }
}

/** Recursive directory copy for vault content. Symlinks are skipped on
 *  purpose: following one can leave the vault or loop, and the vault never
 *  creates them itself. */
fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("Copy: {e}"))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("Copy: {e}"))? {
        let entry = entry.map_err(|e| format!("Copy: {e}"))?;
        let kind = entry.file_type().map_err(|e| format!("Copy: {e}"))?;
        if kind.is_symlink() {
            continue;
        }
        let target = dst.join(entry.file_name());
        if kind.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| format!("Copy: {e}"))?;
        }
    }
    Ok(())
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
    fn copy_into_same_folder_uses_copy_suffix() {
        let dir = std::env::temp_dir().join(format!("docubook-copy-same-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("note.md"), "body").unwrap();

        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        assert_eq!(v.copy_path("note.md", "").unwrap(), "note copy.md");
        // The original is untouched and the copy carries the content.
        assert_eq!(std::fs::read_to_string(dir.join("note.md")).unwrap(), "body");
        assert_eq!(std::fs::read_to_string(dir.join("note copy.md")).unwrap(), "body");
        // Pasting again does not reuse the first copy's name.
        assert_eq!(v.copy_path("note.md", "").unwrap(), "note copy 2.md");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_into_another_folder_keeps_the_name_until_it_collides() {
        let dir = std::env::temp_dir().join(format!("docubook-copy-other-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("archive")).unwrap();
        std::fs::write(dir.join("note.md"), "body").unwrap();

        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        assert_eq!(v.copy_path("note.md", "archive").unwrap(), "archive/note.md");
        assert!(dir.join("archive/note.md").exists());
        // A second paste into the same folder walks the suffix.
        assert_eq!(v.copy_path("note.md", "archive").unwrap(), "archive/note copy.md");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /** The vault may live on a case-sensitive Linux server while the user reads
     *  it through the desktop tree — two names that differ only in case would
     *  render as the same row, so the collision walk catches them everywhere. */
    #[test]
    fn copy_compares_names_case_insensitively() {
        let dir = std::env::temp_dir().join(format!("docubook-copy-case-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("archive")).unwrap();
        std::fs::write(dir.join("note.md"), "x").unwrap();
        std::fs::write(dir.join("archive/NOTE.MD"), "x").unwrap();

        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        assert_eq!(v.copy_path("note.md", "archive").unwrap(), "archive/note copy.md");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_folder_recursively_and_never_into_itself() {
        let dir = std::env::temp_dir().join(format!("docubook-copy-folder-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("folder/inner")).unwrap();
        std::fs::write(dir.join("folder/inner/a.md"), "a").unwrap();

        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        assert_eq!(v.copy_path("folder", "").unwrap(), "folder copy");
        assert_eq!(std::fs::read_to_string(dir.join("folder copy/inner/a.md")).unwrap(), "a");
        // A folder can never land inside itself or a descendant of itself.
        assert!(v.copy_path("folder", "folder").is_err());
        assert!(v.copy_path("folder", "folder/inner").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /** A leading dot belongs to the stem: `.env` copies to `.env copy`, not to
     *  `.env.copy` (which would read as a hidden `.copy` file). */
    #[test]
    fn copy_keeps_dotfiles_extensionless() {
        let dir = std::env::temp_dir().join(format!("docubook-copy-dot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".env"), "A=1").unwrap();

        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        assert_eq!(v.copy_path(".env", "").unwrap(), ".env copy");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn move_into_another_folder_keeps_the_name_and_removes_the_source() {
        let dir = std::env::temp_dir().join(format!("docubook-move-other-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("archive")).unwrap();
        std::fs::write(dir.join("note.md"), "body").unwrap();

        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        assert_eq!(v.move_path("note.md", "archive").unwrap(), "archive/note.md");
        assert!(!dir.join("note.md").exists());
        assert_eq!(std::fs::read_to_string(dir.join("archive/note.md")).unwrap(), "body");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /** A move keeps its name or does nothing — silently renaming it would make
     *  cut-and-paste a different operation than the user asked for. */
    #[test]
    fn move_refuses_a_taken_name_instead_of_renaming() {
        let dir = std::env::temp_dir().join(format!("docubook-move-taken-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("archive")).unwrap();
        std::fs::write(dir.join("note.md"), "mine").unwrap();
        std::fs::write(dir.join("archive/note.md"), "theirs").unwrap();

        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        let error = v.move_path("note.md", "archive").unwrap_err();
        assert!(error.contains("already exists"), "unexpected error: {error}");
        // Nothing moved and nothing was overwritten.
        assert_eq!(std::fs::read_to_string(dir.join("note.md")).unwrap(), "mine");
        assert_eq!(std::fs::read_to_string(dir.join("archive/note.md")).unwrap(), "theirs");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn move_within_the_same_folder_is_a_no_op() {
        let dir = std::env::temp_dir().join(format!("docubook-move-same-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("note.md"), "body").unwrap();

        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        assert_eq!(v.move_path("note.md", "").unwrap(), "note.md");
        assert_eq!(std::fs::read_to_string(dir.join("note.md")).unwrap(), "body");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn move_folder_and_never_into_itself() {
        let dir = std::env::temp_dir().join(format!("docubook-move-folder-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("folder/inner")).unwrap();
        std::fs::create_dir_all(dir.join("other")).unwrap();
        std::fs::write(dir.join("folder/inner/a.md"), "a").unwrap();

        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        assert!(v.move_path("folder", "folder").is_err());
        assert!(v.move_path("folder", "folder/inner").is_err());
        assert_eq!(v.move_path("folder", "other").unwrap(), "other/folder");
        assert_eq!(std::fs::read_to_string(dir.join("other/folder/inner/a.md")).unwrap(), "a");
        assert!(!dir.join("folder").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn move_compares_names_case_insensitively() {
        let dir = std::env::temp_dir().join(format!("docubook-move-case-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("archive")).unwrap();
        std::fs::write(dir.join("note.md"), "mine").unwrap();
        std::fs::write(dir.join("archive/NOTE.MD"), "theirs").unwrap();

        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        assert!(v.move_path("note.md", "archive").is_err());
        assert!(dir.join("note.md").exists());
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
    fn read_commands_enforce_the_shared_byte_cap() {
        let dir = std::env::temp_dir().join(format!("vault-test-read-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("big.bin"), vec![b'x'; (MAX_FILE_BYTES + 1) as usize]).unwrap();
        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        // Both desktop reads must reject exactly what the web API rejects,
        // instead of allocating the whole oversized file unbounded.
        assert!(v.read_file("big.bin").is_err());
        assert!(v.read_file_binary("big.bin").is_err());
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

    #[test]
    fn snapshot_round_trips_is_gitignored_and_hidden_from_walks() {
        let dir = std::env::temp_dir().join(format!("vault-test-snapshot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let v = Vault::new(dir.to_str().unwrap()).unwrap();

        // Absent until written — a cache miss, not an error.
        assert!(v.read_snapshot("notes/a.md").unwrap().is_none());

        let payload = r##"{"markdown":"# A\n","blocks":[]}"##;
        v.write_snapshot("notes/a.md", payload).unwrap();
        assert_eq!(v.read_snapshot("notes/a.md").unwrap().as_deref(), Some(payload));
        // Nested parent directories are created for the snapshot path.
        assert!(dir.join(".docubook/wysiwyg/notes/a.md.json").exists());

        // Self-ignoring so the user's root .gitignore is untouched.
        assert_eq!(std::fs::read_to_string(dir.join(".docubook/.gitignore")).unwrap(), "*\n");

        // The cache directory never leaks into a tree or walk.
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        std::fs::write(dir.join("notes/a.md"), "# A\n").unwrap();
        assert!(v.tree("").iter().all(|e| e.name != ".docubook"));
        assert!(v.walk("", WalkKind::All).iter().all(|p| !p.starts_with(".docubook")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_follows_rename_move_copy_and_delete() {
        let dir = std::env::temp_dir().join(format!("vault-test-snapshot-lifecycle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        std::fs::write(dir.join("notes/a.md"), "# A\n").unwrap();
        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        v.write_snapshot("notes/a.md", "SNAP-A").unwrap();

        // rename: the snapshot follows the file, the old path is cleared.
        v.rename_file("notes/a.md", "notes/b.md").unwrap();
        assert!(v.read_snapshot("notes/a.md").unwrap().is_none());
        assert_eq!(v.read_snapshot("notes/b.md").unwrap().as_deref(), Some("SNAP-A"));

        // move into another folder: still follows, and the emptied snapshot
        // folder is pruned.
        std::fs::create_dir_all(dir.join("archive")).unwrap();
        v.move_path("notes/b.md", "archive").unwrap();
        assert_eq!(v.read_snapshot("archive/b.md").unwrap().as_deref(), Some("SNAP-A"));
        assert!(!dir.join(".docubook/wysiwyg/notes").exists());

        // copy: the copy carries the snapshot too.
        v.copy_path("archive/b.md", "notes").unwrap();
        assert_eq!(v.read_snapshot("notes/b.md").unwrap().as_deref(), Some("SNAP-A"));

        // delete: the snapshot is dropped.
        v.delete_file("notes/b.md").unwrap();
        assert!(v.read_snapshot("notes/b.md").unwrap().is_none());

        // a folder rename moves the whole snapshot subtree.
        std::fs::create_dir_all(dir.join("book")).unwrap();
        std::fs::write(dir.join("book/c.md"), "# C\n").unwrap();
        v.write_snapshot("book/c.md", "SNAP-C").unwrap();
        v.rename_file("book", "tome").unwrap();
        assert_eq!(v.read_snapshot("tome/c.md").unwrap().as_deref(), Some("SNAP-C"));

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
