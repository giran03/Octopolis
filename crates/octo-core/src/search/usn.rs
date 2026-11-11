//! Whole-volume index from the NTFS change journal (`FSCTL_ENUM_USN_DATA`).
//!
//! Reading a volume this way needs administrator rights. Without them
//! [`build`] fails with access denied and the caller falls back to a walk.
//! The journal has no file sizes, so sizes are marked unknown (`u64::MAX`).

use std::collections::HashMap;
use std::path::{Component, Path};
use std::sync::atomic::AtomicU64;

use super::index::{Index, ROOT};
use crate::entry::{EntryKind, attrs};
use crate::error::Result;
use crate::ops::CancelToken;

/// One USN_RECORD_V2, decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsnRecord {
    pub frn: u64,
    pub parent_frn: u64,
    pub attrs: u32,
    pub modified_ms: i64,
    pub name: String,
}

/// `C:\` (and nothing deeper)?
pub fn is_volume_root(p: &Path) -> bool {
    let mut c = p.components();
    matches!((c.next(), c.next(), c.next()), (Some(Component::Prefix(_)), Some(Component::RootDir), None))
}

const FILETIME_UNIX_EPOCH: i64 = 116_444_736_000_000_000;

/// Decodes the USN_RECORD_V2 entries in a `FSCTL_ENUM_USN_DATA` output buffer
/// (after its leading 8-byte "next start" value). Other record versions and
/// malformed records are skipped.
pub fn parse_records(buf: &[u8], out: &mut Vec<UsnRecord>) {
    let u16_at = |o: usize| u16::from_le_bytes([buf[o], buf[o + 1]]);
    let u32_at = |o: usize| u32::from_le_bytes(buf[o..o + 4].try_into().unwrap());
    let u64_at = |o: usize| u64::from_le_bytes(buf[o..o + 8].try_into().unwrap());
    let mut off = 0;
    while off + 60 <= buf.len() {
        let len = u32_at(off) as usize;
        if len < 60 || off + len > buf.len() {
            break;
        }
        let major = u16_at(off + 4);
        if major == 2 {
            let name_len = u16_at(off + 56) as usize;
            let name_off = u16_at(off + 58) as usize;
            if name_off + name_len <= len && name_len.is_multiple_of(2) {
                let units: Vec<u16> = (0..name_len / 2).map(|k| u16_at(off + name_off + k * 2)).collect();
                let ticks = u64_at(off + 32) as i64;
                out.push(UsnRecord {
                    frn: u64_at(off + 8),
                    parent_frn: u64_at(off + 16),
                    attrs: u32_at(off + 52),
                    modified_ms: (ticks - FILETIME_UNIX_EPOCH) / 10_000,
                    name: String::from_utf16_lossy(&units),
                });
            }
        }
        off += len;
    }
}

/// Links records into an index rooted at `root_frn`. Records whose parent
/// chain never reaches the root (NTFS metadata such as `$Extend`) are dropped.
pub fn assemble(root: &Path, records: Vec<UsnRecord>, root_frn: u64) -> Index {
    let pos: HashMap<u64, usize> = records.iter().enumerate().map(|(i, r)| (r.frn, i)).collect();
    // reach[i]: None = not yet known, Some(false) = orphan, Some(true) = under root.
    let mut reach: Vec<Option<bool>> = vec![None; records.len()];
    for start in 0..records.len() {
        let mut chain = Vec::new();
        let mut cur = start;
        let verdict = loop {
            if let Some(v) = reach[cur] {
                break v;
            }
            if chain.len() > records.len() {
                break false; // corrupt cycle
            }
            chain.push(cur);
            let parent = records[cur].parent_frn;
            if parent == root_frn {
                break true;
            }
            match pos.get(&parent) {
                Some(&p) => cur = p,
                None => break false,
            }
        };
        for i in chain {
            reach[i] = Some(verdict);
        }
    }

    let mut index = Index::new(root.to_path_buf());
    let mut id_of: HashMap<u64, u32> = HashMap::new();
    for (i, r) in records.iter().enumerate() {
        if reach[i] == Some(true) {
            let kind = if r.attrs & attrs::DIRECTORY != 0 { EntryKind::Dir } else { EntryKind::File };
            let size = if kind == EntryKind::Dir { 0 } else { u64::MAX };
            id_of.insert(r.frn, index.push(&r.name, ROOT, kind, r.attrs, size, r.modified_ms));
        }
    }
    for (i, r) in records.iter().enumerate() {
        if reach[i] == Some(true) && r.parent_frn != root_frn {
            let me = id_of[&r.frn];
            index.parents[me as usize] = id_of[&r.parent_frn];
        }
    }
    index
}

#[cfg(windows)]
pub fn build(root: &Path, cancel: &CancelToken, scanned: &AtomicU64) -> Result<Index> {
    imp::build(root, cancel, scanned)
}

#[cfg(not(windows))]
pub fn build(root: &Path, _: &CancelToken, _: &AtomicU64) -> Result<Index> {
    Err(crate::Error::NotADirectory(root.into()))
}

#[cfg(windows)]
mod imp {
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};

    use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, HANDLE};
    use windows::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_READ,
        FILE_SHARE_WRITE, GetFileInformationByHandle, OPEN_EXISTING,
    };
    use windows::Win32::System::IO::DeviceIoControl;
    use windows::Win32::System::Ioctl::{FSCTL_ENUM_USN_DATA, FSCTL_QUERY_USN_JOURNAL, MFT_ENUM_DATA_V0, USN_JOURNAL_DATA_V0};
    use windows::core::PCWSTR;

    use super::{UsnRecord, assemble, parse_records};
    use crate::error::{Error, Result};
    use crate::ops::CancelToken;
    use crate::search::index::Index;

    /// Win32 ERROR_HANDLE_EOF: enumeration finished.
    const ERROR_HANDLE_EOF: i32 = 38;
    const BUFFER: usize = 1 << 20;

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: the handle was opened by `open` and is closed once.
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    fn open(path: &str, flags: FILE_FLAGS_AND_ATTRIBUTES) -> std::io::Result<Handle> {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` is NUL-terminated and outlives the call.
        unsafe {
            CreateFileW(PCWSTR(wide.as_ptr()), GENERIC_READ.0, FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING, flags, None)
        }
        .map(Handle)
        .map_err(|e| std::io::Error::from_raw_os_error(e.code().0 & 0xFFFF))
    }

    pub fn build(root: &Path, cancel: &CancelToken, scanned: &AtomicU64) -> Result<Index> {
        let letter = root.to_string_lossy().trim_end_matches('\\').to_string(); // "C:"
        let volume = open(&format!(r"\\.\{letter}"), FILE_FLAGS_AND_ATTRIBUTES(0)).map_err(|e| Error::io(root, e))?;
        let root_dir = open(&format!(r"{letter}\"), FILE_FLAG_BACKUP_SEMANTICS).map_err(|e| Error::io(root, e))?;

        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: valid handle and out-pointer.
        unsafe { GetFileInformationByHandle(root_dir.0, &mut info) }.map_err(|e| Error::io(root, e.into()))?;
        let root_frn = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;

        let mut journal = USN_JOURNAL_DATA_V0::default();
        let mut got = 0u32;
        // SAFETY: the output buffer is a correctly sized USN_JOURNAL_DATA_V0.
        unsafe {
            DeviceIoControl(
                volume.0,
                FSCTL_QUERY_USN_JOURNAL,
                None,
                0,
                Some((&mut journal as *mut USN_JOURNAL_DATA_V0).cast()),
                size_of::<USN_JOURNAL_DATA_V0>() as u32,
                Some(&mut got),
                None,
            )
        }
        .map_err(|e| Error::io(root, e.into()))?;

        let mut req = MFT_ENUM_DATA_V0 { StartFileReferenceNumber: 0, LowUsn: 0, HighUsn: journal.NextUsn };
        let mut buf = vec![0u8; BUFFER];
        let mut records: Vec<UsnRecord> = Vec::with_capacity(1 << 20);
        loop {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let mut got = 0u32;
            // SAFETY: input/output buffers are valid for their stated sizes.
            let r = unsafe {
                DeviceIoControl(
                    volume.0,
                    FSCTL_ENUM_USN_DATA,
                    Some((&req as *const MFT_ENUM_DATA_V0).cast()),
                    size_of::<MFT_ENUM_DATA_V0>() as u32,
                    Some(buf.as_mut_ptr().cast()),
                    BUFFER as u32,
                    Some(&mut got),
                    None,
                )
            };
            if let Err(e) = r {
                if e.code().0 & 0xFFFF == ERROR_HANDLE_EOF {
                    break;
                }
                return Err(Error::io(root, e.into()));
            }
            let got = got as usize;
            if got <= 8 {
                break;
            }
            req.StartFileReferenceNumber = u64::from_le_bytes(buf[..8].try_into().unwrap());
            let before = records.len();
            parse_records(&buf[8..got], &mut records);
            scanned.fetch_add((records.len() - before) as u64, Ordering::Relaxed);
        }
        Ok(assemble(root, records, root_frn))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Builds a USN_RECORD_V2 exactly as the kernel lays it out.
    fn record(frn: u64, parent: u64, attrs: u32, name: &str) -> Vec<u8> {
        let units: Vec<u16> = name.encode_utf16().collect();
        let name_off = 60usize;
        let len = (name_off + units.len() * 2).next_multiple_of(8);
        let mut b = vec![0u8; len];
        b[0..4].copy_from_slice(&(len as u32).to_le_bytes());
        b[4..6].copy_from_slice(&2u16.to_le_bytes());
        b[8..16].copy_from_slice(&frn.to_le_bytes());
        b[16..24].copy_from_slice(&parent.to_le_bytes());
        let ticks = FILETIME_UNIX_EPOCH + 1_700_000_000_000 * 10_000;
        b[32..40].copy_from_slice(&ticks.to_le_bytes());
        b[52..56].copy_from_slice(&attrs.to_le_bytes());
        b[56..58].copy_from_slice(&((units.len() * 2) as u16).to_le_bytes());
        b[58..60].copy_from_slice(&(name_off as u16).to_le_bytes());
        for (k, u) in units.iter().enumerate() {
            b[name_off + k * 2..name_off + k * 2 + 2].copy_from_slice(&u.to_le_bytes());
        }
        b
    }

    #[test]
    fn parses_v2_records_and_skips_garbage() {
        let mut buf = record(10, 5, 0x10, "Users");
        buf.extend(record(11, 10, 0x20, "notes 🐙.txt"));
        buf.extend([0u8; 12]); // trailing junk shorter than a record
        let mut out = Vec::new();
        parse_records(&buf, &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].name, "notes 🐙.txt");
        assert_eq!(out[1].parent_frn, 10);
        assert_eq!(out[1].modified_ms, 1_700_000_000_000);
    }

    #[test]
    fn assembles_tree_and_drops_entries_outside_root() {
        let rec = |frn, parent, attrs, name: &str| UsnRecord { frn, parent_frn: parent, attrs, modified_ms: 0, name: name.into() };
        let records = vec![
            rec(12, 11, 0x20, "deep.txt"), // child listed before its parent
            rec(11, 5, 0x10, "Users"),
            rec(20, 99, 0x20, "$orphan"), // parent unknown: NTFS metadata
            rec(30, 31, 0x10, "loop-a"),
            rec(31, 30, 0x10, "loop-b"), // corrupt cycle
        ];
        let ix = assemble(&PathBuf::from(r"C:\"), records, 5);
        let mut paths: Vec<String> = (0..ix.len() as u32).map(|i| ix.rel_path(i)).collect();
        paths.sort();
        assert_eq!(paths, vec!["Users", r"Users\deep.txt"]);
        let deep = (0..ix.len()).find(|&i| &*ix.names[i] == "deep.txt").unwrap();
        assert_eq!(ix.sizes[deep], u64::MAX, "the journal has no sizes");
    }

    #[test]
    fn recognises_volume_roots() {
        assert!(is_volume_root(Path::new(r"C:\")));
        assert!(!is_volume_root(Path::new(r"C:\Users")));
        assert!(!is_volume_root(Path::new("rel")));
    }

    /// Needs an elevated prompt: `cargo test -p octo-core -- --ignored usn`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn usn_reads_the_system_volume_when_elevated() {
        let ix = build(Path::new(r"C:\"), &CancelToken::default(), &AtomicU64::new(0)).expect("run elevated");
        assert!((0..ix.len()).any(|i| &*ix.names[i] == "Windows" && ix.parents[i] == ROOT));
    }

    #[cfg(windows)]
    #[test]
    fn without_admin_the_volume_read_is_refused_cleanly() {
        let elevated = std::process::Command::new("net").arg("session").output().is_ok_and(|o| o.status.success());
        if !elevated {
            assert!(build(Path::new(r"C:\"), &CancelToken::default(), &AtomicU64::new(0)).is_err());
        }
    }
}
