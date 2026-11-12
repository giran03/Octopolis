//! A folder tree flattened into parallel arrays. Each entry stores its parent
//! entry, so relative paths are rebuilt on demand instead of stored.

use std::path::PathBuf;

use crate::entry::EntryKind;

/// Parent value for entries directly inside the root.
pub const ROOT: u32 = u32::MAX;

#[derive(Debug, Default)]
pub struct Index {
    pub root: PathBuf,
    pub names: Vec<Box<str>>,
    pub parents: Vec<u32>,
    pub kinds: Vec<EntryKind>,
    pub attrs: Vec<u32>,
    /// `u64::MAX` when unknown (the NTFS journal has no sizes).
    pub sizes: Vec<u64>,
    pub modified_ms: Vec<i64>,
    /// Folders that could not be read (permissions, vanished).
    pub unreadable: u64,
}

impl Index {
    pub fn new(root: PathBuf) -> Self {
        Self { root, ..Self::default() }
    }

    pub fn len(&self) -> usize {
        self.names.len()
    }

    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }

    /// Approximate heap use in bytes: the parallel arrays plus each name's text and allocator overhead.
    pub fn heap_bytes(&self) -> u64 {
        use std::mem::size_of;
        let per_entry = size_of::<Box<str>>() + size_of::<u32>() * 2 + size_of::<EntryKind>() + size_of::<u64>() + size_of::<i64>();
        let text: usize = self.names.iter().map(|n| n.len() + 16).sum();
        (self.names.len() * per_entry + text) as u64
    }

    pub fn push(&mut self, name: &str, parent: u32, kind: EntryKind, attrs: u32, size: u64, modified_ms: i64) -> u32 {
        let id = self.names.len() as u32;
        self.names.push(name.into());
        self.parents.push(parent);
        self.kinds.push(kind);
        self.attrs.push(attrs);
        self.sizes.push(size);
        self.modified_ms.push(modified_ms);
        id
    }

    /// Path of entry `i` relative to the root, with `\` separators.
    pub fn rel_path(&self, i: u32) -> String {
        let mut parts = Vec::new();
        let mut cur = i;
        while cur != ROOT {
            parts.push(&*self.names[cur as usize]);
            cur = self.parents[cur as usize];
        }
        parts.reverse();
        parts.join("\\")
    }

    pub fn full_path(&self, i: u32) -> PathBuf {
        self.root.join(self.rel_path(i))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rebuilds_relative_paths_from_parents() {
        let mut ix = Index::new(PathBuf::from(r"C:\r"));
        let a = ix.push("a", ROOT, EntryKind::Dir, 0, 0, 0);
        let b = ix.push("b", a, EntryKind::Dir, 0, 0, 0);
        let f = ix.push("f.txt", b, EntryKind::File, 0, 3, 0);
        assert_eq!(ix.rel_path(f), r"a\b\f.txt");
        assert_eq!(ix.rel_path(a), "a");
        assert_eq!(ix.full_path(f), PathBuf::from(r"C:\r\a\b\f.txt"));
    }

    #[test]
    fn heap_bytes_grows_with_entries() {
        let mut ix = Index::new(PathBuf::from(r"C:\r"));
        assert_eq!(ix.heap_bytes(), 0);
        ix.push("a", ROOT, EntryKind::Dir, 0, 0, 0);
        let one = ix.heap_bytes();
        ix.push("longer-name.txt", ROOT, EntryKind::File, 0, 1, 0);
        assert!(one > 0 && ix.heap_bytes() > one * 2 - 1);
    }
}
