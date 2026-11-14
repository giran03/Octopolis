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
    imp::open_verb(path, "open")
}

/// Runs a program or script directly (PowerShell `.ps1` scripts launch in
/// PowerShell instead of opening in an editor).
pub fn run_path(path: &Path) -> Result<()> {
    imp::run_path(path)
}

/// Opens a file in an editor: `editor` if given, else the file type's Edit
/// command, else Notepad. Never runs the file itself (scripts stay closed).
pub fn edit_path(path: &Path, editor: Option<&Path>) -> Result<()> {
    if let Some(editor) = editor {
        return std::process::Command::new(editor).arg(path).spawn().map(|_| ()).map_err(|e| Error::io(editor, e));
    }
    imp::open_verb(path, "edit").or_else(|_| std::process::Command::new("notepad.exe").arg(path).spawn().map(|_| ()).map_err(|e| Error::io(path, e)))
}

/// Opens several files in an editor. A chosen `editor` is started once with every file (so editors that group
/// files into one window do), else each file goes to its type's editor. Stops at the first failure.
pub fn edit_paths(paths: &[PathBuf], editor: Option<&Path>) -> Result<()> {
    match (editor, paths) {
        (_, []) => Ok(()),
        (Some(editor), _) => std::process::Command::new(editor).args(paths).spawn().map(|_| ()).map_err(|e| Error::io(editor, e)),
        (None, _) => paths.iter().try_for_each(|p| edit_path(p, None)),
    }
}

/// Opens a terminal in `dir`: Windows Terminal when it is installed, else PowerShell in its own window.
pub fn open_terminal_at(dir: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        if std::process::Command::new("wt.exe").arg("-d").arg(dir).spawn().is_ok() {
            return Ok(());
        }
        std::process::Command::new("powershell.exe").arg("-NoExit").current_dir(dir).creation_flags(CREATE_NEW_CONSOLE).spawn().map(|_| ()).map_err(|e| Error::io(dir, e))
    }
    #[cfg(not(windows))]
    {
        Err(Error::io(dir, std::io::Error::other("terminals are only supported on Windows")))
    }
}

/// Keeps Windows from sleeping (the screen may still turn off) until called
/// with `false`. Execution state belongs to a thread, so a dedicated thread
/// holds it for as long as it is needed.
pub fn keep_awake(on: bool) {
    use std::sync::Mutex;
    use std::sync::mpsc::{Sender, channel};
    static HOLDER: Mutex<Option<Sender<()>>> = Mutex::new(None);
    let mut holder = HOLDER.lock().unwrap_or_else(|e| e.into_inner());
    match (on, holder.is_some()) {
        (true, false) => {
            let (tx, rx) = channel::<()>();
            std::thread::spawn(move || {
                imp::set_awake(true);
                // Returns when the sender is dropped.
                let _ = rx.recv();
                imp::set_awake(false);
            });
            *holder = Some(tx);
        }
        (false, true) => *holder = None,
        _ => {}
    }
}

/// Opens Windows' font installer for a font file.
pub fn install_font(path: &Path) -> Result<()> {
    imp::open_verb(path, "install")
}

/// Shows Windows' "Open with" dialog for a file. Must be called on the UI
/// thread; `hwnd` is the owning window handle.
pub fn open_with(hwnd: isize, path: &Path) -> Result<()> {
    imp::open_with(hwnd, path)
}

/// Shows Windows' native folder picker dialog. Must be called on the UI thread;
/// `hwnd` is the owning window handle. Returns `Ok(None)` when cancelled.
pub fn pick_folder(hwnd: isize, initial: Option<&Path>) -> Result<Option<PathBuf>> {
    imp::pick_folder(hwnd, initial)
}

/// File types that can be started with administrator rights.
pub fn can_run_as_admin(path: &Path) -> bool {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    matches!(ext.as_str(), "exe" | "bat" | "cmd" | "msi" | "ps1" | "com")
}

/// Starts a program or script with administrator rights (Windows asks to confirm).
/// PowerShell scripts run in Windows PowerShell under the user's execution policy.
pub fn run_as_admin(path: &Path) -> Result<()> {
    if !can_run_as_admin(path) {
        return Err(Error::io(path, std::io::Error::other("only programs and scripts can run as administrator")));
    }
    imp::run_as_admin(path)
}

/// Safely ejects a removable drive (`E:\`): flushes, locks and dismounts the
/// volume, then ejects the media. Fails with "in use" if a program holds a
/// file open on it.
pub fn eject_drive(root: &Path) -> Result<()> {
    imp::eject_drive(root)
}

/// Opens Windows Explorer with `path` selected.
pub fn reveal_in_explorer(path: &Path) -> Result<()> {
    let mut arg = std::ffi::OsString::from("/select,");
    arg.push(path.as_os_str());
    // This File Explorer window is wanted: the optional catcher must not hand it back to Octopolis.
    crate::explorer_catch::pause(std::time::Duration::from_secs(5));
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

    pub fn set_awake(on: bool) {
        use windows::Win32::System::Power::{ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState};
        let flags = if on { ES_CONTINUOUS | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS };
        // SAFETY: only changes this thread's power request.
        unsafe { SetThreadExecutionState(flags) };
    }

    pub fn open_verb(path: &Path, verb: &str) -> Result<()> {
        let file = wide(path.as_os_str());
        let verb = wide(std::ffi::OsStr::new(verb));
        let dir = path.parent().map(|p| wide(p.as_os_str()));
        // SAFETY: all strings are NUL-terminated and live across the call.
        let code = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(verb.as_ptr()),
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

    pub fn open_with(hwnd: isize, path: &Path) -> Result<()> {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Shell::{OAIF_ALLOW_REGISTRATION, OAIF_EXEC, OAIF_REGISTER_EXT, OPENASINFO, SHOpenWithDialog};
        let file = wide(path.as_os_str());
        let info = OPENASINFO {
            pcszFile: PCWSTR(file.as_ptr()),
            pcszClass: PCWSTR::null(),
            oaifInFlags: OAIF_ALLOW_REGISTRATION | OAIF_REGISTER_EXT | OAIF_EXEC,
        };
        // SAFETY: `file` is NUL-terminated and outlives the modal dialog.
        match unsafe { SHOpenWithDialog(Some(HWND(hwnd as *mut _)), &info) } {
            Ok(()) => Ok(()),
            // Cancelling the dialog is not an error.
            Err(e) if e.code() == windows::Win32::Foundation::ERROR_CANCELLED.to_hresult() => Ok(()),
            Err(e) => Err(Error::io(path, e.into())),
        }
    }

    pub fn pick_folder(hwnd: isize, initial: Option<&Path>) -> Result<Option<PathBuf>> {
        use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
        use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize};
        use windows::Win32::UI::Shell::{
            FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName,
            SIGDN_FILESYSPATH,
        };
        struct Com(bool);
        impl Drop for Com {
            fn drop(&mut self) {
                if self.0 {
                    // SAFETY: balanced against CoInitializeEx below.
                    unsafe { CoUninitialize() };
                }
            }
        }
        let fallback = initial.unwrap_or_else(|| Path::new(""));
        let fail = |e: windows::core::Error| Error::io(fallback, e.into());
        // SAFETY: STA COM init on UI thread.
        let _com = Com(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok());
        // SAFETY: standard FileOpenDialog CLSID.
        let dialog: IFileOpenDialog = unsafe { CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER) }.map_err(fail)?;
        // SAFETY: setting folder-picker options on the newly created dialog.
        unsafe {
            let opts = dialog.GetOptions().map_err(fail)?;
            dialog.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST).map_err(fail)?;
            if let Some(dir) = initial.filter(|p| p.is_dir()) {
                let w = wide(dir.as_os_str());
                if let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(PCWSTR(w.as_ptr()), None) {
                    let _ = dialog.SetFolder(&item);
                }
            }
            match dialog.Show(Some(HWND(hwnd as *mut _))) {
                Ok(()) => {}
                Err(e) if e.code() == ERROR_CANCELLED.to_hresult() => return Ok(None),
                Err(e) => return Err(fail(e)),
            }
            let item = dialog.GetResult().map_err(fail)?;
            let ptr = item.GetDisplayName(SIGDN_FILESYSPATH).map_err(fail)?;
            let text = ptr.to_string().unwrap_or_default();
            CoTaskMemFree(Some(ptr.0 as _));
            Ok((!text.is_empty()).then(|| PathBuf::from(text)))
        }
    }

    fn launch_with_verb(path: &Path, verb: PCWSTR, access_denied_msg: Option<&str>) -> Result<()> {
        let is_ps1 = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("ps1"));
        let dir = path.parent().map(|p| wide(p.as_os_str()));
        // A .ps1 opens in an editor by default, so start PowerShell with the script instead.
        let (file, params) = if is_ps1 {
            let mut args = std::ffi::OsString::from("-NoProfile -NoExit -File \"");
            args.push(path.as_os_str());
            args.push("\"");
            (wide(std::ffi::OsStr::new("powershell.exe")), Some(wide(&args)))
        } else {
            (wide(path.as_os_str()), None)
        };
        // SAFETY: all strings are NUL-terminated and live across the call.
        let code = unsafe {
            ShellExecuteW(
                None,
                verb,
                PCWSTR(file.as_ptr()),
                params.as_ref().map_or(PCWSTR::null(), |p| PCWSTR(p.as_ptr())),
                dir.as_ref().map_or(PCWSTR::null(), |d| PCWSTR(d.as_ptr())),
                SW_SHOWNORMAL,
            )
        };
        const SE_ERR_ACCESSDENIED: isize = 5; // also returned when the user says No
        match code.0 as isize {
            c if c > SHELL_EXECUTE_OK => Ok(()),
            SE_ERR_ACCESSDENIED if access_denied_msg.is_some() => Err(Error::io(path, std::io::Error::other(access_denied_msg.unwrap()))),
            c => Err(Error::io(path, std::io::Error::other(format!("Windows could not start it (code {c})")))),
        }
    }

    pub fn run_path(path: &Path) -> Result<()> {
        launch_with_verb(path, w!("open"), None)
    }

    pub fn run_as_admin(path: &Path) -> Result<()> {
        launch_with_verb(path, w!("runas"), Some("administrator rights were not granted"))
    }

    pub fn eject_drive(root: &Path) -> Result<()> {
        use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE};
        use windows::Win32::Storage::FileSystem::{
            CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, FlushFileBuffers, OPEN_EXISTING,
        };
        use windows::Win32::System::IO::DeviceIoControl;
        use windows::Win32::System::Ioctl::{
            FSCTL_DISMOUNT_VOLUME, FSCTL_LOCK_VOLUME, IOCTL_STORAGE_EJECT_MEDIA, IOCTL_STORAGE_MEDIA_REMOVAL, PREVENT_MEDIA_REMOVAL,
        };

        let text = root.to_string_lossy();
        let letter = text.chars().next().filter(|c| c.is_ascii_alphabetic() && text.get(1..2) == Some(":"));
        let Some(letter) = letter else {
            return Err(Error::io(root, std::io::Error::other("only lettered drives can be ejected")));
        };
        let root_w = wide(std::ffi::OsStr::new(&format!("{letter}:\\")));
        // SAFETY: `root_w` is NUL-terminated.
        let kind = unsafe { GetDriveTypeW(PCWSTR(root_w.as_ptr())) };
        if kind != DRIVE_REMOVABLE && kind != DRIVE_CDROM {
            return Err(Error::io(root, std::io::Error::other("only removable drives (USB sticks, memory cards, discs) can be ejected")));
        }
        let volume = wide(std::ffi::OsStr::new(&format!("\\\\.\\{letter}:")));
        let fail = |what: &str, e: windows::core::Error| Error::io(root, std::io::Error::other(format!("{what} ({})", e.message())));
        // SAFETY: `volume` is NUL-terminated; the handle is closed on every path below.
        let handle = unsafe {
            CreateFileW(PCWSTR(volume.as_ptr()), (GENERIC_READ | GENERIC_WRITE).0, FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING, FILE_FLAGS_AND_ATTRIBUTES(0), None)
        }
        .map_err(|e| fail("the drive could not be opened", e))?;
        let ioctl = |code: u32, input: Option<(*const std::ffi::c_void, u32)>| -> windows::core::Result<()> {
            let mut returned = 0u32;
            let (ptr, len) = input.map_or((None, 0), |(p, l)| (Some(p), l));
            // SAFETY: `handle` is an open volume handle; `input` points at a live value of `len` bytes.
            unsafe { DeviceIoControl(handle, code, ptr, len, None, 0, Some(&mut returned), None) }
        };
        let result = (|| {
            // SAFETY: flushing an open handle.
            let _ = unsafe { FlushFileBuffers(handle) };
            // Locking fails while a program has a file open; retry briefly for short-lived handles.
            let mut locked = ioctl(FSCTL_LOCK_VOLUME, None);
            for _ in 0..10 {
                if locked.is_ok() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
                locked = ioctl(FSCTL_LOCK_VOLUME, None);
            }
            locked.map_err(|e| fail("the drive is in use — close files and programs using it, then try again", e))?;
            ioctl(FSCTL_DISMOUNT_VOLUME, None).map_err(|e| fail("the drive could not be dismounted", e))?;
            let allow = PREVENT_MEDIA_REMOVAL { PreventMediaRemoval: false };
            let _ = ioctl(IOCTL_STORAGE_MEDIA_REMOVAL, Some((&allow as *const _ as *const _, size_of::<PREVENT_MEDIA_REMOVAL>() as u32)));
            ioctl(IOCTL_STORAGE_EJECT_MEDIA, None).map_err(|e| fail("the drive could not be ejected", e))
        })();
        // SAFETY: closing the handle opened above.
        let _ = unsafe { CloseHandle(handle) };
        result
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

    pub fn open_with(_: isize, path: &Path) -> Result<()> {
        open_path(path)
    }

    pub fn pick_folder(_: isize, _: Option<&Path>) -> Result<Option<PathBuf>> {
        Ok(None)
    }

    pub fn run_path(path: &Path) -> Result<()> {
        open_path(path)
    }

    pub fn run_as_admin(path: &Path) -> Result<()> {
        Err(Error::io(path, std::io::Error::other("not supported on this system")))
    }

    pub fn eject_drive(root: &Path) -> Result<()> {
        Err(Error::io(root, std::io::Error::other("not supported on this system")))
    }

    pub fn set_awake(_: bool) {}

    pub fn open_verb(path: &Path, _: &str) -> Result<()> {
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

    #[test]
    fn only_programs_and_scripts_run_as_admin() {
        use std::path::Path;
        assert!(super::can_run_as_admin(Path::new("C:\\x\\setup.EXE")));
        assert!(super::can_run_as_admin(Path::new("C:\\x\\fix.ps1")));
        assert!(!super::can_run_as_admin(Path::new("C:\\x\\notes.txt")));
        assert!(super::run_as_admin(Path::new("C:\\x\\notes.txt")).is_err());
    }

    #[test]
    fn eject_refuses_non_drive_paths() {
        assert!(super::eject_drive(std::path::Path::new("\\\\server\\share")).is_err());
        // The system drive is fixed, so it is refused before anything touches it.
        let sys = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        let err = super::eject_drive(std::path::Path::new(&format!("{sys}\\"))).unwrap_err();
        assert!(err.to_string().contains("removable"), "{err}");
    }
}
