//! Repository paths on the newline-delimited status wire.
//!
//! Status lines are `XY path`, one per line, and the UI hands the path back
//! verbatim to stage and diff. A path that cannot survive that round trip —
//! not UTF-8, a control character (a newline would split the line), or edge
//! whitespace the transport trims — is C-quoted the way `git status` does it:
//! `"a\nb.md"`, with invalid bytes as `\ooo` octal. Readable Unicode names are
//! left alone. Commands accept both forms and decode a quoted one back to its
//! exact bytes.

use std::path::{Component, PathBuf};

/// Wire form of a repository path: unchanged when it round-trips, else quoted.
pub(crate) fn quote_path(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) if !needs_quote(text) => text.to_string(),
        _ => {
            let mut out = String::with_capacity(bytes.len() + 2);
            out.push('"');
            for chunk in bytes.utf8_chunks() {
                for c in chunk.valid().chars() {
                    match c {
                        '"' => out.push_str("\\\""),
                        '\\' => out.push_str("\\\\"),
                        '\n' => out.push_str("\\n"),
                        '\t' => out.push_str("\\t"),
                        '\r' => out.push_str("\\r"),
                        c if c.is_ascii_control() => push_octal(&mut out, c as u8),
                        c => out.push(c),
                    }
                }
                for &byte in chunk.invalid() {
                    push_octal(&mut out, byte);
                }
            }
            out.push('"');
            out
        }
    }
}

fn needs_quote(text: &str) -> bool {
    text.starts_with(char::is_whitespace)
        || text.ends_with(char::is_whitespace)
        || text
            .chars()
            .any(|c| c.is_ascii_control() || c == '"' || c == '\\')
}

fn push_octal(out: &mut String, byte: u8) {
    out.push_str(&format!("\\{byte:03o}"));
}

/// Decode a quoted wire path; `None` when `input` is not in quoted form.
fn unquote(input: &str) -> Option<Vec<u8>> {
    let inner = input.strip_prefix('"')?.strip_suffix('"')?;
    let mut bytes = Vec::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            let mut buffer = [0u8; 4];
            bytes.extend_from_slice(c.encode_utf8(&mut buffer).as_bytes());
            continue;
        }
        match chars.next()? {
            '"' => bytes.push(b'"'),
            '\\' => bytes.push(b'\\'),
            'n' => bytes.push(b'\n'),
            't' => bytes.push(b'\t'),
            'r' => bytes.push(b'\r'),
            'a' => bytes.push(0x07),
            'b' => bytes.push(0x08),
            'f' => bytes.push(0x0c),
            'v' => bytes.push(0x0b),
            first @ '0'..='3' => {
                let mut value = first.to_digit(8)?;
                for _ in 0..2 {
                    value = value * 8 + chars.next()?.to_digit(8)?;
                }
                bytes.push(value as u8);
            }
            _ => return None,
        }
    }
    Some(bytes)
}

/// Repository-relative path from IPC input (plain or quoted). Rejects empty,
/// absolute, and `..`/`.` paths so a command can never leave the worktree.
pub(crate) fn repo_relative(input: &str) -> Result<PathBuf, String> {
    let bytes = match unquote(input) {
        Some(bytes) => bytes,
        None if input.starts_with('"') => return Err("Invalid quoted path".into()),
        None => input.as_bytes().to_vec(),
    };
    let path = bytes_to_path(bytes)?;
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Invalid repository-relative path".into());
    }
    Ok(path)
}

#[cfg(unix)]
fn bytes_to_path(bytes: Vec<u8>) -> Result<PathBuf, String> {
    use std::os::unix::ffi::OsStringExt;
    Ok(PathBuf::from(std::ffi::OsString::from_vec(bytes)))
}

#[cfg(not(unix))]
fn bytes_to_path(bytes: Vec<u8>) -> Result<PathBuf, String> {
    String::from_utf8(bytes)
        .map(PathBuf::from)
        .map_err(|_| "Path is not valid UTF-8".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_and_unicode_paths_stay_readable() {
        assert_eq!(quote_path(b"notes/a b.md"), "notes/a b.md");
        assert_eq!(quote_path("catatan/café.md".as_bytes()), "catatan/café.md");
    }

    #[test]
    fn unsafe_paths_are_quoted_and_round_trip() {
        let cases: [&[u8]; 6] = [
            b"a\nb.md",
            b"tab\there.md",
            b"say \"hi\".md",
            b"back\\slash.md",
            b" padded.md ",
            b"caf\xe9.md",
        ];
        for bytes in cases {
            let quoted = quote_path(bytes);
            assert!(quoted.starts_with('"') && quoted.ends_with('"'), "{quoted}");
            assert!(!quoted.contains('\n'), "{quoted}");
            assert_eq!(unquote(&quoted).unwrap(), bytes, "{quoted}");
        }
        assert_eq!(quote_path(b"caf\xe9.md"), "\"caf\\351.md\"");
        assert_eq!(quote_path(b"a\nb.md"), "\"a\\nb.md\"");
    }

    #[test]
    fn repo_relative_accepts_both_forms_and_rejects_escapes() {
        assert_eq!(repo_relative("a.md").unwrap(), PathBuf::from("a.md"));
        assert_eq!(
            repo_relative("\"a\\nb.md\"").unwrap(),
            PathBuf::from("a\nb.md")
        );
        assert!(repo_relative("").is_err());
        assert!(repo_relative("../x.md").is_err());
        assert!(repo_relative("/etc/passwd").is_err());
        assert!(repo_relative("\"..\"").is_err());
        assert!(repo_relative("\"broken\\q\"").is_err());
    }
}
