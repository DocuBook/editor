
use std::path::{Path, PathBuf};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub file_type: String, // "0"=file, "1"=dir
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
/** Block path traversal via .. */
    fn safe_path(&self, path: &str) -> Result<PathBuf, String> {
        if path.contains("..") {
            return Err("Path traversal blocked".to_string());
        }
        Ok(self.root.join(path))
    }

    pub fn tree(&self, subpath: &str) -> Vec<FileInfo> {
        let dir = match self.safe_path(subpath) { Ok(d) => d, Err(_) => return vec![] };
        let mut dirs = vec![]; let mut files = vec![];
        if let Ok(read) = std::fs::read_dir(&dir) {
            for e in read.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name == ".git" || name == ".DS_Store" || name == "node_modules" { continue; }
                let rel = if subpath.is_empty() { name.clone() } else { format!("{}/{}", subpath, name) };
                let ft = if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { "1" } else { "0" };
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
        let data = std::fs::read(self.safe_path(path)?).map_err(|e| format!("Read: {}", e))?;
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

/** Move to system Trash instead of permanent delete. */
    pub fn delete_file(&self, path: &str) -> Result<(), String> {
        let f = self.safe_path(path)?;
        trash::delete(&f).map_err(|e| format!("Trash: {}", e))?;
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
    fn tree_file_sort_order() {
        let dir = std::env::temp_dir().join("vault-test-sort");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("b.txt"), "").unwrap();
        std::fs::write(dir.join("a.txt"), "").unwrap();
        std::fs::create_dir(dir.join("z-dir")).unwrap();
        std::fs::create_dir(dir.join("a-dir")).unwrap();

        let v = Vault::new(dir.to_str().unwrap()).unwrap();
        let tree = v.tree("");
        // dirs first, alphabetical
        assert_eq!(tree[0].name, "a-dir");
        assert_eq!(tree[0].file_type, "1");
        assert_eq!(tree[1].name, "z-dir");
        assert_eq!(tree[1].file_type, "1");
        // then files
        assert_eq!(tree[2].name, "a.txt");
        assert_eq!(tree[2].file_type, "0");
        assert_eq!(tree[3].name, "b.txt");
        assert_eq!(tree[3].file_type, "0");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn vault_new_rejects_missing_dir() {
        let result = Vault::new("/tmp/nonexistent-12345");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Not a directory"));
    }
}
