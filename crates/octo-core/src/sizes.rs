//! Recursive folder sizes for the size column and the treemap.

use std::path::Path;

use rayon::prelude::*;

use crate::entry::{EntryKind, attrs};
use crate::error::Result;
use crate::ops::CancelToken;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FolderSize {
    pub bytes: u64,
    pub files: u64,
}

impl FolderSize {
    fn add(self, o: FolderSize) -> FolderSize {
        FolderSize { bytes: self.bytes + o.bytes, files: self.files + o.files }
    }
}

/// Total size of a folder tree. Unreadable folders count as empty and
/// junctions are not entered.
pub fn folder_size(dir: &Path, cancel: &CancelToken) -> FolderSize {
    if cancel.is_cancelled() {
        return FolderSize::default();
    }
    let mut here = FolderSize::default();
    let mut subdirs: Vec<String> = Vec::new();
    let _ = crate::enumerate_dir(dir, |e| {
        if e.kind == EntryKind::Dir {
            if e.attrs & attrs::REPARSE_POINT == 0 {
                subdirs.push(String::from_utf16_lossy(e.name));
            }
        } else {
            here.bytes += e.size;
            here.files += 1;
        }
    });
    subdirs.par_iter().map(|d| folder_size(&dir.join(d), cancel)).reduce(FolderSize::default, FolderSize::add).add(here)
}

/// Computes the size of each direct subfolder of `dir`, calling `on_size` as
/// each finishes.
pub fn subfolder_sizes(dir: &Path, cancel: &CancelToken, on_size: impl Fn(&str, FolderSize) + Sync) -> Result<()> {
    let mut subdirs: Vec<String> = Vec::new();
    crate::enumerate_dir(dir, |e| {
        if e.kind == EntryKind::Dir && e.attrs & attrs::REPARSE_POINT == 0 {
            subdirs.push(String::from_utf16_lossy(e.name));
        }
    })?;
    subdirs.par_iter().for_each(|name| {
        let size = folder_size(&dir.join(name), cancel);
        if !cancel.is_cancelled() {
            on_size(name, size);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;

    #[test]
    fn sums_nested_files_per_subfolder() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("a/deep")).unwrap();
        fs::create_dir(tmp.path().join("empty")).unwrap();
        fs::write(tmp.path().join("a/x"), vec![0u8; 100]).unwrap();
        fs::write(tmp.path().join("a/deep/y"), vec![0u8; 50]).unwrap();
        fs::write(tmp.path().join("top"), vec![0u8; 7]).unwrap();

        let seen = Mutex::new(Vec::new());
        subfolder_sizes(tmp.path(), &CancelToken::default(), |n, s| seen.lock().unwrap().push((n.to_string(), s))).unwrap();
        let mut seen = seen.into_inner().unwrap();
        seen.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(seen[0], ("a".to_string(), FolderSize { bytes: 150, files: 2 }));
        assert_eq!(seen[1], ("empty".to_string(), FolderSize::default()));
        assert_eq!(folder_size(tmp.path(), &CancelToken::default()), FolderSize { bytes: 157, files: 3 });
    }
}
