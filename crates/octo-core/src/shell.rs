//! Shell integration: open items with their default handler and list drives.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriveKind {
    Fixed,
    Removable,
    Network,
    Optical,
    Ram,
    Unknown,
}

#[derive(Debug, Clone)]
pub struct Drive {
    /// Root path such as `C:\`.
    pub root: PathBuf,
    pub label: String,
    pub file_system: String,
    pub kind: DriveKind,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

/// Opens a file with its associated app, or a folder in its default handler.
pub fn open_path(path: &Path) -> Result<()> {
    imp::open_path(path)
}

/// Opens Windows Explorer with `path` selected.
pub fn reveal_in_explorer(path: &Path) -> Result<()> {
    let mut arg = std::ffi::OsString::from("/select,");
    arg.push(path.as_os_str());
    std::process::Command::new("explorer.exe")
        .arg(arg)
        .spawn()
        .map(|_| ())
        .map_err(|e| Error::io(path, e))
}

pub fn list_drives() -> Vec<Drive> {
    imp::list_drives()
}

/// Shows the classic Windows context menu for `paths` (all in one folder) at
/// the mouse position, and runs what the user picks. Must be called on the UI
/// thread. `hwnd` is the owning window handle.
pub fn show_native_menu(hwnd: isize, paths: &[PathBuf]) -> Result<()> {
    imp::show_native_menu(hwnd, paths)
}

/// Stops Windows from showing "There is no disk in the drive" dialogs when
/// an empty card reader or optical drive is queried. Call once at startup.
pub fn suppress_drive_error_dialogs() {
    #[cfg(windows)]
    {
        use windows::Win32::System::Diagnostics::Debug::{SEM_FAILCRITICALERRORS, SEM_NOOPENFILEERRORBOX, SetErrorMode};
        // SAFETY: SetErrorMode only changes this process's error-mode flags.
        unsafe {
            SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX);
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::path::{Path, PathBuf};

    use windows::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDriveStringsW, GetVolumeInformationW,
    };
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::{PCWSTR, w};

    use super::{Drive, DriveKind};
    use crate::error::{Error, Result};

    // GetDriveTypeW return values.
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_REMOTE: u32 = 4;
    const DRIVE_CDROM: u32 = 5;
    const DRIVE_RAMDISK: u32 = 6;
    /// ShellExecuteW returns a value greater than 32 on success.
    const SHELL_EXECUTE_OK: isize = 32;

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn from_wide(buf: &[u16]) -> String {
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..len])
    }

    pub fn open_path(path: &Path) -> Result<()> {
        let file = wide(path.as_os_str());
        let dir = path.parent().map(|p| wide(p.as_os_str()));
        // SAFETY: all strings are NUL-terminated and live across the call.
        let code = unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                PCWSTR(file.as_ptr()),
                PCWSTR::null(),
                dir.as_ref().map_or(PCWSTR::null(), |d| PCWSTR(d.as_ptr())),
                SW_SHOWNORMAL,
            )
        };
        if code.0 as isize > SHELL_EXECUTE_OK {
            Ok(())
        } else {
            Err(Error::io(path, std::io::Error::other(format!("the shell could not open it (code {})", code.0 as isize))))
        }
    }

    pub fn show_native_menu(hwnd: isize, paths: &[PathBuf]) -> Result<()> {
        use windows::Win32::Foundation::{HWND, POINT};
        use windows::Win32::System::Com::CoTaskMemFree;
        use windows::Win32::UI::Shell::Common::ITEMIDLIST;
        use windows::Win32::UI::Shell::{CMF_NORMAL, CMINVOKECOMMANDINFO, IContextMenu, IShellFolder, SHBindToParent, SHParseDisplayName};
        use windows::Win32::UI::WindowsAndMessaging::{
            CreatePopupMenu, DestroyMenu, GetCursorPos, SetForegroundWindow, TPM_RETURNCMD, TPM_RIGHTBUTTON, TrackPopupMenuEx,
        };
        use windows::core::PCSTR;

        let first = paths.first().ok_or_else(|| Error::NotFound(PathBuf::new()))?;
        let fail = |e: windows::core::Error| Error::io(first, e.into());
        let owner = HWND(hwnd as *mut _);
        let mut absolute: Vec<*mut ITEMIDLIST> = Vec::new();
        let result = (|| -> Result<()> {
            for p in paths {
                let wide = wide(p.as_os_str());
                let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
                // SAFETY: `wide` is NUL-terminated; `pidl` receives memory we free below.
                unsafe { SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut pidl, 0, None) }.map_err(fail)?;
                absolute.push(pidl);
            }
            let mut children: Vec<*const ITEMIDLIST> = Vec::new();
            let mut folder: Option<IShellFolder> = None;
            for pidl in &absolute {
                let mut child: *mut ITEMIDLIST = std::ptr::null_mut();
                // SAFETY: `pidl` is a valid absolute PIDL; `child` points inside it.
                let parent: IShellFolder = unsafe { SHBindToParent(*pidl, Some(&mut child)) }.map_err(fail)?;
                children.push(child);
                folder.get_or_insert(parent);
            }
            let folder = folder.ok_or_else(|| Error::NotFound(first.clone()))?;
            // SAFETY: the child PIDLs stay valid while `absolute` is alive.
            let menu: IContextMenu = unsafe { folder.GetUIObjectOf(owner, &children, None) }.map_err(fail)?;
            // SAFETY: plain Win32 menu calls on a menu we create and destroy.
            unsafe {
                let popup = CreatePopupMenu().map_err(fail)?;
                let picked = (|| -> Result<i32> {
                    menu.QueryContextMenu(popup, 0, 1, 0x7FFF, CMF_NORMAL).ok().map_err(fail)?;
                    let mut at = POINT::default();
                    GetCursorPos(&mut at).map_err(fail)?;
                    let _ = SetForegroundWindow(owner);
                    Ok(TrackPopupMenuEx(popup, (TPM_RETURNCMD | TPM_RIGHTBUTTON).0, at.x, at.y, owner, None).0)
                })();
                let result = match picked {
                    Ok(cmd) if cmd > 0 => {
                        let info = CMINVOKECOMMANDINFO {
                            cbSize: size_of::<CMINVOKECOMMANDINFO>() as u32,
                            hwnd: owner,
                            // MAKEINTRESOURCE: the verb is the command offset.
                            lpVerb: PCSTR((cmd - 1) as usize as *const u8),
                            nShow: SW_SHOWNORMAL.0,
                            ..Default::default()
                        };
                        menu.InvokeCommand(&info).map_err(fail)
                    }
                    Ok(_) => Ok(()),
                    Err(e) => Err(e),
                };
                let _ = DestroyMenu(popup);
                result
            }
        })();
        for pidl in absolute {
            // SAFETY: allocated by SHParseDisplayName above.
            unsafe { CoTaskMemFree(Some(pidl as *const _)) };
        }
        result
    }

    pub fn list_drives() -> Vec<Drive> {
        let mut buf = [0u16; 512];
        // SAFETY: the buffer is valid for its full length.
        let len = unsafe { GetLogicalDriveStringsW(Some(&mut buf)) } as usize;
        buf[..len.min(buf.len())]
            .split(|&c| c == 0)
            .filter(|s| !s.is_empty())
            .map(|root| describe(String::from_utf16_lossy(root)))
            .collect()
    }

    fn describe(root: String) -> Drive {
        let root_w: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
        let root_p = PCWSTR(root_w.as_ptr());
        // SAFETY: `root_w` is NUL-terminated for every call below.
        let kind = match unsafe { GetDriveTypeW(root_p) } {
            DRIVE_FIXED => DriveKind::Fixed,
            DRIVE_REMOVABLE => DriveKind::Removable,
            DRIVE_REMOTE => DriveKind::Network,
            DRIVE_CDROM => DriveKind::Optical,
            DRIVE_RAMDISK => DriveKind::Ram,
            _ => DriveKind::Unknown,
        };
        let mut label = [0u16; 261];
        let mut fs_name = [0u16; 261];
        // Empty optical drives fail here; that just leaves the label blank.
        let _ = unsafe { GetVolumeInformationW(root_p, Some(&mut label), None, None, None, Some(&mut fs_name)) };
        let (mut free, mut total) = (0u64, 0u64);
        let _ = unsafe { GetDiskFreeSpaceExW(root_p, Some(&mut free), Some(&mut total), None) };
        Drive {
            root: PathBuf::from(&root),
            label: from_wide(&label),
            file_system: from_wide(&fs_name),
            kind,
            total_bytes: total,
            free_bytes: free,
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::path::{Path, PathBuf};

    use super::{Drive, DriveKind};
    use crate::error::{Error, Result};

    pub fn show_native_menu(_: isize, _: &[PathBuf]) -> Result<()> {
        Ok(())
    }

    pub fn open_path(path: &Path) -> Result<()> {
        std::process::Command::new("xdg-open").arg(path).spawn().map(|_| ()).map_err(|e| Error::io(path, e))
    }

    pub fn list_drives() -> Vec<Drive> {
        vec![Drive {
            root: PathBuf::from("/"),
            label: String::new(),
            file_system: String::new(),
            kind: DriveKind::Fixed,
            total_bytes: 0,
            free_bytes: 0,
        }]
    }
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn lists_at_least_the_system_drive() {
        let drives = super::list_drives();
        let sys = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        assert!(
            drives.iter().any(|d| d.root.to_string_lossy().eq_ignore_ascii_case(&format!("{sys}\\"))),
            "{drives:?}"
        );
        assert!(drives.iter().any(|d| d.total_bytes > 0));
    }
}
