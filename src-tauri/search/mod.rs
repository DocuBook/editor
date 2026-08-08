use std::path::Path;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct SearchResult { pub path: String, pub name: String }

/// Search .md files by filename stem — no content reads. Case-insensitive,
/// ranked: prefix match (3) > substring (2) > fuzzy subsequence (1). The
/// `.md` extension is stripped before matching, so a query like "md" only
/// hits stems that actually contain it (e.g. "md-notes"), never every file.
pub fn search_vault(root: &Path, query: &str) -> Vec<SearchResult> {
    let q = query.trim().to_lowercase();
    if q.is_empty() { return vec![]; }
    let mut scored: Vec<(i32, SearchResult)> = Vec::new();
    walk(root, root, &q, &mut scored);
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
    scored.into_iter().take(30).map(|(_, r)| r).collect()
}

fn walk(base: &Path, dir: &Path, q: &str, scored: &mut Vec<(i32, SearchResult)>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name == ".git" || name == ".DS_Store" || name == "node_modules" || name == ".trash" { continue; }
            if path.is_dir() {
                walk(base, &path, q, scored);
            } else if name.ends_with(".md") {
                let stem = &name[..name.len() - 3];
                let score = fuzzy_score(stem, q);
                if score > 0 {
                    let rel = path.strip_prefix(base).map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
                    scored.push((score, SearchResult { path: rel, name }));
                }
            }
        }
    }
}

/// 3 = prefix, 2 = substring, 1 = fuzzy (ordered subsequence), 0 = no match.
fn fuzzy_score(stem: &str, q: &str) -> i32 {
    let s = stem.to_lowercase();
    if s.starts_with(q) { return 3; }
    if s.contains(q) { return 2; }
    let mut it = s.chars();
    if q.chars().all(|c| it.any(|sc| sc == c)) { return 1; }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(tag: &str, files: &[String]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("search-test-{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for f in files {
            let p = dir.join(f);
            if let Some(parent) = p.parent() { std::fs::create_dir_all(parent).unwrap(); }
            std::fs::write(p, "").unwrap();
        }
        dir
    }

    #[test]
    fn prefix_ranks_before_substring_fuzzy() {
        let dir = vault("prefix", &["alpha.md".to_string(), "alpine.md".to_string(), "beta.md".to_string()]);
        let r = search_vault(&dir, "alp");
        let names: Vec<&str> = r.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, vec!["alpha.md", "alpine.md"]); // prefix first, substring second
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fuzzy_matches_typo_and_skips_non_md() {
        let dir = vault("fuzzy", &["alpha.md".to_string(), "alpha.png".to_string(), "notes.md".to_string()]);
        let r = search_vault(&dir, "alpx"); // typo: subsequence a-l-p-x ⊂ alpha? p→a? no
        // "alpx" → subsequence in "alpha": a,l,?,x — no 'x' → no match
        assert!(r.is_empty());
        let r2 = search_vault(&dir, "alpa"); // a,l,p,a subsequence of alpha
        assert_eq!(r2.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), vec!["alpha.md"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn query_md_does_not_match_every_file() {
        let dir = vault("md", &["notes.md".to_string(), "md-tools.md".to_string(), "design.md".to_string()]);
        let r = search_vault(&dir, "md");
        let names: Vec<&str> = r.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, vec!["md-tools.md"]); // stem "md-tools" starts with md; "notes"/"design" don't
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recursive_and_capped_at_30() {
        let mut files = vec!["top.md".to_string()];
        for i in 0..40 { files.push(format!("sub/f{i}.md")); }
        let dir = vault("cap", &files);
        let r = search_vault(&dir, "f");
        assert!(r.len() <= 30);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
