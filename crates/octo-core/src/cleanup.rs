//! Cleanup assistant: what's taking space under a folder, and what can go.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;

use crate::entry::EntryKind;
use crate::error::Result;
use crate::ops::CancelToken;
use crate::search::index::{Index, ROOT};

/// Folders that tools recreate on demand (dependencies, build output, caches).
pub const JUNK_DIRS: &[&str] = &["node_modules", "target", "__pycache__", ".pytest_cache", ".mypy_cache", ".gradle", ".cache", ".next", ".parcel-cache", ".turbo"];
/// Leftover temporary and system files.
const TEMP_EXTS: &[&str] = &["tmp", "temp", "bak", "dmp", "old"];
const TEMP_NAMES: &[&str] = &["thumbs.db", "desktop.ini", ".ds_store"];

const LARGEST: usize = 50;
const OLD_LARGE_BYTES: u64 = 50 * 1024 * 1024;
const YEAR_MS: i64 = 365 * 24 * 60 * 60 * 1000;
/// OneDrive online-only files take no space here.
const ONLINE_ATTRS: u32 = 0x0040_0000 | 0x0004_0000 | 0x1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub path: PathBuf,
    pub size: u64,
    pub modified_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub total_bytes: u64,
    pub largest: Vec<Item>,
    /// Big files not changed for over a year.
    pub old_large: Vec<Item>,
    /// Folders with nothing in them (at any depth).
    pub empty_dirs: Vec<Item>,
    /// Regenerable folders, with their total size.
    pub junk_dirs: Vec<Item>,
    pub temp_files: Vec<Item>,
}

fn is_temp(name: &str) -> bool {
    let lower = name.to_lowercase();
    TEMP_NAMES.contains(&lower.as_str()) || lower.starts_with("~$") || lower.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && TEMP_EXTS.contains(&ext))
}

/// Scans `root`. `now_ms` decides what counts as old.
pub fn scan(root: &Path, now_ms: i64, cancel: &CancelToken) -> Result<Report> {
    let ix = crate::search::walk::build(root, cancel, &AtomicU64::new(0))?;
    Ok(report(&ix, now_ms))
}

pub fn report(ix: &Index, now_ms: i64) -> Report {
    let n = ix.len();
    // Recursive size and file count per folder, children before parents
    // (a walk pushes every entry after its parent, so going backwards works).
    let mut size = vec![0u64; n];
    let mut files = vec![0u64; n];
    for i in (0..n).rev() {
        if ix.kinds[i] == EntryKind::File {
            size[i] = if ix.sizes[i] == u64::MAX || ix.attrs[i] & ONLINE_ATTRS != 0 { 0 } else { ix.sizes[i] };
            files[i] = 1;
        }
        let p = ix.parents[i];
        if p != ROOT {
            size[p as usize] += size[i];
            files[p as usize] += files[i];
        }
    }
    let item = |i: usize| Item { path: ix.full_path(i as u32), size: size[i], modified_ms: ix.modified_ms[i] };
    let inside_junk = |mut i: u32| {
        // True when an ancestor is a junk folder (it is reported as one item instead).
        while ix.parents[i as usize] != ROOT {
            i = ix.parents[i as usize];
            if JUNK_DIRS.contains(&ix.names[i as usize].to_lowercase().as_str()) {
                return true;
            }
        }
        false
    };

    let mut r = Report::default();
    let mut file_ids: Vec<usize> = Vec::new();
    for i in 0..n {
        if ix.parents[i] == ROOT {
            r.total_bytes += size[i];
        }
        let name = &*ix.names[i];
        if ix.kinds[i] == EntryKind::Dir {
            if JUNK_DIRS.contains(&name.to_lowercase().as_str()) && !inside_junk(i as u32) {
                r.junk_dirs.push(item(i));
            } else if files[i] == 0 && !inside_junk(i as u32) {
                // Only the outermost empty folder of a chain is listed.
                let parent_empty = ix.parents[i] != ROOT && files[ix.parents[i] as usize] == 0;
                if !parent_empty {
                    r.empty_dirs.push(item(i));
                }
            }
            continue;
        }
        if inside_junk(i as u32) || size[i] == 0 {
            continue;
        }
        file_ids.push(i);
        if is_temp(name) {
            r.temp_files.push(item(i));
        }
        if size[i] >= OLD_LARGE_BYTES && ix.modified_ms[i] > 0 && now_ms - ix.modified_ms[i] > YEAR_MS {
            r.old_large.push(item(i));
        }
    }
    file_ids.sort_unstable_by_key(|&i| std::cmp::Reverse(size[i]));
    r.largest = file_ids.into_iter().take(LARGEST).map(item).collect();
    for list in [&mut r.old_large, &mut r.junk_dirs, &mut r.temp_files] {
        list.sort_by_key(|x| std::cmp::Reverse(x.size));
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_junk_empty_old_and_temp() {
        let mut ix = Index::new(PathBuf::from(r"C:\p"));
        let now = 2_000_000_000_000;
        let old = now - 2 * YEAR_MS;
        let app = ix.push("app", ROOT, EntryKind::Dir, 0, 0, now);
        let nm = ix.push("node_modules", app, EntryKind::Dir, 0, 0, now);
        let pkg = ix.push("pkg", nm, EntryKind::Dir, 0, 0, now);
        ix.push("index.js", pkg, EntryKind::File, 0, 3_000, now);
        ix.push("main.js", app, EntryKind::File, 0, 100, now);
        let empty = ix.push("empty", ROOT, EntryKind::Dir, 0, 0, now);
        ix.push("deeper", empty, EntryKind::Dir, 0, 0, now);
        ix.push("video.mkv", ROOT, EntryKind::File, 0, 60 * 1024 * 1024, old);
        ix.push("~$report.docx", ROOT, EntryKind::File, 0, 10, now);
        ix.push("online.iso", ROOT, EntryKind::File, 0x0040_0000, 9_000_000_000, old);

        let r = report(&ix, now);
        let names = |v: &[Item]| v.iter().map(|i| i.path.file_name().unwrap().to_string_lossy().into_owned()).collect::<Vec<_>>();
        assert_eq!(names(&r.junk_dirs), vec!["node_modules"]);
        assert_eq!(r.junk_dirs[0].size, 3_000);
        assert_eq!(names(&r.empty_dirs), vec!["empty"], "only the outer empty folder");
        assert_eq!(names(&r.old_large), vec!["video.mkv"], "online-only files take no space here");
        assert_eq!(names(&r.temp_files), vec!["~$report.docx"]);
        assert_eq!(names(&r.largest)[0], "video.mkv");
        assert!(!names(&r.largest).contains(&"index.js".to_string()), "junk contents are counted in the junk folder");
        assert_eq!(r.total_bytes, 3_000 + 100 + 60 * 1024 * 1024 + 10);
    }

    #[test]
    fn recognises_temp_names() {
        assert!(is_temp("Thumbs.db") && is_temp("x.TMP") && is_temp("~$doc.xlsx"));
        assert!(!is_temp("notes.txt") && !is_temp(".tmp"));
    }
}
