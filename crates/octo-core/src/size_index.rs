//! A live index of folder sizes.
//!
//! Every scanned folder keeps a small record: the bytes and file count of the files directly inside it,
//! and the names of its subfolders. A folder's total is its own files plus the totals of its subfolders,
//! worked out on demand. When something changes on disk only that one folder is read again, so a file
//! change deep in a tree costs one small directory read instead of a rescan of the whole tree.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rayon::prelude::*;

use crate::entry::{EntryKind, attrs};
use crate::ops::CancelToken;
use crate::sizes::FolderSize;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct DirRecord {
    /// Files directly inside this folder.
    own: FolderSize,
    /// Subfolder names, as spelled on disk. Junctions and symlinked folders are not included.
    subdirs: Vec<String>,
}

#[derive(Default)]
pub struct SizeIndex {
    dirs: Mutex<HashMap<String, DirRecord>>,
}

/// Case-insensitive key for a folder path, without a trailing separator.
pub fn key_of(path: &Path) -> String {
    let s = path.to_string_lossy().replace('/', "\\");
    let trimmed = s.trim_end_matches('\\');
    // Keep "C:" distinct from "C:\" being empty: a drive root's key is "c:".
    trimmed.to_lowercase()
}

/// Reads one folder without descending: its own files and its subfolder names.
fn read_dir_record(dir: &Path) -> Option<DirRecord> {
    let mut rec = DirRecord::default();
    crate::enumerate_dir(dir, |e| {
        if e.kind == EntryKind::Dir {
            if e.attrs & attrs::REPARSE_POINT == 0 {
                rec.subdirs.push(String::from_utf16_lossy(e.name));
            }
        } else {
            rec.own.bytes += e.size;
            rec.own.files += 1;
        }
    })
    .ok()?;
    Some(rec)
}

impl SizeIndex {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, DirRecord>> {
        self.dirs.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Reads `dir` and everything below it, replacing what the index knew, and returns the total.
    /// Unreadable folders count as empty. Stops early (returning what it has) when cancelled.
    pub fn scan(&self, dir: &Path, cancel: &CancelToken) -> FolderSize {
        if cancel.is_cancelled() {
            return FolderSize::default();
        }
        let rec = read_dir_record(dir).unwrap_or_default();
        let own = rec.own;
        let subdirs = rec.subdirs.clone();
        self.lock().insert(key_of(dir), rec);
        let below = subdirs
            .par_iter()
            .map(|name| self.scan(&dir.join(name), cancel))
            .reduce(FolderSize::default, |a, b| FolderSize { bytes: a.bytes + b.bytes, files: a.files + b.files });
        FolderSize { bytes: own.bytes + below.bytes, files: own.files + below.files }
    }

    /// The total for `dir`, when it and every folder below it are in the index.
    pub fn total(&self, dir: &Path) -> Option<FolderSize> {
        let map = self.lock();
        total_in(&map, dir)
    }

    /// Totals already in the index for direct subfolders of `dir`, using memory only.
    pub fn cached_children(&self, dir: &Path) -> Vec<(String, FolderSize)> {
        let map = self.lock();
        let parent_key = key_of(dir);
        if let Some(rec) = map.get(&parent_key) {
            return rec
                .subdirs
                .iter()
                .filter_map(|name| total_in(&map, &dir.join(name)).map(|size| (name.clone(), size)))
                .collect();
        }
        let prefix = format!("{parent_key}\\");
        map.keys()
            .filter_map(|k| {
                let rest = k.strip_prefix(&prefix)?;
                if rest.is_empty() || rest.contains('\\') {
                    return None;
                }
                total_in(&map, &dir.join(rest)).map(|size| (rest.to_string(), size))
            })
            .collect()
    }

    /// Snapshot of indexed folders up to `max_depth` levels beneath `dir`, from memory only.
    /// Each entry is `(relative_lowercase_path, total_size, exact_child_names)`.
    pub fn snapshot_under(&self, dir: &Path, max_depth: usize) -> Vec<(String, FolderSize, Vec<String>)> {
        let map = self.lock();
        let root_key = key_of(dir);
        let prefix = format!("{root_key}\\");
        let mut memo: HashMap<String, Option<FolderSize>> = HashMap::new();
        let mut out = Vec::new();
        for (k, rec) in map.iter() {
            let rel = if k == &root_key {
                ""
            } else if let Some(rest) = k.strip_prefix(&prefix) {
                if rest.is_empty() || rest.matches('\\').count() >= max_depth {
                    continue;
                }
                rest
            } else {
                continue;
            };
            if let Some(total) = total_memo(&map, k, &mut memo) {
                out.push((rel.to_string(), total, rec.subdirs.clone()));
            }
        }
        out
    }

    pub fn contains(&self, dir: &Path) -> bool {
        self.lock().contains_key(&key_of(dir))
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    pub fn clear(&self) {
        self.lock().clear();
    }

    /// Drops `dir` and everything below it.
    pub fn forget(&self, dir: &Path) {
        let mut map = self.lock();
        forget_in(&mut map, dir);
    }

    /// Reads `dir` again after a change. New subfolders are scanned in full, vanished ones are dropped.
    /// A folder that no longer exists is forgotten. Returns true when the index changed.
    pub fn refresh_dir(&self, dir: &Path, cancel: &CancelToken) -> bool {
        let Some(fresh) = read_dir_record(dir) else {
            let known = self.contains(dir);
            self.forget(dir);
            return known;
        };
        let old = self.lock().get(&key_of(dir)).cloned();
        let old_subdirs = old.as_ref().map(|r| r.subdirs.clone()).unwrap_or_default();
        let key_set = |names: &[String]| names.iter().map(|n| n.to_lowercase()).collect::<std::collections::HashSet<_>>();
        let (old_set, new_set) = (key_set(&old_subdirs), key_set(&fresh.subdirs));
        let changed = old.as_ref() != Some(&fresh);
        for gone in old_subdirs.iter().filter(|n| !new_set.contains(&n.to_lowercase())) {
            self.forget(&dir.join(gone));
        }
        self.lock().insert(key_of(dir), fresh.clone());
        for added in fresh.subdirs.iter().filter(|n| !old_set.contains(&n.to_lowercase())) {
            self.scan(&dir.join(added), cancel);
        }
        changed
    }

    /// The folder to read again for a change at `path`: the path itself when it is a folder the
    /// index knows, otherwise its parent.
    pub fn dirty_dir(&self, path: &Path) -> Option<PathBuf> {
        if self.contains(path) {
            return Some(path.to_path_buf());
        }
        path.parent().map(Path::to_path_buf)
    }
}

fn total_memo(map: &HashMap<String, DirRecord>, key: &str, memo: &mut HashMap<String, Option<FolderSize>>) -> Option<FolderSize> {
    if let Some(&cached) = memo.get(key) {
        return cached;
    }
    let res = (|| {
        let rec = map.get(key)?;
        let mut total = rec.own;
        for name in &rec.subdirs {
            let child_key = format!("{key}\\{}", name.to_lowercase());
            let below = total_memo(map, &child_key, memo)?;
            total.bytes += below.bytes;
            total.files += below.files;
        }
        Some(total)
    })();
    memo.insert(key.to_string(), res);
    res
}

fn total_in(map: &HashMap<String, DirRecord>, dir: &Path) -> Option<FolderSize> {
    let rec = map.get(&key_of(dir))?;
    let mut total = rec.own;
    for name in &rec.subdirs {
        let below = total_in(map, &dir.join(name))?;
        total.bytes += below.bytes;
        total.files += below.files;
    }
    Some(total)
}

fn forget_in(map: &mut HashMap<String, DirRecord>, dir: &Path) {
    if let Some(rec) = map.remove(&key_of(dir)) {
        for name in rec.subdirs {
            forget_in(map, &dir.join(name));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("a/deep")).unwrap();
        fs::write(tmp.path().join("a/x"), vec![0u8; 100]).unwrap();
        fs::write(tmp.path().join("a/deep/y"), vec![0u8; 50]).unwrap();
        fs::write(tmp.path().join("top"), vec![0u8; 7]).unwrap();
        tmp
    }

    #[test]
    fn scan_totals_match_the_tree() {
        let tmp = fixture();
        let index = SizeIndex::default();
        let total = index.scan(tmp.path(), &CancelToken::default());
        assert_eq!(total, FolderSize { bytes: 157, files: 3 });
        assert_eq!(index.total(&tmp.path().join("a")), Some(FolderSize { bytes: 150, files: 2 }));
        assert_eq!(index.total(&tmp.path().join("A\\DEEP")), Some(FolderSize { bytes: 50, files: 1 }));
        assert_eq!(index.total(&tmp.path().join("missing")), None);
    }

    #[test]
    fn a_deep_change_reads_only_that_folder() {
        let tmp = fixture();
        let index = SizeIndex::default();
        index.scan(tmp.path(), &CancelToken::default());
        fs::write(tmp.path().join("a/deep/z"), vec![0u8; 1000]).unwrap();

        // Stale until the changed folder is read again.
        assert_eq!(index.total(&tmp.path().join("a")).unwrap().bytes, 150);
        assert!(index.refresh_dir(&tmp.path().join("a/deep"), &CancelToken::default()));
        assert_eq!(index.total(&tmp.path().join("a")), Some(FolderSize { bytes: 1150, files: 3 }));
        // Nothing changed the second time.
        assert!(!index.refresh_dir(&tmp.path().join("a/deep"), &CancelToken::default()));
    }

    #[test]
    fn new_and_removed_folders_are_followed() {
        let tmp = fixture();
        let index = SizeIndex::default();
        index.scan(tmp.path(), &CancelToken::default());

        fs::create_dir_all(tmp.path().join("b/inner")).unwrap();
        fs::write(tmp.path().join("b/inner/f"), vec![0u8; 20]).unwrap();
        index.refresh_dir(tmp.path(), &CancelToken::default());
        assert_eq!(index.total(&tmp.path().join("b")), Some(FolderSize { bytes: 20, files: 1 }));

        fs::remove_dir_all(tmp.path().join("a")).unwrap();
        index.refresh_dir(tmp.path(), &CancelToken::default());
        assert!(!index.contains(&tmp.path().join("a")));
        assert!(!index.contains(&tmp.path().join("a/deep")));
        assert_eq!(index.total(tmp.path()), Some(FolderSize { bytes: 27, files: 2 }));
    }

    #[test]
    fn a_deleted_folder_is_forgotten_when_refreshed() {
        let tmp = fixture();
        let index = SizeIndex::default();
        index.scan(tmp.path(), &CancelToken::default());
        fs::remove_dir_all(tmp.path().join("a/deep")).unwrap();
        assert!(index.refresh_dir(&tmp.path().join("a/deep"), &CancelToken::default()));
        assert!(!index.contains(&tmp.path().join("a/deep")));
    }

    #[test]
    fn dirty_dir_prefers_a_known_folder_else_the_parent() {
        let tmp = fixture();
        let index = SizeIndex::default();
        index.scan(tmp.path(), &CancelToken::default());
        assert_eq!(index.dirty_dir(&tmp.path().join("a")), Some(tmp.path().join("a")));
        assert_eq!(index.dirty_dir(&tmp.path().join("a/x")), Some(tmp.path().join("a")));
    }

    #[test]
    fn keys_ignore_case_and_trailing_separators() {
        assert_eq!(key_of(Path::new("C:\\Users\\Me\\")), key_of(Path::new("c:/users/me")));
    }

    #[test]
    fn cached_children_reads_direct_subfolders_from_memory() {
        let tmp = fixture();
        let index = SizeIndex::default();
        // Scan only subfolder "a", leaving the parent unscanned.
        index.scan(&tmp.path().join("a"), &CancelToken::default());
        assert_eq!(index.cached_children(tmp.path()), vec![("a".to_string(), FolderSize { bytes: 150, files: 2 })]);

        // Once the parent itself is scanned, cached_children still returns direct subfolders.
        index.scan(tmp.path(), &CancelToken::default());
        assert_eq!(index.cached_children(tmp.path()), vec![("a".to_string(), FolderSize { bytes: 150, files: 2 })]);
        assert_eq!(index.cached_children(&tmp.path().join("a")), vec![("deep".to_string(), FolderSize { bytes: 50, files: 1 })]);

        let snap = index.snapshot_under(tmp.path(), 2);
        assert!(snap.iter().any(|(rel, s, _)| rel.is_empty() && s.bytes == 157));
        assert!(snap.iter().any(|(rel, s, _)| rel == "a" && s.bytes == 150));
        assert!(snap.iter().any(|(rel, s, _)| rel == "a\\deep" && s.bytes == 50));
    }
}
