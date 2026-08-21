
use std::collections::HashMap;
use std::path::Path;
use regex::Regex;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Backlink { pub path: String, pub name: String, pub snippet: String }
#[derive(Debug, Serialize)]
pub struct Suggestion { pub path: String, pub title: String }

/// Index of all `[[wikilink]]` relationships in the vault.
/// Concept: a note is referenced by its normalized name (`[[Note Name]]` →
/// `note-name`); the index maps every file to its link targets AND every
/// normalized name to the actual file, so links resolve to real paths.
pub struct WikiIndex {
    root: std::path::PathBuf,
    /// rel path -> normalized link targets
    links: HashMap<String, Vec<String>>,
    files: Vec<std::path::PathBuf>,
    /// normalized name -> rel path (first file that claims the name)
    name_to_path: HashMap<String, String>,
}

impl WikiIndex {
/** Create an empty wiki index. Call `scan()` to populate. */
    pub fn new(root: &Path) -> Self {
        Self { root: root.to_path_buf(), links: HashMap::new(), files: Vec::new(), name_to_path: HashMap::new() }
    }
/** Walk all markdown files (`.md`/`.mdx`, recursive, skipping hidden dirs) and
 *  build the wikilink graph + name→path resolution map. */
    pub fn scan(&mut self) {
        self.links.clear(); self.files.clear(); self.name_to_path.clear();
        let link_re = Regex::new(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]").unwrap();
        let root = self.root.clone();
        self.scan_dir(&root, &link_re);
    }

    fn scan_dir(&mut self, dir: &Path, link_re: &Regex) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                let name = e.file_name().to_string_lossy().to_string();
                if crate::vault::is_ignored_entry(&name) { continue; }
                if p.is_dir() { self.scan_dir(&p, link_re); continue; }
                let ext = p.extension().and_then(|e| e.to_str()).unwrap_or_default();
                // markdown family — .md/.mdx (single source in markdown.rs)
                if !crate::markdown::is_markdown_name(ext) { continue; }
                let rel = self.rel(&p);
                self.files.push(p.clone());
                let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                self.name_to_path.entry(normalize(&stem)).or_insert_with(|| rel.clone());
                if let Ok(c) = std::fs::read_to_string(&p) {
                    let targets: Vec<String> = link_re.captures_iter(&c).map(|m| normalize(&m[1])).collect();
                    self.links.insert(rel, targets);
                }
            }
        }
    }
/** Return files that link TO the given path, with a one-line snippet of the link context.
 *  A link counts when its normalized text matches the target file's name/path,
 *  OR the link text resolves to the target file. */
    pub fn backlinks(&self, target: &str) -> Vec<Backlink> {
        let t = normalize(target);
        let t_name = Path::new(target).file_stem().map(|s| normalize(&s.to_string_lossy())).unwrap_or_default();
        self.links.iter().filter(|(_, v)| {
            v.iter().any(|lt| {
                lt == &t || lt == &t_name || self.resolve(lt).map(|p| normalize(&p)) == Some(t.clone())
            })
        }).map(|(k, v)| {
            let matched = v.iter().find(|lt| lt.as_str() == t.as_str() || lt.as_str() == t_name.as_str() || self.resolve(lt.as_str()).map(|p| normalize(&p)) == Some(t.clone()))
                .cloned().unwrap_or_else(|| t.clone());
            let name = Path::new(k).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            Backlink { path: k.clone(), name, snippet: self.snippet_for_link(k, &matched) }
        }).collect()
    }
/** Resolve a `[[target]]` name to the actual relative file path, if it exists. */
    pub fn resolve(&self, target: &str) -> Option<String> {
        let n = normalize(target);
        // exact name match first, then suffix match (e.g. `notes` → `projects/notes`)
        if let Some(p) = self.name_to_path.get(&n) { return Some(p.clone()); }
        self.name_to_path.iter()
            .filter(|(k, _)| k.ends_with(&format!("/{n}")) || k.ends_with(&n))
            .min_by_key(|(k, _)| k.len())
            .map(|(_, p)| p.clone())
    }
/** Suggest files matching a query (fuzzy by filename stem). */
    pub fn suggest(&self, query: &str) -> Vec<Suggestion> {
        let q = query.to_lowercase();
        let mut by_name: Vec<Suggestion> = Vec::new();
        let mut by_content: Vec<Suggestion> = Vec::new();
        for f in &self.files {
            let name = f.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if name.to_lowercase().contains(&q) {
                by_name.push(Suggestion { path: self.rel(f), title: name });
            } else if let Ok(c) = std::fs::read_to_string(f) {
                // Content match — lets you link a note by what's IN it, not just
                // its filename. Reads are bounded: stops once 20 total found.
                if c.to_lowercase().contains(&q) {
                    by_content.push(Suggestion { path: self.rel(f), title: name });
                }
            }
            if by_name.len() + by_content.len() >= 20 { break; }
        }
        by_name.into_iter().chain(by_content).take(20).collect()
    }
    fn rel(&self, path: &Path) -> String { path.strip_prefix(&self.root).map(|p| p.to_string_lossy().to_string()).unwrap_or_default() }
/** Extract the first line containing a wikilink whose text normalizes to `lt`. */
    fn snippet_for_link(&self, file: &str, lt: &str) -> String {
        let Ok(c) = std::fs::read_to_string(self.root.join(file)) else { return String::new() };
        let link_re = Regex::new(r"\[\[([^\]|]+)").unwrap();
        c.lines().find_map(|l| {
            let hit = link_re.captures_iter(l).any(|m| normalize(&m[1]) == lt);
            if hit { Some(l.trim().chars().take(140).collect()) } else { None }
        }).unwrap_or_default()
    }
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

    #[test]
    fn scan_builds_links_and_name_map() {
        let dir = std::env::temp_dir().join(format!("docubook-wiki-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("alpha.md"), "# Alpha\n\nSee [[Beta Note]] and [[Gamma]].").unwrap();
        std::fs::write(dir.join("beta-note.md"), "# Beta\n\nback to [[alpha]]").unwrap();
        std::fs::write(dir.join("gamma.md"), "gamma only").unwrap();

        let mut w = WikiIndex::new(&dir);
        w.scan();
        // link resolution: [[Beta Note]] → beta-note.md
        assert_eq!(w.resolve("Beta Note").as_deref(), Some("beta-note.md"));
        assert_eq!(w.resolve("alpha").as_deref(), Some("alpha.md"));
        // backlinks of alpha: beta-note.md links to it, with a snippet
        let bl = w.backlinks("alpha.md");
        assert_eq!(bl.len(), 1);
        assert_eq!(bl[0].path, "beta-note.md");
        assert!(bl[0].snippet.contains("back to [[alpha]]"));
        // suggest by stem — name matches first; content match ("Gamma" in
        // alpha.md) follows after
        let gam = w.suggest("gam");
        assert_eq!(gam[0].path, "gamma.md");
        assert!(gam.iter().any(|s| s.path == "alpha.md"), "content match must also be suggested");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_is_recursive_and_suggests_content() {
        let dir = std::env::temp_dir().join(format!("docubook-wiki-rec-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("projects")).unwrap();
        std::fs::create_dir_all(dir.join(".trash")).unwrap();
        std::fs::write(dir.join("projects/roadmap.md"), "# Roadmap\n\nlaunch q3").unwrap();
        std::fs::write(dir.join(".trash/old.md"), "# Old").unwrap();
        std::fs::write(dir.join("notes.md"), "# Notes").unwrap();

        let mut w = WikiIndex::new(&dir);
        w.scan();
        // recursive: nested note indexed; .trash excluded
        assert!(w.resolve("roadmap").as_deref() == Some("projects/roadmap.md"), "nested note must resolve");
        assert!(w.resolve("old").is_none(), ".trash must be excluded");
        // content search: query matches words INSIDE the note, not its filename
        let hits = w.suggest("launch");
        assert!(hits.iter().any(|s| s.path == "projects/roadmap.md"), "content match must be found");
        // filename match still wins the ordering (first)
        let by_name = w.suggest("road");
        assert_eq!(by_name[0].path, "projects/roadmap.md");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
