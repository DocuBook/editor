use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Component, Path};

pub const MENTION_MAX_FILES: usize = 32;
pub const MENTION_MAX_FILE_CHARS: usize = 24_000;
pub const MENTION_MAX_TOTAL_CHARS: usize = 120_000;
pub const MENTION_MAX_DEPTH: usize = 8;
/** Cap on reported skip reasons. A folder mention walks every file, so an asset
 *  folder can otherwise return thousands of entries the UI never shows. */
pub const MENTION_MAX_SKIPPED: usize = 64;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MentionKind { File, Folder }
#[derive(Debug, Clone, Deserialize)]
pub struct Mention { pub token: String, pub kind: MentionKind }
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Options { pub max_files: Option<usize>, pub max_file_chars: Option<usize>, pub max_total_chars: Option<usize>, pub max_depth: Option<usize> }
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ResolveRequest { #[serde(default)] pub mentions: Vec<Mention>, #[serde(rename = "excludePath")] pub exclude_path: Option<String>, pub options: Option<Options> }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason { NotFound, Unsupported, Budget, Duplicate, DepthExceeded, TraversalRejected }
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedFile { pub path: String, pub content: String, pub bytes: usize, pub truncated: bool, pub via: String }
#[derive(Debug, Clone, Serialize)]
pub struct Skipped { pub path: String, pub reason: SkipReason }
#[derive(Debug, Clone, Serialize, Default)]
pub struct Totals { pub files: usize, pub chars: usize, pub truncated: usize }
#[derive(Debug, Clone, Serialize, Default)]
pub struct Bundle { pub files: Vec<ResolvedFile>, pub skipped: Vec<Skipped>, pub totals: Totals }

/// Depth counted from the vault root, ignoring `.`/`..` components.
fn depth_of(path: &str) -> usize {
    Path::new(path).components().filter(|part| matches!(part, Component::Normal(_))).count()
}

/// Record a skip reason, bounded by `MENTION_MAX_SKIPPED`.
fn skip(bundle: &mut Bundle, path: String, reason: SkipReason) {
    if bundle.skipped.len() < MENTION_MAX_SKIPPED { bundle.skipped.push(Skipped { path, reason }); }
}

pub fn resolve(vault: &super::Vault, request: ResolveRequest) -> Bundle {
    use super::WalkKind;
    let mut bundle = Bundle::default();
    if request.mentions.is_empty() { return bundle; }
    let options = request.options.unwrap_or_default();
    let max_files = options.max_files.unwrap_or(MENTION_MAX_FILES).min(MENTION_MAX_FILES);
    let max_file_chars = options.max_file_chars.unwrap_or(MENTION_MAX_FILE_CHARS).min(MENTION_MAX_FILE_CHARS);
    let max_total_chars = options.max_total_chars.unwrap_or(MENTION_MAX_TOTAL_CHARS).min(MENTION_MAX_TOTAL_CHARS);
    let max_depth = options.max_depth.unwrap_or(MENTION_MAX_DEPTH).min(MENTION_MAX_DEPTH);
    let mut paths: Vec<(String, String)> = Vec::new();
    for mention in request.mentions {
        if mention.token.starts_with('/') || mention.token.split('/').any(|part| part == "..") {
            skip(&mut bundle, mention.token, SkipReason::TraversalRejected); continue;
        }
        match mention.kind {
            MentionKind::File => match vault.resolve_target(&mention.token) {
                Some(path) if !crate::markdown::is_markdown_name(&path) => skip(&mut bundle, path, SkipReason::Unsupported),
                Some(path) => paths.push((path, "mention".into())),
                None => skip(&mut bundle, mention.token, SkipReason::NotFound),
            },
            MentionKind::Folder => {
                let prefix = mention.token.trim_end_matches('/').to_string();
                if vault.resolve_directory(&prefix).is_none() { skip(&mut bundle, mention.token, SkipReason::NotFound); continue; }
                let prefix_depth = depth_of(&prefix);
                for path in vault.walk(&prefix, WalkKind::All) {
                    let filename = Path::new(&path).file_name().and_then(|s| s.to_str()).unwrap_or_default();
                    if !crate::markdown::is_markdown_name(filename) { skip(&mut bundle, path, SkipReason::Unsupported); continue; }
                    // Measured below the mentioned folder, so a degenerate prefix
                    // like `.` still counts every level instead of collapsing to 1.
                    let depth = depth_of(&path).saturating_sub(prefix_depth);
                    if depth > max_depth { skip(&mut bundle, path, SkipReason::DepthExceeded); }
                    else { paths.push((path, "folder".into())); }
                }
            }
        }
    }
    paths.sort_by(|a, b| a.0.cmp(&b.0));
    let mut seen = HashSet::new();
    let exclude = request.exclude_path.as_deref().unwrap_or("");
    for (path, via) in paths {
        if path == exclude || !seen.insert(path.clone()) { skip(&mut bundle, path, SkipReason::Duplicate); continue; }
        if bundle.files.len() >= max_files || bundle.totals.chars >= max_total_chars { skip(&mut bundle, path, SkipReason::Budget); continue; }
        let read_limit = max_file_chars.max(max_total_chars).saturating_mul(4).saturating_add(256) as u64;
        let content = match vault.read_bounded(&path, read_limit) { Ok(content) => content, Err(_) => { skip(&mut bundle, path, SkipReason::Budget); continue; } };
        let chars: Vec<char> = content.chars().collect();
        let allowed = max_file_chars.min(max_total_chars.saturating_sub(bundle.totals.chars));
        let truncated = chars.len() > allowed;
        let (content, used) = if truncated {
            let marker: String = format!("\n[... truncated: {} chars]", chars.len().saturating_sub(allowed))
                .chars().take(allowed).collect();
            let keep = allowed.saturating_sub(marker.chars().count());
            (chars.iter().take(keep).collect::<String>() + &marker, allowed)
        } else { (content, chars.len()) };
        let bytes = content.len();
        bundle.totals.files += 1; bundle.totals.chars += used;
        if truncated { bundle.totals.truncated += 1; }
        bundle.files.push(ResolvedFile { path, content, bytes, truncated, via });
    }
    bundle
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    fn vault() -> (PathBuf, super::super::Vault) {
        let root = std::env::temp_dir().join(format!("mention-resolver-{}-{}", std::process::id(), std::thread::current().name().unwrap_or("test")));
        let _ = std::fs::remove_dir_all(&root); std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(root.join("docs/nested")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("docs/a.md"), "alpha").unwrap();
        std::fs::write(root.join("docs/nested/b.md"), "beta").unwrap();
        std::fs::write(root.join("image.png"), "no").unwrap();
        std::fs::write(root.join(".git/secret.md"), "secret").unwrap();
        let vault = super::super::Vault::new(root.to_str().unwrap()).unwrap(); (root, vault)
    }
    fn request(mentions: Vec<Mention>, options: Option<Options>) -> ResolveRequest { ResolveRequest { mentions, exclude_path: None, options } }
    fn file(token: &str) -> Mention { Mention { token: token.into(), kind: MentionKind::File } }
    fn folder(token: &str) -> Mention { Mention { token: token.into(), kind: MentionKind::Folder } }
    #[test] fn nested_extensionless_and_recursive_folder() {
        let (_root, vault) = vault();
        let bundle = resolve(&vault, request(vec![folder("docs"), file("docs/nested/b")], None));
        assert_eq!(bundle.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["docs/a.md", "docs/nested/b.md"]);
        assert!(bundle.skipped.iter().any(|s| matches!(s.reason, SkipReason::Duplicate)));
    }
    #[test] fn traversal_unsupported_and_ignored_are_safe() {
        let (_root, vault) = vault();
        let bundle = resolve(&vault, request(vec![file("../secret.md"), file("image.png"), folder(".")], None));
        assert!(bundle.skipped.iter().any(|s| matches!(s.reason, SkipReason::TraversalRejected)));
        assert!(bundle.skipped.iter().any(|s| matches!(s.reason, SkipReason::Unsupported)));
        assert!(bundle.files.iter().all(|f| !f.content.contains("secret")));
    }
    #[test] fn root_folder_prefix_still_enforces_depth() {
        let (_root, vault) = vault();
        let bundle = resolve(&vault, request(vec![folder(".")], Some(Options { max_depth: Some(1), ..Default::default() })));
        assert!(bundle.skipped.iter().any(|s| matches!(s.reason, SkipReason::DepthExceeded)), "depth must count from the vault root for a '.' prefix");
    }
    #[test] fn caps_skipped_entries() {
        let (root, vault) = vault();
        for i in 0..(MENTION_MAX_SKIPPED + 20) { std::fs::write(root.join("docs").join(format!("img{i}.png")), "x").unwrap(); }
        let bundle = resolve(&vault, request(vec![folder("docs")], None));
        assert!(bundle.skipped.len() <= MENTION_MAX_SKIPPED, "skipped must stay bounded");
    }
    #[test] fn truncates_and_enforces_file_and_depth_budgets() {
        let (_root, vault) = vault();
        std::fs::write(vault.root().join("docs/a.md"), "a".repeat(100)).unwrap();
        let limited = resolve(&vault, request(vec![folder("docs")], Some(Options { max_file_chars: Some(40), max_files: Some(1), max_depth: Some(8), ..Default::default() })));
        assert!(limited.files[0].truncated);
        assert!(limited.files[0].content.contains("truncated"));
        assert!(limited.skipped.iter().any(|s| matches!(s.reason, SkipReason::Budget)));
        let depth_limited = resolve(&vault, request(vec![folder("docs")], Some(Options { max_depth: Some(1), ..Default::default() })));
        assert!(depth_limited.skipped.iter().any(|s| matches!(s.reason, SkipReason::DepthExceeded)));
    }
}
