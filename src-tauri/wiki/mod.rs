
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use regex::Regex;
use serde::Serialize;

use crate::vault::Vault;

const SUGGEST_MAX_RESULTS: usize = 20;
/// Content matches need a file read each, so a query that matches no filename
/// would otherwise read the whole vault on every keystroke. Name matches are
/// never capped: they cost no I/O and are ranked first anyway.
const SUGGEST_CONTENT_SCAN_LIMIT: usize = 200;

#[derive(Debug, Serialize)]
pub struct Backlink { pub path: String, pub name: String, pub snippet: String }
#[derive(Debug, Serialize)]
pub struct Suggestion { pub path: String, pub title: String }

/// Index of all `[[wikilink]]` relationships in the vault.
/// Concept: a note is referenced by its normalized name (`[[Note Name]]` →
/// `note-name`); the index maps every file to its link targets AND every
/// normalized name to the actual file, so links resolve to real paths.
/// Holds no vault of its own: the caller passes the vault root and the file
/// list, so no second `Vault` is ever constructed. Reads go straight through the
/// root because every path here comes from `Vault::markdown_files`, never from
/// user input.
/// The link graph is built on first use (`ensure_links`), because extracting it
/// reads every markdown file — see the note on `links`.
pub struct WikiIndex {
    /// rel path -> normalized link targets
    links: RefCell<HashMap<String, Vec<String>>>,
    /// Whether `links` is already populated (reset by `scan`)
    links_built: Cell<bool>,
    /// rel paths of every indexed markdown file, in scan order
    files: Arc<Vec<String>>,
    /// normalized name -> rel path (first file that claims the name)
    name_to_path: HashMap<String, String>,
    /// Suffix fallback for `resolve`: a normalized name suffix -> the shortest
    /// normalized name ending with it. Built on the first fallback lookup,
    /// because scanning every name per lookup makes `backlinks` quadratic.
    suffix_keys: RefCell<HashMap<String, String>>,
    /// Whether `suffix_keys` is populated (reset by `scan`)
    suffixes_built: Cell<bool>,
}

impl WikiIndex {
/** Create an empty wiki index. Call `scan()` to populate. */
    pub fn new() -> Self {
        Self {
            links: RefCell::new(HashMap::new()),
            links_built: Cell::new(false),
            files: Arc::new(Vec::new()),
            name_to_path: HashMap::new(),
            suffix_keys: RefCell::new(HashMap::new()),
            suffixes_built: Cell::new(false),
        }
    }
/** Index the markdown file list (name→path resolution + the list itself) with
 *  no file reads.
 *
 *  `files` is the caller's `Vault::markdown_files()` output, the single
 *  enumerator for the whole app and therefore shared, not copied. The wikilink
 *  graph is built on the first `backlinks()` call (`ensure_links`), so opening a
 *  large vault pays for directory enumeration only, not for reading every note. */
    pub fn scan(&mut self, files: Arc<Vec<String>>) {
        self.name_to_path.clear();
        for rel in files.iter() {
            let stem = Path::new(rel).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            self.name_to_path.entry(normalize(&stem)).or_insert_with(|| rel.clone());
        }
        self.links.borrow_mut().clear();
        self.links_built.set(false);
        self.suffix_keys.borrow_mut().clear();
        self.suffixes_built.set(false);
        self.files = files;
    }
/** Build the wikilink graph once per `scan`. This reads every markdown file,
 *  so it stays off the vault-open path and the result is cached until the next
 *  `scan`; files with no `[[` in them skip the regex entirely. */
    fn ensure_links(&self, root: &Path) {
        if self.links_built.get() { return; }
        let link_re = Regex::new(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]").unwrap();
        let mut links = self.links.borrow_mut();
        links.clear();
        for rel in self.files.iter() {
            let Some(content) = read_indexed(root, rel) else { continue };
            if !content.contains("[[") { continue; }
            let targets: Vec<String> = link_re.captures_iter(&content).map(|m| normalize(&m[1])).collect();
            links.insert(rel.clone(), targets);
        }
        self.links_built.set(true);
    }
/** Return files that link TO the given path, with a one-line snippet of the link context.
 *  A link counts when its normalized text matches the target file's name/path,
 *  OR the link text resolves to the target file. */
    pub fn backlinks(&self, root: &Path, target: &str) -> Vec<Backlink> {
        self.ensure_links(root);
        let t = normalize(target);
        let t_name = Path::new(target).file_stem().map(|s| normalize(&s.to_string_lossy())).unwrap_or_default();
        // Collect inside the borrow, then read snippets outside it: snippets hit
        // the filesystem, and the graph borrow should not span that work.
        let matched: Vec<(String, String)> = {
            let links = self.links.borrow();
            links.iter().filter_map(|(path, targets)| {
                targets.iter().find(|lt| {
                    let lt = lt.as_str();
                    lt == t || lt == t_name || self.resolve(lt).map(|p| normalize(&p)) == Some(t.clone())
                }).map(|target| (path.clone(), target.clone()))
            }).collect()
        };
        matched.into_iter().map(|(path, target)| {
            let snippet = self.snippet_for_link(root, &path, &target);
            let name = Path::new(&path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            Backlink { path, name, snippet }
        }).collect()
    }
/** Resolve a `[[target]]` name to the actual relative file path, if it exists. */
    pub fn resolve(&self, target: &str) -> Option<String> {
        let n = normalize(target);
        // exact name match first, then suffix match (e.g. `notes` → `projects/notes`)
        if let Some(p) = self.name_to_path.get(&n) { return Some(p.clone()); }
        self.ensure_suffix_keys();
        let key = self.suffix_keys.borrow().get(&n).cloned()?;
        self.name_to_path.get(&key).cloned()
    }
/** Index every suffix of every name once, so `resolve`'s suffix fallback is a
 *  lookup instead of a scan of all names. Names are bare file stems (no `/`),
 *  so `ends_with` on them is plain string suffix matching; ties keep the first
 *  shortest name seen, matching the old `min_by_key(len)`. */
    fn ensure_suffix_keys(&self) {
        if self.suffixes_built.get() { return; }
        let mut map = self.suffix_keys.borrow_mut();
        map.clear();
        for key in self.name_to_path.keys() {
            for start in 0..=key.len() {
                if !key.is_char_boundary(start) { continue; }
                let suffix = &key[start..];
                let keep = map.get(suffix).map(|existing| existing.len() <= key.len()).unwrap_or(false);
                if !keep { map.insert(suffix.to_string(), key.clone()); }
            }
        }
        self.suffixes_built.set(true);
    }
/** Suggest files matching a query (fuzzy by filename stem). */
    pub fn suggest(&self, root: &Path, query: &str) -> Vec<Suggestion> {
        let q = query.to_lowercase();
        let mut by_name: Vec<Suggestion> = Vec::new();
        let mut by_content: Vec<Suggestion> = Vec::new();
        let mut content_reads = 0usize;
        for rel in self.files.iter() {
            let name = Path::new(rel).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if name.to_lowercase().contains(&q) {
                by_name.push(Suggestion { path: rel.clone(), title: name });
            } else if content_reads < SUGGEST_CONTENT_SCAN_LIMIT {
                // Content match — lets you link a note by what's IN it, not just
                // its filename. Bounded per query: the read budget caps the I/O,
                // and the loop stops early once enough results are collected.
                content_reads += 1;
                if let Some(c) = read_indexed(root, rel) {
                    if c.to_lowercase().contains(&q) {
                        by_content.push(Suggestion { path: rel.clone(), title: name });
                    }
                }
            }
            if by_name.len() + by_content.len() >= SUGGEST_MAX_RESULTS { break; }
        }
        by_name.into_iter().chain(by_content).take(SUGGEST_MAX_RESULTS).collect()
    }
/** Extract the first line containing a wikilink whose text normalizes to `lt`. */
    fn snippet_for_link(&self, root: &Path, file: &str, lt: &str) -> String {
        let Some(c) = read_indexed(root, file) else { return String::new() };
        let link_re = Regex::new(r"\[\[([^\]|]+)").unwrap();
        c.lines().find_map(|l| {
            let hit = link_re.captures_iter(l).any(|m| normalize(&m[1]) == lt);
            if hit { Some(l.trim().chars().take(140).collect()) } else { None }
        }).unwrap_or_default()
    }
}

/** Bounded text read for an index-owned vault path. Every path reaching here is
 *  `Vault::walk` output, so no traversal check is needed. */
fn read_indexed(root: &Path, rel: &str) -> Option<String> {
    let data = Vault::read_limited(&root.join(rel), 4 * 1024 * 1024).ok()?;
    // `from_utf8_lossy(..).to_string()` would copy the whole file a second time;
    // valid UTF-8 (the common case) is moved instead.
    Some(match String::from_utf8(data) {
        Ok(text) => text,
        Err(err) => String::from_utf8_lossy(err.as_bytes()).into_owned(),
    })
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

        let vault = Vault::new(dir.to_str().unwrap()).unwrap();
        let mut w = WikiIndex::new();
        w.scan(vault.markdown_files());
        // link resolution: [[Beta Note]] → beta-note.md
        assert_eq!(w.resolve("Beta Note").as_deref(), Some("beta-note.md"));
        assert_eq!(w.resolve("alpha").as_deref(), Some("alpha.md"));
        // backlinks of alpha: beta-note.md links to it, with a snippet
        let bl = w.backlinks(vault.root(), "alpha.md");
        assert_eq!(bl.len(), 1);
        assert_eq!(bl[0].path, "beta-note.md");
        assert!(bl[0].snippet.contains("back to [[alpha]]"));
        // suggest by stem — name matches first; content match ("Gamma" in
        // alpha.md) follows after
        let gam = w.suggest(vault.root(), "gam");
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

        let vault = Vault::new(dir.to_str().unwrap()).unwrap();
        let mut w = WikiIndex::new();
        w.scan(vault.markdown_files());
        // recursive: nested note indexed; .trash excluded
        assert!(w.resolve("roadmap").as_deref() == Some("projects/roadmap.md"), "nested note must resolve");
        assert!(w.resolve("old").is_none(), ".trash must be excluded");
        // content search: query matches words INSIDE the note, not its filename
        let hits = w.suggest(vault.root(), "launch");
        assert!(hits.iter().any(|s| s.path == "projects/roadmap.md"), "content match must be found");
        // filename match still wins the ordering (first)
        let by_name = w.suggest(vault.root(), "road");
        assert_eq!(by_name[0].path, "projects/roadmap.md");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_suffix_fallback_picks_shortest_name() {
        let dir = std::env::temp_dir().join(format!("docubook-wiki-suffix-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a-notes.md"), "").unwrap();
        std::fs::write(dir.join("team-notes.md"), "").unwrap();
        std::fs::write(dir.join("café-notes.md"), "").unwrap();

        let vault = Vault::new(dir.to_str().unwrap()).unwrap();
        let mut w = WikiIndex::new();
        w.scan(vault.markdown_files());
        // no exact match → suffix match, shortest name wins (a-notes < team-notes)
        assert_eq!(w.resolve("notes").as_deref(), Some("a-notes.md"));
        // multibyte names must not split the suffix scan mid-character
        assert_eq!(w.resolve("é-notes").as_deref(), Some("café-notes.md"));
        assert_eq!(w.resolve("nothing-like-this"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn suggest_caps_content_reads_but_keeps_name_matches() {
        let dir = std::env::temp_dir().join(format!("docubook-wiki-suggest-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let total = SUGGEST_CONTENT_SCAN_LIMIT + 50;
        for i in 0..total {
            // zero-padded so lexical walk order matches the index arithmetic
            let body = if i == 0 || i == SUGGEST_CONTENT_SCAN_LIMIT + 40 { "needlemarker" } else { "plain" };
            std::fs::write(dir.join(format!("c{:04}.md", i)), body).unwrap();
        }

        let vault = Vault::new(dir.to_str().unwrap()).unwrap();
        let mut w = WikiIndex::new();
        w.scan(vault.markdown_files());

        // Content stage stops after the read budget: only the match inside it is found.
        let hits = w.suggest(vault.root(), "needlemarker");
        assert_eq!(hits.iter().map(|s| s.path.as_str()).collect::<Vec<_>>(), vec!["c0000.md"]);
        // Name matches cost no reads, so they are still found past that budget.
        let late = w.suggest(vault.root(), &format!("c{:04}", SUGGEST_CONTENT_SCAN_LIMIT + 40));
        assert!(late.iter().any(|s| s.path == format!("c{:04}.md", SUGGEST_CONTENT_SCAN_LIMIT + 40)), "{:?}", late);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
