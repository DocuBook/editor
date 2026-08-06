use std::path::Path;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct SearchResult { pub path: String, pub name: String }

/// Search files by filename (not content). Walks directories recursively.
pub fn search_vault(root: &Path, query: &str) -> Vec<SearchResult> {
    let q = query.to_lowercase();
    let mut results = Vec::new();
    walk(root, root, &q, &mut results);
    results
}

fn walk(base: &Path, dir: &Path, query: &str, results: &mut Vec<SearchResult>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name == ".git" || name == ".DS_Store" || name == "node_modules" { continue; }
            if path.is_dir() {
                walk(base, &path, query, results);
            } else if name.to_lowercase().contains(query) {
                let rel = path.strip_prefix(base).map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
                results.push(SearchResult { path: rel, name });
                if results.len() >= 30 { return; }
            }
        }
    }
}
