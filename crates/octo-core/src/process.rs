//! Which program a window belongs to. Uses only the limited query right, which
//! reads nothing from the other process.

/// Process id of the program that owns `hwnd`, or 0 if the window is gone.
pub fn window_pid(hwnd: isize) -> u32 {
    imp::window_pid(hwnd)
}

/// File name of a running program, e.g. `notepad.exe`.
pub fn image_name(pid: u32) -> Option<String> {
    imp::image_name(pid)
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    use windows::core::PWSTR;

    pub fn window_pid(hwnd: isize) -> u32 {
        let mut pid = 0;
        // SAFETY: plain window query.
        unsafe { GetWindowThreadProcessId(HWND(hwnd as *mut core::ffi::c_void), Some(&mut pid)) };
        pid
    }

    pub fn image_name(pid: u32) -> Option<String> {
        // SAFETY: the handle is closed before returning; the buffer is local.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(process);
            if !ok {
                return None;
            }
            let path = String::from_utf16_lossy(&buf[..(len as usize).min(buf.len())]);
            Some(path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string())
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn window_pid(_: isize) -> u32 {
        0
    }
    pub fn image_name(_: u32) -> Option<String> {
        None
    }
}
