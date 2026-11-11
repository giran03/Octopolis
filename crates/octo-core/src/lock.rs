//! "What is locking this file?" via the Windows Restart Manager.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Locker {
    pub pid: u32,
    pub name: String,
    /// e.g. "app", "service", "explorer", "console", "critical".
    pub kind: &'static str,
}

/// Processes holding any of `paths` (files; folders are expanded to the files
/// directly inside them, as Restart Manager only tracks files).
pub fn who_locks(paths: &[PathBuf]) -> Result<Vec<Locker>> {
    let mut files = Vec::new();
    for p in paths {
        if p.is_dir() {
            files.extend(std::fs::read_dir(p).into_iter().flatten().flatten().map(|e| e.path()).filter(|e| e.is_file()).take(5000));
        } else {
            files.push(p.clone());
        }
    }
    if files.is_empty() {
        return Ok(Vec::new());
    }
    imp::who_locks(&files)
}

/// Ends a process. The caller must have confirmed this with the user.
pub fn kill(pid: u32) -> Result<()> {
    imp::kill(pid)
}

#[cfg(windows)]
mod imp {
    use std::path::PathBuf;

    use windows::Win32::Foundation::{CloseHandle, ERROR_MORE_DATA, WIN32_ERROR};
    use windows::Win32::System::RestartManager::{
        CCH_RM_SESSION_KEY, RM_PROCESS_INFO, RmConsole, RmCritical, RmEndSession, RmExplorer, RmGetList, RmMainWindow,
        RmOtherWindow, RmRegisterResources, RmService, RmStartSession,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess};
    use windows::core::{PCWSTR, PWSTR};

    use super::Locker;
    use crate::error::{Error, Result};

    fn check(code: WIN32_ERROR, what: &str) -> Result<()> {
        if code.is_ok() { Ok(()) } else { Err(Error::io(PathBuf::from(what), std::io::Error::from_raw_os_error(code.0 as i32))) }
    }

    pub fn who_locks(files: &[PathBuf]) -> Result<Vec<Locker>> {
        let mut session = 0u32;
        let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
        // SAFETY: out-parameters are valid for the duration of the call.
        check(unsafe { RmStartSession(&mut session, None, PWSTR(key.as_mut_ptr())) }, "Restart Manager")?;
        let result = (|| {
            let wide: Vec<Vec<u16>> = files.iter().map(|f| f.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect()).collect();
            let ptrs: Vec<PCWSTR> = wide.iter().map(|w| PCWSTR(w.as_ptr())).collect();
            // SAFETY: `ptrs` points into `wide`, which outlives the call.
            check(unsafe { RmRegisterResources(session, Some(&ptrs), None, None) }, "Restart Manager")?;
            let mut needed = 0u32;
            let mut count = 0u32;
            let mut reasons = 0u32;
            let mut infos: Vec<RM_PROCESS_INFO> = Vec::new();
            for _ in 0..4 {
                count = infos.len() as u32;
                // SAFETY: the buffer holds `count` RM_PROCESS_INFO entries.
                let r = unsafe {
                    RmGetList(session, &mut needed, &mut count, if infos.is_empty() { None } else { Some(infos.as_mut_ptr()) }, &mut reasons)
                };
                if r == ERROR_MORE_DATA {
                    infos = vec![RM_PROCESS_INFO::default(); needed as usize + 4];
                    continue;
                }
                check(r, "Restart Manager")?;
                break;
            }
            infos.truncate(count as usize);
            Ok(infos
                .iter()
                .map(|i| {
                    let len = i.strAppName.iter().position(|&c| c == 0).unwrap_or(i.strAppName.len());
                    #[allow(non_upper_case_globals)]
                    let kind = match i.ApplicationType {
                        RmMainWindow | RmOtherWindow => "app",
                        RmService => "service",
                        RmExplorer => "explorer",
                        RmConsole => "console",
                        RmCritical => "critical",
                        _ => "other",
                    };
                    Locker { pid: i.Process.dwProcessId, name: String::from_utf16_lossy(&i.strAppName[..len]), kind }
                })
                .collect())
        })();
        // SAFETY: ends the session started above.
        let _ = unsafe { RmEndSession(session) };
        result
    }

    pub fn kill(pid: u32) -> Result<()> {
        // SAFETY: plain Win32 calls on a handle we own and close.
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE, false, pid).map_err(|e| Error::io(PathBuf::from(format!("process {pid}")), e.into()))?;
            let r = TerminateProcess(h, 1);
            let _ = CloseHandle(h);
            r.map_err(|e| Error::io(PathBuf::from(format!("process {pid}")), e.into()))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Locker;
    use crate::error::Result;
    use std::path::PathBuf;
    pub fn who_locks(_: &[PathBuf]) -> Result<Vec<Locker>> {
        Ok(Vec::new())
    }
    pub fn kill(_: u32) -> Result<()> {
        Ok(())
    }
}

/// Convenience for one path.
pub fn who_locks_one(path: &Path) -> Result<Vec<Locker>> {
    who_locks(&[path.to_path_buf()]).map_err(|e| match e {
        Error::Io { source, .. } => Error::io(path, source),
        other => other,
    })
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;

    #[test]
    fn finds_this_process_holding_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("held.txt");
        std::fs::write(&f, b"x").unwrap();
        let _guard = std::fs::OpenOptions::new().read(true).share_mode(0).open(&f).unwrap();
        let lockers = who_locks_one(&f).unwrap();
        assert!(lockers.iter().any(|l| l.pid == std::process::id()), "{lockers:?}");
    }

    #[test]
    fn unlocked_file_has_no_lockers() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("free.txt");
        std::fs::write(&f, b"x").unwrap();
        assert!(who_locks_one(&f).unwrap().is_empty());
    }
}
