//! Folder rules: find the files in a folder that match name patterns and are old enough.
//!
//! This only finds files. Moving or deleting them goes through the normal operations
//! engine, so every rule run has progress, conflict handling and undo.

use std::path::{Path, PathBuf};

/// A file a rule would act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Match {
    pub path: PathBuf,
    pub size: u64,
    pub modified_ms: i64,
}

/// `*` and `?` wildcards, case-insensitive, matching the whole name.
pub fn glob_match(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let n: Vec<char> = name.to_lowercase().chars().collect();
    let (mut pi, mut ni) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Whether `name` matches any of the `;`-separated patterns. An empty list matches everything.
pub fn name_matches(patterns: &str, name: &str) -> bool {
    let list: Vec<&str> = patterns.split(';').map(str::trim).filter(|p| !p.is_empty()).collect();
    list.is_empty() || list.iter().any(|p| glob_match(p, name))
}

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Hard ceiling so a rule on a huge tree can't run away.
pub const MAX_MATCHES: usize = 5000;

/// Files directly in `folder` (or below it when `recursive`) that match `patterns` and were last
/// changed more than `older_than_days` days before `now_ms`. Links are skipped.
pub fn find(folder: &Path, patterns: &str, older_than_days: u32, recursive: bool, now_ms: i64) -> Vec<Match> {
    let mut out = Vec::new();
    let cutoff = now_ms - i64::from(older_than_days) * DAY_MS;
    walk(folder, patterns, cutoff, recursive, &mut out);
    out.sort_by_key(|m| std::cmp::Reverse(m.size));
    out
}

fn walk(dir: &Path, patterns: &str, cutoff: i64, recursive: bool, out: &mut Vec<Match>) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        if out.len() >= MAX_MATCHES {
            return;
        }
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            if recursive {
                walk(&path, patterns, cutoff, recursive, out);
            }
            continue;
        }
        if !name_matches(patterns, &entry.file_name().to_string_lossy()) {
            continue;
        }
        let modified_ms = meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64);
        if modified_ms > cutoff {
            continue;
        }
        out.push(Match { path, size: meta.len(), modified_ms });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globs_match_whole_names_without_case() {
        assert!(glob_match("*.PDF", "report.pdf"));
        assert!(glob_match("img_??.jpg", "IMG_01.jpg"));
        assert!(!glob_match("*.pdf", "report.pdf.bak"));
        assert!(glob_match("*", "anything"));
        assert!(!glob_match("a*b", "ac"));
    }

    #[test]
    fn pattern_lists_and_empty_lists() {
        assert!(name_matches("*.jpg; *.png", "a.PNG"));
        assert!(!name_matches("*.jpg; *.png", "a.gif"));
        assert!(name_matches("", "whatever"));
    }

    #[test]
    fn finds_old_matching_files_only() {
        let base = std::env::temp_dir().join(format!("octopolis-rules-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("sub")).unwrap();
        std::fs::write(base.join("a.pdf"), b"12345").unwrap();
        std::fs::write(base.join("b.txt"), b"1").unwrap();
        std::fs::write(base.join("sub").join("c.pdf"), b"12").unwrap();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;

        // Fresh files are "older than 0 days" once time has passed, but not older than 30 days.
        assert!(find(&base, "*.pdf", 30, true, now).is_empty());
        let later = now + 31 * DAY_MS;
        let top = find(&base, "*.pdf", 30, false, later);
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].size, 5);
        let deep = find(&base, "*.pdf", 30, true, later);
        assert_eq!(deep.len(), 2);
        assert_eq!(deep[0].size, 5, "largest first");
        let _ = std::fs::remove_dir_all(base);
    }
}
