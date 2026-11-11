//! Single-directory enumeration.
//!
//! On Windows this calls `FindFirstFileExW` with `FindExInfoBasic` (skips the
//! 8.3 short-name lookup) and `FIND_FIRST_EX_LARGE_FETCH` (bigger kernel
//! buffer), and hands each entry to a sink without allocating per entry.

use std::path::Path;

use crate::entry::{Entry, RawEntry};
use crate::error::Result;

/// Streams every entry of `dir` (excluding `.` and `..`) into `sink`.
pub fn enumerate_dir(dir: &Path, sink: impl FnMut(RawEntry<'_>)) -> Result<()> {
    imp::enumerate_dir(dir, sink)
}

/// Collects a directory listing into owned entries.
pub fn list_dir(dir: &Path) -> Result<Vec<Entry>> {
    let mut out = Vec::new();
    enumerate_dir(dir, |raw| out.push(Entry::from(raw)))?;
    Ok(out)
}

/// Converts a path to the extended-length form (`\\?\C:\…`, `\\?\UNC\…`) so
/// paths longer than `MAX_PATH` work. Relative paths are left unchanged.
pub fn extended_path(path: &Path) -> String {
    let s = path.to_string_lossy().replace('/', "\\");
    if s.starts_with(r"\\?\") || s.starts_with(r"\\.\") {
        s
    } else if let Some(unc) = s.strip_prefix(r"\\") {
        format!(r"\\?\UNC\{unc}")
    } else if s.len() >= 2 && s.as_bytes()[1] == b':' {
        format!(r"\\?\{s}")
    } else {
        s
    }
}

#[cfg(windows)]
mod imp {
    use std::path::Path;

    use windows::Win32::Foundation::{
        ERROR_ACCESS_DENIED, ERROR_DIRECTORY, ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_FILES,
        ERROR_PATH_NOT_FOUND, WIN32_ERROR,
    };
    use windows::Win32::Storage::FileSystem::{
        FIND_FIRST_EX_LARGE_FETCH, FindClose, FindExInfoBasic, FindExSearchNameMatch,
        FindFirstFileExW, FindNextFileW, WIN32_FIND_DATAW,
    };
    use windows::core::PCWSTR;

    use super::extended_path;
    use crate::entry::{EntryKind, RawEntry, attrs};
    use crate::error::{Error, Result};

    /// 100 ns ticks between 1601-01-01 and 1970-01-01.
    const FILETIME_UNIX_EPOCH: i64 = 116_444_736_000_000_000;

    pub fn enumerate_dir(dir: &Path, mut sink: impl FnMut(RawEntry<'_>)) -> Result<()> {
        let mut pattern = extended_path(dir);
        if !pattern.ends_with('\\') {
            pattern.push('\\');
        }
        pattern.push('*');
        let wide: Vec<u16> = pattern.encode_utf16().chain(std::iter::once(0)).collect();

        let mut data = WIN32_FIND_DATAW::default();
        // SAFETY: `wide` is NUL-terminated and outlives the call; `data` is a
        // valid out-pointer of the type FindExInfoBasic expects.
        let handle = unsafe {
            FindFirstFileExW(
                PCWSTR(wide.as_ptr()),
                FindExInfoBasic,
                (&mut data as *mut WIN32_FIND_DATAW).cast(),
                FindExSearchNameMatch,
                None,
                FIND_FIRST_EX_LARGE_FETCH,
            )
        };
        let handle = match handle {
            Ok(h) => h,
            Err(e) => {
                let code = WIN32_ERROR::from_error(&e).unwrap_or_default();
                return match code {
                    // An empty volume root has no entries at all.
                    ERROR_FILE_NOT_FOUND if dir.exists() => Ok(()),
                    ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Err(Error::NotFound(dir.into())),
                    ERROR_ACCESS_DENIED => Err(Error::AccessDenied(dir.into())),
                    ERROR_DIRECTORY => Err(Error::NotADirectory(dir.into())),
                    _ => Err(Error::io(dir, std::io::Error::from_raw_os_error(code.0 as i32))),
                };
            }
        };

        let result = (|| loop {
            emit(&data, &mut sink);
            // SAFETY: `handle` is a live find handle and `data` a valid buffer.
            if let Err(e) = unsafe { FindNextFileW(handle, &mut data) } {
                let code = WIN32_ERROR::from_error(&e).unwrap_or_default();
                return if code == ERROR_NO_MORE_FILES {
                    Ok(())
                } else {
                    Err(Error::io(dir, std::io::Error::from_raw_os_error(code.0 as i32)))
                };
            }
        })();
        // SAFETY: closing the handle we opened above, exactly once.
        let _ = unsafe { FindClose(handle) };
        result
    }

    fn emit(data: &WIN32_FIND_DATAW, sink: &mut impl FnMut(RawEntry<'_>)) {
        let len = data.cFileName.iter().position(|&c| c == 0).unwrap_or(data.cFileName.len());
        let name = &data.cFileName[..len];
        if is_dot_entry(name) {
            return;
        }
        let a = data.dwFileAttributes;
        let ticks = ((data.ftLastWriteTime.dwHighDateTime as i64) << 32)
            | data.ftLastWriteTime.dwLowDateTime as i64;
        sink(RawEntry {
            name,
            kind: if a & attrs::DIRECTORY != 0 { EntryKind::Dir } else { EntryKind::File },
            attrs: a,
            size: ((data.nFileSizeHigh as u64) << 32) | data.nFileSizeLow as u64,
            modified_ms: (ticks - FILETIME_UNIX_EPOCH) / 10_000,
        });
    }

    fn is_dot_entry(name: &[u16]) -> bool {
        const DOT: u16 = b'.' as u16;
        matches!(name, [DOT] | [DOT, DOT])
    }
}

#[cfg(not(windows))]
mod imp {
    use std::path::Path;
    use std::time::UNIX_EPOCH;

    use crate::entry::{EntryKind, RawEntry};
    use crate::error::{Error, Result};

    pub fn enumerate_dir(dir: &Path, mut sink: impl FnMut(RawEntry<'_>)) -> Result<()> {
        for item in std::fs::read_dir(dir).map_err(|e| Error::io(dir, e))? {
            let Ok(item) = item else { continue };
            let Ok(meta) = item.metadata() else { continue };
            let name: Vec<u16> = item.file_name().to_string_lossy().encode_utf16().collect();
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as i64);
            sink(RawEntry {
                name: &name,
                kind: if meta.is_dir() { EntryKind::Dir } else { EntryKind::File },
                attrs: 0,
                size: if meta.is_dir() { 0 } else { meta.len() },
                modified_ms,
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EntryKind;
    use std::fs;

    #[test]
    fn lists_files_and_dirs_without_dot_entries() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a.txt"), b"hello").unwrap();
        fs::create_dir(tmp.path().join("sub")).unwrap();

        let mut entries = list_dir(tmp.path()).unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "a.txt");
        assert_eq!(entries[0].kind, EntryKind::File);
        assert_eq!(entries[0].size, 5);
        assert!(entries[0].modified_ms > 1_600_000_000_000, "modified time in Unix ms");
        assert_eq!(entries[1].name, "sub");
        assert!(entries[1].is_dir());
    }

    #[test]
    fn empty_directory_yields_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list_dir(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn missing_directory_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let err = list_dir(&tmp.path().join("nope")).unwrap_err();
        assert!(matches!(err, crate::Error::NotFound(_)), "{err:?}");
    }

    #[test]
    fn unicode_names_survive() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("ünïcødé 🐙.txt"), b"").unwrap();
        let entries = list_dir(tmp.path()).unwrap();
        assert_eq!(entries[0].name, "ünïcødé 🐙.txt");
    }

    #[cfg(windows)]
    #[test]
    fn handles_paths_longer_than_max_path() {
        let tmp = tempfile::tempdir().unwrap();
        let mut deep = tmp.path().to_path_buf();
        for i in 0..12 {
            deep.push(format!("{i:02}_{}", "x".repeat(24)));
        }
        fs::create_dir_all(extended_path(&deep)).unwrap();
        fs::write(format!(r"{}\leaf.txt", extended_path(&deep)), b"1").unwrap();
        assert!(deep.as_os_str().len() > 260);
        let entries = list_dir(&deep).unwrap();
        assert_eq!(entries[0].name, "leaf.txt");
    }

    #[test]
    fn extended_path_forms() {
        assert_eq!(extended_path(Path::new(r"C:\Users")), r"\\?\C:\Users");
        assert_eq!(extended_path(Path::new(r"\\srv\share\x")), r"\\?\UNC\srv\share\x");
        assert_eq!(extended_path(Path::new(r"\\?\C:\a")), r"\\?\C:\a");
        assert_eq!(extended_path(Path::new("C:/a/b")), r"\\?\C:\a\b");
        assert_eq!(extended_path(Path::new("rel")), "rel");
    }
}
