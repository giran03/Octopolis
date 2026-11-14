//! The summon shortcut: a system-wide key that brings Octopolis forward.
//! It is a registered hotkey, not a keyboard hook: Octopolis never sees typing.
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

/// Whether Ctrl+E should be claimed right now: only in desktop mode, and only
/// while the desktop or taskbar is the foreground window.
pub fn wants_ctrl_e(mode: Summon, in_desktop: bool) -> bool {
    mode == Summon::CtrlEDesktop && in_desktop
}

type Callback = Box<dyn Fn() + Send + Sync>;

struct Shared {
    mode: Summon,
    on_press: Option<Callback>,
    worker: Option<imp::Worker>,
}

static SHARED: Mutex<Shared> = Mutex::new(Shared { mode: Summon::Off, on_press: None, worker: None });

fn shared() -> std::sync::MutexGuard<'static, Shared> {
    SHARED.lock().unwrap_or_else(|e| e.into_inner())
}

/// Sets the summon shortcut. `on_press` runs (on the shortcut thread) each
/// time it is pressed; keep it quick. `Summon::Off` releases the shortcut.
pub fn set(mode: Summon, on_press: impl Fn() + Send + Sync + 'static) {
    let mut s = shared();
    let unchanged = s.mode == mode && s.worker.is_some();
    s.mode = mode;
    s.on_press = Some(Box::new(on_press));
    if unchanged {
        return;
    }
    let old = s.worker.take();
    drop(s);
    // The old thread must let go of its shortcut before a new one registers.
    if let Some(worker) = old {
        worker.stop();
    }
    if mode != Summon::Off {
        let worker = imp::start(mode);
        shared().worker = worker;
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn pressed() {
    if let Some(f) = &shared().on_press {
        f();
    }
}

/// The shortcut is claimed with `RegisterHotKey`, so Windows only reports that
/// one key combination. Ctrl+E is registered only while the desktop or taskbar
/// is in front (tracked with an out-of-context foreground event).
#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::thread::JoinHandle;

    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
    use windows::Win32::UI::Input::KeyboardAndMouse::{MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, RegisterHotKey, UnregisterHotKey, VK_E};
    use windows::Win32::UI::WindowsAndMessaging::{
        EVENT_SYSTEM_FOREGROUND, GetClassNameW, GetForegroundWindow, GetMessageW, MSG, PM_NOREMOVE, PeekMessageW, PostThreadMessageW, WINEVENT_OUTOFCONTEXT,
        WM_HOTKEY, WM_QUIT,
    };

    use super::{Summon, is_desktop_class, pressed, wants_ctrl_e};

    const HOTKEY_ID: i32 = 1;
    /// Whether the shortcut thread currently holds Ctrl+E. Only that thread touches it.
    static CTRL_E_HELD: AtomicBool = AtomicBool::new(false);

    pub struct Worker {
        thread_id: u32,
        handle: JoinHandle<()>,
    }

    impl Worker {
        /// Ends the shortcut thread and waits until it has released its shortcut.
        pub fn stop(self) {
            // SAFETY: asks the thread's message loop to end.
            let _ = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
            let _ = self.handle.join();
        }
    }

    fn is_desktop(hwnd: HWND) -> bool {
        let mut buf = [0u16; 64];
        // SAFETY: plain window query into a local buffer.
        let n = unsafe { GetClassNameW(hwnd, &mut buf) } as usize;
        is_desktop_class(&String::from_utf16_lossy(&buf[..n.min(buf.len())]))
    }

    /// Claims or releases Ctrl+E to match the foreground window.
    fn sync_ctrl_e(foreground: HWND) {
        let want = wants_ctrl_e(Summon::CtrlEDesktop, is_desktop(foreground));
        if want == CTRL_E_HELD.load(Ordering::Relaxed) {
            return;
        }
        // SAFETY: registers or releases a shortcut owned by this thread.
        let done = unsafe {
            if want { RegisterHotKey(None, HOTKEY_ID, MOD_CONTROL | MOD_NOREPEAT, u32::from(VK_E.0)) } else { UnregisterHotKey(None, HOTKEY_ID) }
        };
        if done.is_ok() {
            CTRL_E_HELD.store(want, Ordering::Relaxed);
        }
    }

    unsafe extern "system" fn on_foreground(_: HWINEVENTHOOK, _: u32, hwnd: HWND, _: i32, _: i32, _: u32, _: u32) {
        sync_ctrl_e(hwnd);
    }

    fn run(mode: Summon, ready: mpsc::Sender<u32>) {
        // SAFETY: everything registered here belongs to this thread and is released before it ends.
        unsafe {
            let mut msg = MSG::default();
            // Creates the message queue, so the thread id can be posted to straight away.
            let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
            let _ = ready.send(GetCurrentThreadId());
            CTRL_E_HELD.store(false, Ordering::Relaxed);
            let watcher = if mode == Summon::CtrlAltE {
                let _ = RegisterHotKey(None, HOTKEY_ID, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, u32::from(VK_E.0));
                None
            } else {
                // Out of context: the callback runs on this thread, and nothing is loaded into other apps.
                let hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, Some(on_foreground), 0, 0, WINEVENT_OUTOFCONTEXT);
                sync_ctrl_e(GetForegroundWindow());
                Some(hook)
            };
            // The foreground callback is delivered while this loop waits; thread messages need no dispatching.
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                if msg.message == WM_HOTKEY {
                    pressed();
                }
            }
            if let Some(hook) = watcher {
                let _ = UnhookWinEvent(hook);
            }
            let _ = UnregisterHotKey(None, HOTKEY_ID);
        }
    }

    pub fn start(mode: Summon) -> Option<Worker> {
        let (tx, rx) = mpsc::channel();
        let handle = std::thread::spawn(move || run(mode, tx));
        let thread_id = rx.recv().ok()?;
        Some(Worker { thread_id, handle })
    }
}

#[cfg(not(windows))]
mod imp {
    pub struct Worker;
    impl Worker {
        pub fn stop(self) {}
    }
    pub fn start(_: super::Summon) -> Option<Worker> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctrl_e_is_only_claimed_on_the_desktop() {
        assert!(wants_ctrl_e(Summon::CtrlEDesktop, true));
        assert!(!wants_ctrl_e(Summon::CtrlEDesktop, false), "Ctrl+E in a browser stays the browser's");
        assert!(!wants_ctrl_e(Summon::CtrlAltE, true));
        assert!(!wants_ctrl_e(Summon::Off, true));
    }

    #[test]
    fn recognises_desktop_windows() {
        assert!(is_desktop_class("Progman") && is_desktop_class("Shell_TrayWnd"));
        assert!(!is_desktop_class("Chrome_WidgetWin_1"));
        assert_eq!(Summon::parse("ctrlE"), Summon::CtrlEDesktop);
        assert_eq!(Summon::parse("nonsense"), Summon::Off);
    }
}
