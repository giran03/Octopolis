//! Parallel index build: each folder is enumerated with the fast Win32
//! enumerator, and subfolders fan out across a rayon thread pool.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use rayon::prelude::*;

use super::index::{Index, ROOT};
use crate::entry::{Entry, EntryKind, attrs};
use crate::error::{Error, Result};
use crate::ops::CancelToken;

/// One folder's entries plus the scanned subtrees of its subfolders.
struct Node {
    entries: Vec<Entry>,
    /// (position in `entries`, subtree) for each subfolder that was scanned.
    children: Vec<(usize, Node)>,
    unreadable: u64,
}

pub fn build(root: &Path, cancel: &CancelToken, scanned: &AtomicU64) -> Result<Index> {
    if !root.is_dir() {
        return Err(Error::NotFound(root.into()));
    }
    let tree = scan(root, cancel, scanned);
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let mut index = Index::new(root.to_path_buf());
    flatten(&mut index, tree, ROOT);
    Ok(index)
}

fn scan(dir: &Path, cancel: &CancelToken, scanned: &AtomicU64) -> Node {
    let mut entries = Vec::new();
    if cancel.is_cancelled() || crate::enumerate_dir(dir, |raw| entries.push(Entry::from(raw))).is_err() {
        return Node { entries, children: Vec::new(), unreadable: 1 };
    }
    scanned.fetch_add(entries.len() as u64, Ordering::Relaxed);
    // Junctions and symlinks are listed but not entered, so cycles such as
    // "Application Data" -> AppData can't make the walk loop.
    let subdirs: Vec<usize> = entries
        .iter()
        .enumerate()
        .filter(|(_, e)| e.is_dir() && e.attrs & attrs::REPARSE_POINT == 0)
        .map(|(i, _)| i)
        .collect();
    let children: Vec<(usize, Node)> =
        subdirs.into_par_iter().map(|i| (i, scan(&dir.join(&entries[i].name), cancel, scanned))).collect();
    let unreadable = children.iter().map(|(_, n)| n.unreadable).sum();
    Node { entries, children, unreadable }
}

fn flatten(index: &mut Index, node: Node, parent: u32) {
    index.unreadable += node.unreadable;
    let first = index.len() as u32;
    for e in &node.entries {
        let kind = e.kind;
        let size = if kind == EntryKind::Dir { 0 } else { e.size };
        index.push(&e.name, parent, kind, e.attrs, size, e.modified_ms);
    }
    for (pos, child) in node.children {
        flatten(index, child, first + pos as u32);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn indexes_a_whole_tree_with_parent_links() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("a/b/c")).unwrap();
        fs::write(tmp.path().join("top.txt"), b"1").unwrap();
        fs::write(tmp.path().join("a/b/c/deep.rs"), b"12345").unwrap();
        let scanned = AtomicU64::new(0);

        let ix = build(tmp.path(), &CancelToken::default(), &scanned).unwrap();

        let mut paths: Vec<String> = (0..ix.len() as u32).map(|i| ix.rel_path(i)).collect();
        paths.sort();
        assert_eq!(paths, vec!["a", r"a\b", r"a\b\c", r"a\b\c\deep.rs", "top.txt"]);
        let deep = (0..ix.len()).find(|&i| &*ix.names[i] == "deep.rs").unwrap();
        assert_eq!(ix.sizes[deep], 5);
        assert_eq!(scanned.load(Ordering::Relaxed), 5);
    }

    #[test]
    fn cancelled_build_reports_cancelled() {
        let tmp = tempfile::tempdir().unwrap();
        let cancel = CancelToken::default();
        cancel.cancel();
        assert!(matches!(build(tmp.path(), &cancel, &AtomicU64::new(0)), Err(Error::Cancelled)));
    }

    #[test]
    fn missing_root_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let r = build(&tmp.path().join("nope"), &CancelToken::default(), &AtomicU64::new(0));
        assert!(matches!(r, Err(Error::NotFound(_))));
    }
}
