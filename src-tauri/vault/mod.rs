
use std::path::{Path, PathBuf};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub file_type: String, // "0"=file, "1"=dir
}

#[derive(Debug, Clone, Serialize)]
pub struct TrashEntry {
    pub name: String,      // `{millis}-{original}` inside .trash/
    pub original: String,  // original file name (prefix stripped)
    pub deleted_at: u64,   // unix millis (from the prefix)
}

/// Filesystem-based vault that wraps a directory path.
#[derive(Debug)]
pub struct Vault { root: PathBuf }

impl Vault {
/** Create a new vault from a directory path. */
    pub fn new(path: &str) -> Result<Self, String> {
        let root = PathBuf::from(path);
        if !root.is_dir() { return Err(format!("Not a directory: {}", path)); }
        Ok(Self { root })
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

    /// True if the subtree at `dir` contains at least one `.md` file (recursive,
    /// skipping hidden/system dirs). Drives folder visibility: folders with
    /// nothing renderable are hidden from the tree.
    fn dir_has_md(dir: &std::path::Path) -> bool {
        if let Ok(read) = std::fs::read_dir(dir) {
            for e in read.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name == ".git" || name == ".DS_Store" || name == "node_modules" || name == ".trash" { continue; }
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    if Self::dir_has_md(&e.path()) { return true; }
                } else if name.ends_with(".md") {
                    return true;
                }
            }
        }
        false
    }

    pub fn tree(&self, subpath: &str) -> Vec<FileInfo> {
        let dir = match self.safe_path(subpath) { Ok(d) => d, Err(_) => return vec![] };
        let mut dirs = vec![]; let mut files = vec![];
        if let Ok(read) = std::fs::read_dir(&dir) {
            for e in read.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name == ".git" || name == ".DS_Store" || name == "node_modules" || name == ".trash" { continue; }
                let rel = if subpath.is_empty() { name.clone() } else { format!("{}/{}", subpath, name) };
                let ft = if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { "1" } else { "0" };
                // Only .md files are renderable — non-md files are skipped, and
                // folders with no .md anywhere in their subtree are hidden too.
                if ft == "0" && !name.ends_with(".md") { continue; }
                if ft == "1" && !Self::dir_has_md(&e.path()) { continue; } // ponytail: re-walks subtrees per folder; cache a md-count map if large vaults get slow
                let info = FileInfo { path: rel, name, file_type: ft.to_string() };
                if ft == "1" { dirs.push(info) } else { files.push(info) }
            }
        }
        dirs.sort_by_key(|a| a.name.to_lowercase());
        files.sort_by_key(|a| a.name.to_lowercase());
        [dirs, files].concat()
    }
/** Read file content as UTF-8 string. */
    pub fn read_file(&self, path: &str) -> Result<String, String> {
        // Reference-completing fallback: an extension-less path that names a
        // `.md` vault file opens it (e.g. links written as `roadmap` instead of
        // `roadmap.md`) — never appends twice (only when no extension present).
        let f = self.safe_path(path)?;
        let data = match std::fs::read(&f) {
            Ok(d) => d,
            Err(_) if !path.ends_with(".md") && !path.contains('.') => {
                std::fs::read(self.safe_path(&format!("{path}.md"))?).map_err(|e| format!("Read: {}", e))?
            }
            Err(e) => return Err(format!("Read: {}", e)),
        };
        Ok(String::from_utf8_lossy(&data).to_string())
    }
/** Write content to a file, creating parent directories if needed. */
    pub fn write_file(&self, path: &str, content: &str) -> Result<(), String> {
        let f = self.safe_path(path)?;
        if let Some(p) = f.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
        std::fs::write(&f, content).map_err(|e| e.to_string())
    }
/** Create an empty file, creating parent directories if needed. */
    pub fn create_file(&self, path: &str) -> Result<String, String> {
        let f = self.safe_path(path)?;
        if let Some(p) = f.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
        if !f.exists() { std::fs::write(&f, "").map_err(|e| e.to_string())?; }
        Ok(path.to_string())
    }

/** Create an empty directory (and parents). */
    pub fn create_directory(&self, path: &str) -> Result<(), String> {
        std::fs::create_dir_all(self.safe_path(path)?).map_err(|e| format!("Create dir: {}", e))?;
        Ok(())
    }

/** Move to trash. macOS → system Trash (Finder restore, MEM-012). Linux
 *  (web/Docker) → server-side `.trash/` inside the vault root: persistent in
 *  /data across container rebuilds (the XDG container trash is ephemeral).
 *  Moved name is `{millis}-{name}` so a future restore UI can strip the prefix. */
    pub fn delete_file(&self, path: &str) -> Result<(), String> {
        let f = self.safe_path(path)?;
        #[cfg(target_os = "linux")]
        {
            let trash_dir = self.root.join(".trash");
            std::fs::create_dir_all(&trash_dir).map_err(|e| e.to_string())?;
            let name = f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            let dst = trash_dir.join(format!("{ts}-{name}"));
            std::fs::rename(&f, &dst).map_err(|e| format!("Trash: {}", e))?;
        }
        #[cfg(not(target_os = "linux"))]
        {
            trash::delete(&f).map_err(|e| format!("Trash: {}", e))?;
        }
        Ok(())
    }

/** Resolve a `.trash/` entry name safely (no separators, no `..`). */
    #[allow(dead_code)] // wired only in the server crate (desktop uses system Trash)
    fn trash_path(&self, name: &str) -> Result<PathBuf, String> {
        if name.contains('/') || name.contains('\\') || name.contains("..") {
            return Err("Invalid trash entry".to_string());
        }
        Ok(self.root.join(".trash").join(name))
    }

/** List deleted items (`.trash/`), newest first. Empty on platforms that use
 *  the system trash (macOS) — the server-side trash only exists on Linux. */
    #[allow(dead_code)] // wired only in the server crate (desktop uses system Trash)
    pub fn list_trash(&self) -> Vec<TrashEntry> {
        let mut entries = Vec::new();
        if let Ok(read) = std::fs::read_dir(self.root.join(".trash")) {
            for e in read.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                let (ts, original): (String, String) = match name.split_once('-') {
                    Some((t, o)) if !t.is_empty() && t.chars().all(|c| c.is_ascii_digit()) => (t.to_string(), o.to_string()),
                    _ => (String::new(), name.clone()),
                };
                entries.push(TrashEntry {
                    name,
                    original,
                    deleted_at: ts.parse().unwrap_or(0),
                });
            }
        }
        entries.sort_by_key(|e| std::cmp::Reverse(e.deleted_at));
        entries
    }

/** Restore a trash entry to the vault root (strips the `{millis}-` prefix). */
    #[allow(dead_code)] // wired only in the server crate (desktop uses system Trash)
    pub fn restore_file(&self, trash_name: &str) -> Result<(), String> {
        let src = self.trash_path(trash_name)?;
        let original = trash_name.split_once('-').map(|(_, o)| o.to_string()).unwrap_or_else(|| trash_name.to_string());
        let dst = self.safe_path(&original)?;
        if dst.exists() { return Err(format!("A file named \"{original}\" already exists")); }
        std::fs::rename(&src, &dst).map_err(|e| format!("Restore: {}", e))?;
        Ok(())
    }

/** Permanently delete everything in `.trash/`. */
    #[allow(dead_code)] // wired only in the server crate (desktop uses system Trash)
    pub fn empty_trash(&self) -> Result<(), String> {
        if let Ok(read) = std::fs::read_dir(self.root.join(".trash")) {
            for e in read.flatten() {
                let p = e.path();
                if p.is_dir() { let _ = std::fs::remove_dir_all(&p); } else { let _ = std::fs::remove_file(&p); }
            }
        }
        Ok(())
    }

/** Rename/move a file or directory. */
    pub fn rename_file(&self, from: &str, to: &str) -> Result<(), String> {
        let src = self.safe_path(from)?;
        let dst = self.safe_path(to)?;
        if let Some(p) = dst.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
        std::fs::rename(&src, &dst).map_err(|e| format!("Rename: {}", e))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_name_from_directory() {
        let v = Vault { root: PathBuf::from("/some/path/my-vault") };
        assert_eq!(v.name(), "my-vault");
    }

    #[test]
    fn vault_name_root() {
        let v = Vault { root: PathBuf::from("/") };
        // root's file_name is None on some platforms, empty on others
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
    fn tree_hides_folders_without_md_recursively() {
        let dir = std::env::temp_dir().join("vault-test-hide-nomd");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::create_dir_all(dir.join("docs/inner")).unwrap();
        std::fs::write(dir.join("assets/logo.png"), "x").unwrap();
        std::fs::write(dir.join("docs/readme.md"), "").unwrap();
        std::fs::write(dir.join("docs/inner/no-md.txt"), "x").unwrap();

        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        let tree = v.tree("");
        // docs has a .md (recursively) → visible; assets has none → hidden
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].name, "docs");
        // a subtree with only non-md files stays hidden even nested
        let docs = v.tree("docs");
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].name, "readme.md");
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
        let moved: Vec<_> = std::fs::read_dir(&trash).unwrap().flatten().collect();
        assert_eq!(moved.len(), 1);
        assert!(moved[0].file_name().to_string_lossy().ends_with("notes.md"));
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

        // empty: clears everything left
        std::fs::write(dir.join(".trash/1700000002000-old.md"), "z").unwrap();
        v.empty_trash().unwrap();
        assert_eq!(v.list_trash().len(), 0);
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
