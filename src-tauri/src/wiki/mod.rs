
use std::collections::HashMap;
use std::path::Path;
use regex::Regex;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Backlink { pub path: String, pub name: String, pub snippet: String }
#[derive(Debug, Serialize)]
pub struct Suggestion { pub path: String, pub title: String }

/// Index of all [[wikilink]] relationships in the vault.
pub struct WikiIndex { root: std::path::PathBuf, links: HashMap<String, Vec<String>>, files: Vec<std::path::PathBuf> }

impl WikiIndex {
/** Create an empty wiki index. Call `scan()` to populate. */
    pub fn new(root: &Path) -> Self { Self { root: root.to_path_buf(), links: HashMap::new(), files: Vec::new() } }
/** Walk all .md files and build the wikilink graph. */
    pub fn scan(&mut self) {
        self.links.clear(); self.files.clear();
        let link_re = Regex::new(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]").unwrap();
        if let Ok(entries) = std::fs::read_dir(&self.root) {
            for e in entries.flatten() {
                if e.path().extension().and_then(|e| e.to_str()) != Some("md") { continue; }
                let rel = self.rel(&e.path());
                self.files.push(e.path());
                if let Ok(c) = std::fs::read_to_string(e.path()) {
                    let targets: Vec<String> = link_re.captures_iter(&c).map(|m| normalize(&m[1])).collect();
                    self.links.insert(rel, targets);
                }
            }
        }
    }
/** Return files that link TO the given path via [[wikilink]]. */
    pub fn backlinks(&self, target: &str) -> Vec<Backlink> {
        let t = normalize(target);
        self.links.iter().filter(|(_, v)| v.contains(&t)).map(|(k, _)| {
            Backlink { path: k.clone(), name: Path::new(k).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(), snippet: String::new() }
        }).collect()
    }
/** Suggest files matching a query (fuzzy by filename stem). */
    pub fn suggest(&self, query: &str) -> Vec<Suggestion> {
        let q = query.to_lowercase();
        self.files.iter().filter_map(|f| {
            let name = f.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if name.to_lowercase().contains(&q) { Some(Suggestion { path: self.rel(f), title: name }) } else { None }
        }).take(20).collect()
    }
    fn rel(&self, path: &Path) -> String { path.strip_prefix(&self.root).map(|p| p.to_string_lossy().to_string()).unwrap_or_default() }
}

fn normalize(s: &str) -> String { s.trim().to_lowercase().replace(' ', "-").trim_matches('/').to_string() }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_trims_and_lowercases() {
        assert_eq!(normalize("  Hello World  "), "hello-world");
    }

    #[test]
    fn normalize_keeps_internal_slashes() {
        assert_eq!(normalize("/Foo/Bar/"), "foo/bar");
    }

    #[test]
    fn normalize_empty_string() {
        assert_eq!(normalize(""), "");
    }

    #[test]
    fn normalize_multiple_spaces() {
        assert_eq!(normalize("a   b   c"), "a---b---c");
    }

    #[test]
    fn normalize_already_normalized() {
        assert_eq!(normalize("hello-world"), "hello-world");
    }
}
