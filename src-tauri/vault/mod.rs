use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

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
    /// Built once per vault, invalidated on mutations. Turns the O(n²) tree
    /// walk into O(n) build + O(1) lookups.
    renderable: RefCell<HashMap<PathBuf, bool>>,
}

impl Vault {
/** Create a new vault from a directory path. */
    pub fn new(path: &str) -> Result<Self, String> {
        let root = PathBuf::from(path);
        if !root.is_dir() { return Err(format!("Not a directory: {}", path)); }
        let v = Self { root, renderable: RefCell::new(HashMap::new()) };
        v.build_renderable_cache();
        Ok(v)
    }
/** Get the vault root path. */
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
    /// Uses the cached map — O(1) after build_renderable_cache().
    #[allow(dead_code)]
    fn dir_has_renderable(&self, dir: &Path) -> bool {
        *self.renderable.borrow().get(dir).unwrap_or(&false)
    }

    /// Build the `dir → has_renderable` map bottom-up in one walk. Each dir
    /// is renderable if it holds a renderable file directly or any subdir is.
    fn build_renderable_cache(&self) {
        let mut map: HashMap<PathBuf, bool> = HashMap::new();
        let mut stack: Vec<PathBuf> = vec![self.root.clone()];
        let mut post: Vec<PathBuf> = Vec::new();
        while let Some(d) = stack.pop() {
            post.push(d.clone());
            if let Ok(read) = std::fs::read_dir(&d) {
                for e in read.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if is_ignored_entry(&name) { continue; }
                    if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        stack.push(e.path());
                    } else if Self::is_renderable(&name) {
                        map.insert(d.clone(), true);
                    }
                }
            }
        }
        // Bottom-up: a dir is renderable if itself or any child is.
        while let Some(d) = post.pop() {
            let has = map.get(&d).copied().unwrap_or(false);
            if has {
                if let Some(p) = d.parent() { map.entry(p.to_path_buf()).or_insert(true); }
            }
        }
        *self.renderable.borrow_mut() = map;
    }

    /// Drop the cache after filesystem mutations so the next tree() rebuilds.
    fn invalidate_renderable_cache(&self) {
        self.renderable.borrow_mut().clear();
        self.build_renderable_cache();
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
    #[allow(dead_code)] // used by the web server crate for bounded API reads
    fn read_limited(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
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
        // Reference-completing fallback: an extension-less path that names a
        // markdown vault file opens it (e.g. links written as `roadmap` instead
        // of `roadmap.md`) — never appends twice (only when no extension present).
        let f = self.safe_path(path)?;
        let data = match std::fs::read(&f) {
            Ok(d) => d,
            Err(_) if !path.contains('.') => {
                let md = self.safe_path(&format!("{path}.md"));
                let mdx = self.safe_path(&format!("{path}.mdx"));
                std::fs::read(md.or(mdx)?).map_err(|e| format!("Read: {}", e))?
            }
            Err(e) => return Err(format!("Read: {}", e)),
        };
        Ok(String::from_utf8_lossy(&data).to_string())
    }

/** Read UTF-8 content with a bounded allocation for web/API callers. */
    #[allow(dead_code)] // used by the web server crate for bounded API reads
    pub fn read_file_limited(&self, path: &str, max_bytes: u64) -> Result<String, String> {
        let f = self.safe_path(path)?;
        let data = match Self::read_limited(&f, max_bytes) {
            Ok(data) => data,
            Err(_e) if !f.exists() && !path.contains('.') => {
                let md = self.safe_path(&format!("{path}.md"))?;
                let mdx = self.safe_path(&format!("{path}.mdx"))?;
                Self::read_limited(&md, max_bytes)
                    .or_else(|_| Self::read_limited(&mdx, max_bytes))?
            }
            Err(e) => return Err(e),
        };
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
        self.invalidate_renderable_cache();
        Ok(())
    }
/** Create an empty file, creating parent directories if needed. */
    pub fn create_file(&self, path: &str) -> Result<String, String> {
        let f = self.safe_path(path)?;
        if let Some(p) = f.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
        if !f.exists() { std::fs::write(&f, "").map_err(|e| e.to_string())?; }
        self.invalidate_renderable_cache();
        Ok(path.to_string())
    }

/** Create an empty directory (and parents). */
    pub fn create_directory(&self, path: &str) -> Result<(), String> {
        std::fs::create_dir_all(self.safe_path(path)?).map_err(|e| format!("Create dir: {}", e))?;
        self.invalidate_renderable_cache();
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
        self.invalidate_renderable_cache();
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
        self.invalidate_renderable_cache();
        Ok(())
    }

/** Permanently delete everything in vault-local `.trash/`. */
    #[allow(dead_code)]
    pub fn empty_trash(&self) -> Result<(), String> {
        let trash_dir = self.safe_path(".trash")?;
        let read = match std::fs::read_dir(trash_dir) {
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("Empty trash: {error}")),
        };
        for entry in read {
            Self::remove_trash_path(&entry.map_err(|e| format!("Empty trash: {e}"))?.path())?;
        }
        self.invalidate_renderable_cache();
        Ok(())
    }

/** Rename/move a file or directory. */
    pub fn rename_file(&self, from: &str, to: &str) -> Result<(), String> {
        let src = self.safe_path(from)?;
        let dst = self.safe_path(to)?;
        if let Some(p) = dst.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
        std::fs::rename(&src, &dst).map_err(|e| format!("Rename: {}", e))?;
        self.invalidate_renderable_cache();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_name_from_directory() {
        let v = Vault { root: PathBuf::from("/some/path/my-vault"), renderable: RefCell::new(HashMap::new()) };
        assert_eq!(v.name(), "my-vault");
    }

    #[test]
    fn vault_name_root() {
        // root's file_name is None on some platforms, empty on others
        let v = Vault { root: PathBuf::from("/"), renderable: RefCell::new(HashMap::new()) };
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

        // empty: clears everything left
        std::fs::write(dir.join(".trash/1700000003000-last.md"), "z").unwrap();
        v.empty_trash().unwrap();
        assert_eq!(v.list_trash().len(), 0);
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
}
