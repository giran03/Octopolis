//! The summon shortcut: a system-wide key that brings Octopolis forward.
//! Ctrl+E is only caught while the desktop or taskbar has focus, so other
//! apps keep their own Ctrl+E; Ctrl+Alt+E works everywhere.

use std::sync::Mutex;

/// Which summon shortcut is active.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Summon {
    Off,
    /// Ctrl+E on the desktop or taskbar only.
    CtrlEDesktop,
    /// Ctrl+Alt+E anywhere; pressing it in Octopolis hides it again.
    CtrlAltE,
}

impl Summon {
    pub fn parse(s: &str) -> Summon {
        match s {
            "ctrlE" => Summon::CtrlEDesktop,
            "ctrlAltE" => Summon::CtrlAltE,
            _ => Summon::Off,
        }
    }
}

/// Window classes of the desktop and taskbars.
pub fn is_desktop_class(class: &str) -> bool {
    matches!(class, "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
}

/// Whether a key press matches the shortcut. `in_desktop` is whether the
/// desktop or taskbar is the foreground window.
pub fn matches(mode: Summon, key_e: bool, ctrl: bool, alt: bool, shift: bool, win: bool, in_desktop: bool) -> bool {
    if !key_e || shift || win {
        return false;
    }
    match mode {
        Summon::Off => false,
        Summon::CtrlEDesktop => ctrl && !alt && in_desktop,
        Summon::CtrlAltE => ctrl && alt,
    }
}

type Callback = Box<dyn Fn() + Send + Sync>;

struct Shared {
    mode: Summon,
    on_press: Option<Callback>,
    thread_id: Option<u32>,
}

static SHARED: Mutex<Shared> = Mutex::new(Shared { mode: Summon::Off, on_press: None, thread_id: None });

fn shared() -> std::sync::MutexGuard<'static, Shared> {
    SHARED.lock().unwrap_or_else(|e| e.into_inner())
}

/// Sets the summon shortcut. `on_press` runs (on the hook thread) each time
/// it is pressed; keep it quick. `Summon::Off` removes the hook.
pub fn set(mode: Summon, on_press: impl Fn() + Send + Sync + 'static) {
    let mut s = shared();
    s.mode = mode;
    s.on_press = Some(Box::new(on_press));
    let running = s.thread_id.is_some();
    drop(s);
    match (mode, running) {
        (Summon::Off, true) => imp::stop(),
        (Summon::Off, false) => {}
        (_, false) => imp::start(),
        (_, true) => {}
    }
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_E, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetClassNameW, GetForegroundWindow, GetMessageW, HHOOK, KBDLLHOOKSTRUCT, MSG, PostThreadMessageW,
        SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WH_KEYBOARD_LL, WM_KEYDOWN, WM_QUIT, WM_SYSKEYDOWN,
    };

    use super::{is_desktop_class, matches, shared};

    fn down(vk: u16) -> bool {
        // SAFETY: plain key-state query.
        (unsafe { GetAsyncKeyState(i32::from(vk)) } as u16 & 0x8000) != 0
    }

    fn foreground_is_desktop() -> bool {
        // SAFETY: plain window queries into a local buffer.
        unsafe {
            let hwnd = GetForegroundWindow();
            let mut buf = [0u16; 64];
            let n = GetClassNameW(hwnd, &mut buf) as usize;
            is_desktop_class(&String::from_utf16_lossy(&buf[..n.min(buf.len())]))
        }
    }

    unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && (wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN) {
            // SAFETY: for WH_KEYBOARD_LL, lparam points at a KBDLLHOOKSTRUCT.
            let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            if info.vkCode == u32::from(VK_E.0) {
                let s = shared();
                let hit = matches(
                    s.mode,
                    true,
                    down(VK_CONTROL.0),
                    down(VK_MENU.0),
                    down(VK_SHIFT.0),
                    down(VK_LWIN.0) || down(VK_RWIN.0),
                    // Only look up the window class when it matters.
                    s.mode == super::Summon::CtrlEDesktop && foreground_is_desktop(),
                );
                if hit {
                    if let Some(f) = &s.on_press {
                        f();
                    }
                    return LRESULT(1); // the key was ours; don't pass it on
                }
            }
        }
        // SAFETY: forwarding to the next hook as required.
        unsafe { CallNextHookEx(None::<HHOOK>, code, wparam, lparam) }
    }

    pub fn start() {
        std::thread::spawn(|| {
            // SAFETY: the hook lives on this thread, which runs a message loop until WM_QUIT.
            unsafe {
                let Ok(handle) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), None, 0) else { return };
                shared().thread_id = Some(GetCurrentThreadId());
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                let _ = UnhookWindowsHookEx(handle);
            }
        });
    }

    pub fn stop() {
        let id = shared().thread_id.take();
        if let Some(id) = id {
            // SAFETY: asks the hook thread's message loop to end.
            let _ = unsafe { PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0)) };
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn start() {}
    pub fn stop() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctrl_e_only_counts_on_the_desktop() {
        assert!(matches(Summon::CtrlEDesktop, true, true, false, false, false, true));
        assert!(!matches(Summon::CtrlEDesktop, true, true, false, false, false, false), "Ctrl+E in a browser stays the browser's");
        assert!(!matches(Summon::CtrlEDesktop, true, true, true, false, false, true));
    }

    #[test]
    fn ctrl_alt_e_works_anywhere_but_not_with_extra_keys() {
        assert!(matches(Summon::CtrlAltE, true, true, true, false, false, false));
        assert!(!matches(Summon::CtrlAltE, true, true, true, true, false, false));
        assert!(!matches(Summon::CtrlAltE, false, true, true, false, false, false));
        assert!(!matches(Summon::Off, true, true, true, false, false, true));
    }

    #[test]
    fn recognises_desktop_windows() {
        assert!(is_desktop_class("Progman") && is_desktop_class("Shell_TrayWnd"));
        assert!(!is_desktop_class("Chrome_WidgetWin_1"));
        assert_eq!(Summon::parse("ctrlE"), Summon::CtrlEDesktop);
        assert_eq!(Summon::parse("nonsense"), Summon::Off);
    }
}
