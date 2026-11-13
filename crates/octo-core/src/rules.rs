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

/// What a rule looks for.
#[derive(Debug, Clone, Default)]
pub struct Criteria {
    /// `;`-separated name patterns; empty matches every file.
    pub patterns: String,
    /// Last changed more than this many days ago.
    pub older_than_days: u32,
    /// When set, also last changed no more than this many days ago.
    pub newer_than_days: Option<u32>,
    /// At least this many bytes (0: any size).
    pub min_size_bytes: u64,
    pub recursive: bool,
}

/// Files directly in `folder` (or below it when `recursive`) that fit `criteria` as of `now_ms`. Links are skipped.
pub fn find(folder: &Path, criteria: &Criteria, now_ms: i64) -> Vec<Match> {
    let mut out = Vec::new();
    walk(folder, criteria, now_ms, &mut out);
    out.sort_by_key(|m| std::cmp::Reverse(m.size));
    out
}

fn walk(dir: &Path, c: &Criteria, now_ms: i64, out: &mut Vec<Match>) {
    let cutoff = now_ms - i64::from(c.older_than_days) * DAY_MS;
    let newest = c.newer_than_days.map(|d| now_ms - i64::from(d) * DAY_MS);
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
            if c.recursive {
                walk(&path, c, now_ms, out);
            }
            continue;
        }
        if meta.len() < c.min_size_bytes || !name_matches(&c.patterns, &entry.file_name().to_string_lossy()) {
            continue;
        }
        let modified_ms = meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64);
        if modified_ms > cutoff || newest.is_some_and(|n| modified_ms < n) {
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

        let crit = |patterns: &str, older: u32, recursive: bool| Criteria { patterns: patterns.into(), older_than_days: older, recursive, ..Criteria::default() };
        // Fresh files are "older than 0 days" once time has passed, but not older than 30 days.
        assert!(find(&base, &crit("*.pdf", 30, true), now).is_empty());
        let later = now + 31 * DAY_MS;
        let top = find(&base, &crit("*.pdf", 30, false), later);
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].size, 5);
        let deep = find(&base, &crit("*.pdf", 30, true), later);
        assert_eq!(deep.len(), 2);
        assert_eq!(deep[0].size, 5, "largest first");
        // A minimum size drops the small one.
        let big = Criteria { min_size_bytes: 3, ..crit("*.pdf", 30, true) };
        assert_eq!(find(&base, &big, later).len(), 1);
        // Between 30 and 40 days old: found at day 35, too old to count as "newer than 40" at day 80.
        let window = Criteria { newer_than_days: Some(40), ..crit("*.pdf", 30, true) };
        assert_eq!(find(&base, &window, now + 35 * DAY_MS).len(), 2);
        assert!(find(&base, &window, now + 80 * DAY_MS).is_empty());
        let _ = std::fs::remove_dir_all(base);
    }
}
