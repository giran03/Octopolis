//! The Properties dialog: details Explorer shows (and a few it hides), editing
//! dates and attributes, and checksums.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::error::{Error, Result};
use crate::ops::CancelToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Attributes {
    pub read_only: bool,
    pub hidden: bool,
    pub system: bool,
    pub archive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stream {
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Properties {
    pub is_dir: bool,
    pub size: u64,
    /// Bytes the file takes on disk (compression and cluster size included); None for folders.
    pub size_on_disk: Option<u64>,
    pub created_ms: i64,
    pub modified_ms: i64,
    pub accessed_ms: i64,
    pub attributes: Attributes,
    /// Names pointing at the same file data (1 for an ordinary file).
    pub hard_links: u32,
    /// Alternate data streams, such as the "downloaded from the internet" mark.
    pub streams: Vec<Stream>,
    pub link_target: Option<String>,
}

fn ms(t: std::io::Result<SystemTime>) -> i64 {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64)
}

pub fn read(path: &Path) -> Result<Properties> {
    let meta = path.symlink_metadata().map_err(|e| Error::io(path, e))?;
    let mut p = Properties {
        is_dir: meta.is_dir(),
        size: if meta.is_dir() { 0 } else { meta.len() },
        created_ms: ms(meta.created()),
        modified_ms: ms(meta.modified()),
        accessed_ms: ms(meta.accessed()),
        hard_links: 1,
        link_target: meta.file_type().is_symlink().then(|| fs::read_link(path).ok()).flatten().map(|t| t.to_string_lossy().into_owned()),
        ..Default::default()
    };
    imp::fill(path, &meta, &mut p);
    Ok(p)
}

/// Sets the four attributes on every path, keeping all other attribute bits.
pub fn set_attributes(paths: &[PathBuf], attrs: Attributes) -> Result<()> {
    paths.iter().try_for_each(|p| imp::set_attributes(p, attrs))
}

/// Changes created / modified / accessed times (milliseconds since 1970); None leaves one as it is.
pub fn set_times(path: &Path, created_ms: Option<i64>, modified_ms: Option<i64>, accessed_ms: Option<i64>) -> Result<()> {
    let at = |ms: i64| UNIX_EPOCH + Duration::from_millis(ms.max(0) as u64);
    let mut times = fs::FileTimes::new();
    if let Some(m) = modified_ms {
        times = times.set_modified(at(m));
    }
    if let Some(a) = accessed_ms {
        times = times.set_accessed(at(a));
    }
    #[cfg(windows)]
    if let Some(c) = created_ms {
        use std::os::windows::fs::FileTimesExt;
        times = times.set_created(at(c));
    }
    #[cfg(not(windows))]
    let _ = created_ms;
    let file = imp::open_for_times(path).map_err(|e| Error::io(path, e))?;
    file.set_times(times).map_err(|e| Error::io(path, e))
}

/// OneDrive and other sync apps: `keep` asks for the files to always stay on
/// this device (downloading them); otherwise frees the space they take,
/// leaving them online-only. The sync app does the actual work.
pub fn set_cloud_pin(paths: &[PathBuf], keep: bool) -> Result<()> {
    paths.iter().try_for_each(|p| imp::set_cloud_pin(p, keep))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HashKind {
    Blake3,
    Sha256,
    Md5,
}

/// Lower-case hex checksum of a file. Reports `(done, total)` bytes; stops when cancelled.
pub fn hash_file(path: &Path, kind: HashKind, cancel: &CancelToken, mut on_progress: impl FnMut(u64, u64)) -> Result<String> {
    use sha2::Digest;
    let mut file = File::open(path).map_err(|e| Error::io(path, e))?;
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut buf = vec![0u8; 1 << 20];
    let mut done = 0u64;
    let mut blake = blake3::Hasher::new();
    let mut sha = sha2::Sha256::new();
    let mut md5 = md5::Md5::new();
    loop {
        if cancel.is_cancelled() {
            return Err(Error::io(path, std::io::Error::other("cancelled")));
        }
        let n = file.read(&mut buf).map_err(|e| Error::io(path, e))?;
        if n == 0 {
            break;
        }
        match kind {
            HashKind::Blake3 => {
                blake.update(&buf[..n]);
            }
            HashKind::Sha256 => sha.update(&buf[..n]),
            HashKind::Md5 => md5.update(&buf[..n]),
        }
        done += n as u64;
        on_progress(done, total);
    }
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    Ok(match kind {
        HashKind::Blake3 => blake.finalize().to_hex().to_string(),
        HashKind::Sha256 => hex(&sha.finalize()),
        HashKind::Md5 => hex(&md5.finalize()),
    })
}

/// Which checksum `text` (e.g. pasted from a download page) looks like, by length.
pub fn guess_hash_kind(text: &str) -> Option<HashKind> {
    let t = text.trim();
    if !t.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    match t.len() {
        32 => Some(HashKind::Md5),
        64 => Some(HashKind::Sha256), // BLAKE3 is also 64; SHA-256 is far more common on download pages
        _ => None,
    }
}

#[cfg(windows)]
mod imp {
    use std::fs::{File, Metadata, OpenOptions};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::path::Path;

    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_SYSTEM,
        FILE_FLAGS_AND_ATTRIBUTES, FindClose, FindFirstStreamW, FindNextStreamW, FindStreamInfoStandard, GetCompressedFileSizeW,
        GetDiskFreeSpaceW, GetFileInformationByHandle, SetFileAttributesW, WIN32_FIND_STREAM_DATA,
    };
    use windows::core::PCWSTR;

    use super::{Attributes, Properties, Stream};
    use crate::error::{Error, Result};

    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
    const FILE_READ_ATTRIBUTES: u32 = 0x0080;

    fn wide(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn fill(path: &Path, meta: &Metadata, p: &mut Properties) {
        let a = meta.file_attributes();
        p.attributes = Attributes {
            read_only: a & FILE_ATTRIBUTE_READONLY.0 != 0,
            hidden: a & FILE_ATTRIBUTE_HIDDEN.0 != 0,
            system: a & FILE_ATTRIBUTE_SYSTEM.0 != 0,
            archive: a & FILE_ATTRIBUTE_ARCHIVE.0 != 0,
        };
        let w = wide(path);
        if !p.is_dir {
            let mut high = 0u32;
            // SAFETY: `w` is NUL-terminated.
            let low = unsafe { GetCompressedFileSizeW(PCWSTR(w.as_ptr()), Some(&mut high)) };
            if low != u32::MAX || high != 0 {
                let raw = (u64::from(high) << 32) | u64::from(low);
                p.size_on_disk = Some(round_to_cluster(path, raw));
            }
        }
        if let Ok(f) = OpenOptions::new().access_mode(FILE_READ_ATTRIBUTES).custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).open(path) {
            use std::os::windows::io::AsRawHandle;
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            // SAFETY: the handle is open for the duration of the call.
            if unsafe { GetFileInformationByHandle(HANDLE(f.as_raw_handle()), &mut info) }.is_ok() {
                p.hard_links = info.nNumberOfLinks.max(1);
            }
        }
        p.streams = streams(&w);
    }

    fn round_to_cluster(path: &Path, bytes: u64) -> u64 {
        // The last ancestor is the drive or share root (`C:\`, `\\server\share\`); the API wants a trailing backslash.
        let mut root = path.ancestors().last().map(|r| r.to_string_lossy().into_owned()).unwrap_or_default();
        if !root.ends_with('\\') {
            root.push('\\');
        }
        let rw = wide(Path::new(&root));
        let (mut spc, mut bps, mut free, mut total) = (0u32, 0u32, 0u32, 0u32);
        // SAFETY: `rw` is NUL-terminated; outputs are locals.
        let ok = unsafe { GetDiskFreeSpaceW(PCWSTR(rw.as_ptr()), Some(&mut spc), Some(&mut bps), Some(&mut free), Some(&mut total)) }.is_ok();
        let cluster = u64::from(spc) * u64::from(bps);
        if !ok || cluster == 0 { bytes } else { bytes.div_ceil(cluster) * cluster }
    }

    fn streams(w: &[u16]) -> Vec<Stream> {
        let mut out = Vec::new();
        let mut data = WIN32_FIND_STREAM_DATA::default();
        // SAFETY: `w` is NUL-terminated; `data` is filled by the API; the find handle is closed.
        unsafe {
            let Ok(h) = FindFirstStreamW(PCWSTR(w.as_ptr()), FindStreamInfoStandard, &mut data as *mut _ as *mut _, None) else { return out };
            loop {
                let len = data.cStreamName.iter().position(|&c| c == 0).unwrap_or(data.cStreamName.len());
                let name = String::from_utf16_lossy(&data.cStreamName[..len]);
                // "::$DATA" is the file's ordinary content; list only the extra streams.
                if name != "::$DATA" {
                    let clean = name.trim_start_matches(':').trim_end_matches(":$DATA").to_string();
                    out.push(Stream { name: clean, size: data.StreamSize as u64 });
                }
                if FindNextStreamW(h, &mut data as *mut _ as *mut _).is_err() {
                    break;
                }
            }
            let _ = FindClose(h);
        }
        out
    }

    pub fn set_attributes(path: &Path, attrs: Attributes) -> Result<()> {
        let current = path.symlink_metadata().map_err(|e| Error::io(path, e))?.file_attributes();
        let mut next = current & !(FILE_ATTRIBUTE_READONLY.0 | FILE_ATTRIBUTE_HIDDEN.0 | FILE_ATTRIBUTE_SYSTEM.0 | FILE_ATTRIBUTE_ARCHIVE.0);
        for (on, bit) in [(attrs.read_only, FILE_ATTRIBUTE_READONLY.0), (attrs.hidden, FILE_ATTRIBUTE_HIDDEN.0), (attrs.system, FILE_ATTRIBUTE_SYSTEM.0), (attrs.archive, FILE_ATTRIBUTE_ARCHIVE.0)] {
            if on {
                next |= bit;
            }
        }
        // Directory and other kind bits are not settable; keep only what SetFileAttributes accepts.
        const DIRECTORY: u32 = 0x10;
        next &= !DIRECTORY;
        let w = wide(path);
        // SAFETY: `w` is NUL-terminated.
        unsafe { SetFileAttributesW(PCWSTR(w.as_ptr()), FILE_FLAGS_AND_ATTRIBUTES(next)) }.map_err(|e| Error::io(path, e.into()))
    }

    pub fn set_cloud_pin(path: &Path, keep: bool) -> Result<()> {
        const PINNED: u32 = 0x0008_0000;
        const UNPINNED: u32 = 0x0010_0000;
        const DIRECTORY: u32 = 0x10;
        let current = path.symlink_metadata().map_err(|e| Error::io(path, e))?.file_attributes();
        let next = (current & !(PINNED | UNPINNED | DIRECTORY)) | if keep { PINNED } else { UNPINNED };
        let w = wide(path);
        // SAFETY: `w` is NUL-terminated.
        unsafe { SetFileAttributesW(PCWSTR(w.as_ptr()), FILE_FLAGS_AND_ATTRIBUTES(next)) }.map_err(|e| Error::io(path, e.into()))
    }

    pub fn open_for_times(path: &Path) -> std::io::Result<File> {
        // Folders need backup semantics to be opened at all.
        OpenOptions::new().access_mode(FILE_WRITE_ATTRIBUTES).custom_flags(FILE_FLAG_BACKUP_SEMANTICS).open(path)
    }
}

#[cfg(not(windows))]
mod imp {
    use std::fs::{File, Metadata, OpenOptions};
    use std::path::Path;

    use super::{Attributes, Properties};
    use crate::error::Result;

    pub fn fill(_: &Path, meta: &Metadata, p: &mut Properties) {
        p.attributes.read_only = meta.permissions().readonly();
    }
    pub fn set_attributes(_: &Path, _: Attributes) -> Result<()> {
        Ok(())
    }
    pub fn set_cloud_pin(_: &Path, _: bool) -> Result<()> {
        Ok(())
    }
    pub fn open_for_times(path: &Path) -> std::io::Result<File> {
        OpenOptions::new().write(true).open(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_match_known_values() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("abc.txt");
        fs::write(&f, b"abc").unwrap();
        let c = CancelToken::default();
        assert_eq!(hash_file(&f, HashKind::Md5, &c, |_, _| {}).unwrap(), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(hash_file(&f, HashKind::Sha256, &c, |_, _| {}).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(hash_file(&f, HashKind::Blake3, &c, |_, _| {}).unwrap(), "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85");
    }

    #[test]
    fn reads_and_changes_attributes_and_times() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("x.txt");
        fs::write(&f, b"hello").unwrap();
        let p = read(&f).unwrap();
        assert_eq!(p.size, 5);
        assert!(!p.is_dir && p.hard_links >= 1);

        set_attributes(std::slice::from_ref(&f), Attributes { read_only: true, hidden: true, ..Default::default() }).unwrap();
        let p = read(&f).unwrap();
        assert!(p.attributes.read_only && p.attributes.hidden);
        set_attributes(std::slice::from_ref(&f), Attributes::default()).unwrap();
        assert!(!read(&f).unwrap().attributes.read_only);

        let when = 1_600_000_000_000; // 2020-09-13
        set_times(&f, Some(when), Some(when), None).unwrap();
        let p = read(&f).unwrap();
        assert_eq!(p.modified_ms, when);
        #[cfg(windows)]
        assert_eq!(p.created_ms, when);
    }

    #[test]
    fn folder_times_can_be_changed() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path().join("dir");
        fs::create_dir(&d).unwrap();
        set_times(&d, None, Some(1_500_000_000_000), None).unwrap();
        assert_eq!(read(&d).unwrap().modified_ms, 1_500_000_000_000);
    }

    #[test]
    fn guesses_hash_kind_from_pasted_text() {
        assert_eq!(guess_hash_kind(" 900150983cd24fb0d6963f7d28e17f72 "), Some(HashKind::Md5));
        assert_eq!(guess_hash_kind(&"a".repeat(64)), Some(HashKind::Sha256));
        assert_eq!(guess_hash_kind("not a hash"), None);
    }
}
