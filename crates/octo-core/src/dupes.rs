//! Duplicate finder: files with identical contents under a folder.
//! Size buckets first (free), then a hash of the first 64 KB, then the full
//! BLAKE3 hash, so only real candidates are read completely.

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rayon::prelude::*;

use crate::entry::EntryKind;
use crate::error::Result;
use crate::ops::CancelToken;

const HEAD_BYTES: usize = 64 * 1024;
/// OneDrive online-only and links: never read (it would download them, or follow a link twice).
const SKIP_ATTRS: u32 = 0x0040_0000 | 0x0004_0000 | 0x1000 | 0x400;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DupeFile {
    pub path: PathBuf,
    pub modified_ms: i64,
}

/// Files with the same contents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DupeGroup {
    pub size: u64,
    /// Newest first.
    pub files: Vec<DupeFile>,
}

impl DupeGroup {
    /// Space freed by keeping just one copy.
    pub fn wasted(&self) -> u64 {
        self.size * (self.files.len() as u64 - 1)
    }
}

fn hash(path: &Path, limit: Option<usize>, cancel: &CancelToken, read: &AtomicU64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut left = limit.unwrap_or(usize::MAX);
    while left > 0 {
        if cancel.is_cancelled() {
            return None;
        }
        let want = buf.len().min(left);
        let n = file.read(&mut buf[..want]).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        read.fetch_add(n as u64, Ordering::Relaxed);
        left -= n;
    }
    Some(hasher.finalize().to_hex().to_string())
}

/// Keeps only groups of two or more, splitting each group further by `key`.
fn refine<K: std::hash::Hash + Eq + Send>(groups: Vec<Vec<usize>>, key: impl Fn(usize) -> Option<K> + Sync) -> Vec<Vec<usize>> {
    groups
        .into_par_iter()
        .flat_map(|g| {
            let mut by: HashMap<K, Vec<usize>> = HashMap::new();
            for (i, k) in g.into_iter().filter_map(|i| key(i).map(|k| (i, k))) {
                by.entry(k).or_default().push(i);
            }
            by.into_values().filter(|v| v.len() > 1).collect::<Vec<_>>()
        })
        .collect()
}

/// Finds duplicate files of at least `min_size` bytes under `root`.
/// `on_progress(bytes_read, bytes_to_read)` is called from worker threads.
pub fn find(root: &Path, min_size: u64, cancel: &CancelToken, on_progress: &(dyn Fn(u64, u64) + Sync)) -> Result<Vec<DupeGroup>> {
    let scanned = AtomicU64::new(0);
    // A plain walk: the NTFS journal index has no file sizes.
    let ix = crate::search::walk::build(root, cancel, &scanned)?;
    let mut by_size: HashMap<u64, Vec<usize>> = HashMap::new();
    for i in 0..ix.len() {
        let size = ix.sizes[i];
        if ix.kinds[i] == EntryKind::File && size >= min_size.max(1) && size != u64::MAX && ix.attrs[i] & SKIP_ATTRS == 0 {
            by_size.entry(size).or_default().push(i);
        }
    }
    let candidates: Vec<Vec<usize>> = by_size.into_values().filter(|v| v.len() > 1).collect();
    let total: u64 = candidates.iter().flatten().map(|&i| ix.sizes[i]).sum();
    let read = AtomicU64::new(0);
    let report = || on_progress(read.load(Ordering::Relaxed), total);
    let path = |i: usize| ix.full_path(i as u32);

    let heads = refine(candidates, |i| {
        let h = hash(&path(i), Some(HEAD_BYTES), cancel, &read);
        report();
        h
    });
    let full = refine(heads, |i| {
        // Small files were already read completely by the first pass.
        let h = if ix.sizes[i] as usize <= HEAD_BYTES { hash(&path(i), Some(HEAD_BYTES), cancel, &AtomicU64::new(0)) } else { hash(&path(i), None, cancel, &read) };
        report();
        h
    });
    if cancel.is_cancelled() {
        return Ok(Vec::new());
    }
    let mut groups: Vec<DupeGroup> = full
        .into_iter()
        .map(|g| {
            let mut files: Vec<DupeFile> = g.iter().map(|&i| DupeFile { path: path(i), modified_ms: ix.modified_ms[i] }).collect();
            files.sort_by_key(|f| std::cmp::Reverse(f.modified_ms));
            DupeGroup { size: ix.sizes[g[0]], files }
        })
        .collect();
    groups.sort_by_key(|g| std::cmp::Reverse(g.wasted()));
    Ok(groups)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_identical_files_and_ignores_lookalikes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir(root.join("sub")).unwrap();
        let big: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(root.join("a.bin"), &big).unwrap();
        std::fs::write(root.join("sub/a copy.bin"), &big).unwrap();
        // Same size and same first 64 KB, different ending: not a duplicate.
        let mut almost = big.clone();
        *almost.last_mut().unwrap() ^= 1;
        std::fs::write(root.join("almost.bin"), &almost).unwrap();
        std::fs::write(root.join("x.txt"), b"same").unwrap();
        std::fs::write(root.join("y.txt"), b"same").unwrap();
        std::fs::write(root.join("z.txt"), b"diff").unwrap();
        std::fs::write(root.join("empty1"), b"").unwrap();
        std::fs::write(root.join("empty2"), b"").unwrap();

        let groups = find(root, 1, &CancelToken::default(), &|_, _| {}).unwrap();
        assert_eq!(groups.len(), 2, "{groups:?}");
        assert_eq!(groups[0].size, 200_000, "the biggest waste comes first");
        let names: Vec<String> = groups[0].files.iter().map(|f| f.path.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert!(names.contains(&"a.bin".into()) && names.contains(&"a copy.bin".into()) && !names.contains(&"almost.bin".into()));
        assert_eq!(groups[1].files.len(), 2);
        assert_eq!(groups[0].wasted(), 200_000);

        assert_eq!(find(root, 1_000, &CancelToken::default(), &|_, _| {}).unwrap().len(), 1, "min size skips small files");
    }
}
