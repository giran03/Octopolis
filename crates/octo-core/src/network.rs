//! Network locations: mapping and disconnecting network drives, and WSL distros.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// Shows Windows' "Map Network Drive" dialog. Must run on the UI thread.
pub fn map_drive_dialog(hwnd: isize) -> Result<()> {
    imp::map_drive_dialog(hwnd)
}

/// Disconnects a mapped drive such as `Z:\`. Fails if files on it are open,
/// unless `force`.
pub fn disconnect_drive(root: &Path, force: bool) -> Result<()> {
    let text = root.to_string_lossy();
    let letter = text.get(..2).filter(|s| s.as_bytes()[0].is_ascii_alphabetic() && s.ends_with(':'));
    let Some(letter) = letter else {
        return Err(Error::io(root, std::io::Error::other("only lettered network drives can be disconnected")));
    };
    imp::disconnect(letter, force).map_err(|e| Error::io(root, e))
}

/// The root of each installed WSL distro (`\\wsl.localhost\Ubuntu`), if WSL is installed.
pub fn wsl_distros() -> Vec<PathBuf> {
    let base = Path::new(r"\\wsl.localhost\");
    let Ok(read) = std::fs::read_dir(base) else { return Vec::new() };
    let mut out: Vec<PathBuf> = read.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()).collect();
    out.sort();
    out
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Foundation::{HWND, NO_ERROR};
    use windows::Win32::NetworkManagement::WNet::{CONNECT_UPDATE_PROFILE, RESOURCETYPE_DISK, WNetCancelConnection2W, WNetConnectionDialog};
    use windows::core::PCWSTR;

    use crate::error::{Error, Result};

    pub fn map_drive_dialog(hwnd: isize) -> Result<()> {
        // SAFETY: modal dialog owned by our window.
        let code = unsafe { WNetConnectionDialog(HWND(hwnd as *mut _), RESOURCETYPE_DISK.0) };
        // 0 = connected, u32::MAX (-1) = cancelled.
        if code == NO_ERROR || code.0 == u32::MAX {
            Ok(())
        } else {
            Err(Error::io(std::path::Path::new("network"), std::io::Error::from_raw_os_error(code.0 as i32)))
        }
    }

    pub fn disconnect(letter: &str, force: bool) -> std::io::Result<()> {
        let name: Vec<u16> = letter.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `name` is NUL-terminated.
        let code = unsafe { WNetCancelConnection2W(PCWSTR(name.as_ptr()), CONNECT_UPDATE_PROFILE, force) };
        if code == NO_ERROR { Ok(()) } else { Err(std::io::Error::from_raw_os_error(code.0 as i32)) }
    }
}

#[cfg(not(windows))]
mod imp {
    use crate::error::Result;
    pub fn map_drive_dialog(_: isize) -> Result<()> {
        Ok(())
    }
    pub fn disconnect(_: &str, _: bool) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn disconnect_refuses_non_drive_paths() {
        assert!(super::disconnect_drive(std::path::Path::new(r"\\server\share"), false).is_err());
    }
}
