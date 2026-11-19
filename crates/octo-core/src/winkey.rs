//! Win+E fallback for "Use Octopolis instead of File Explorer".
//!
//! Newer Windows 11 builds no longer read the registry entry that redirects
//! Win+E, so while that mode is on Octopolis also catches the combination
//! itself. It uses a low-level keyboard hook that looks at one thing only: an E
//! key-down while Win is held and nothing else is. Every other key passes
//! through untouched and is never stored or read further.

use std::sync::Mutex;

type Callback = std::sync::Arc<dyn Fn() + Send + Sync>;

struct Shared {
    on_press: Option<Callback>,
    worker: Option<imp::Worker>,
}

static SHARED: Mutex<Shared> = Mutex::new(Shared { on_press: None, worker: None });

fn shared() -> std::sync::MutexGuard<'static, Shared> {
    SHARED.lock().unwrap_or_else(|e| e.into_inner())
}

/// Starts (`Some`) or stops (`None`) catching Win+E. `on_press` runs on its own
/// thread each time the combination is caught.
pub fn set(on_press: Option<impl Fn() + Send + Sync + 'static>) {
    let mut s = shared();
    match on_press {
        Some(f) => {
            s.on_press = Some(std::sync::Arc::new(f));
            if s.worker.is_none() {
                s.worker = imp::start();
            }
        }
        None => {
            s.on_press = None;
            let old = s.worker.take();
            drop(s);
            if let Some(w) = old {
                w.stop();
            }
        }
    }
}

/// Whether the key event is the Win+E press to take over.
pub fn is_win_e(vk_is_e: bool, win_held: bool, ctrl_shift_alt_held: bool) -> bool {
    vk_is_e && win_held && !ctrl_shift_alt_held
}

#[cfg_attr(not(windows), allow(dead_code))]
fn pressed() {
    let callback = shared().on_press.clone();
    if let Some(f) = callback {
        std::thread::spawn(move || f());
    }
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::thread::JoinHandle;

    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VK_CONTROL, VK_E, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, keybd_event,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, KBDLLHOOKSTRUCT, MSG, PM_NOREMOVE, PeekMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
        WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    use super::{is_win_e, pressed};

    /// An E key-down was taken, so its key-up is taken too.
    static SWALLOWING: AtomicBool = AtomicBool::new(false);

    pub struct Worker {
        thread_id: u32,
        handle: JoinHandle<()>,
    }

    impl Worker {
        pub fn stop(self) {
            // SAFETY: asks the thread's message loop to end.
            let _ = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
            let _ = self.handle.join();
        }
    }

    fn down(vk: u16) -> bool {
        // SAFETY: plain key state query.
        unsafe { GetAsyncKeyState(i32::from(vk)) < 0 }
    }

    unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            // SAFETY: for WH_KEYBOARD_LL, lparam points at a KBDLLHOOKSTRUCT for the duration of the call.
            let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            if info.vkCode == u32::from(VK_E.0) {
                let msg = wparam.0 as u32;
                if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                    let win = down(VK_LWIN.0) || down(VK_RWIN.0);
                    let others = down(VK_CONTROL.0) || down(VK_SHIFT.0) || down(VK_MENU.0);
                    if is_win_e(true, win, others) {
                        SWALLOWING.store(true, Ordering::Relaxed);
                        // A key pressed in between stops Windows opening the Start menu when Win is let go.
                        // SAFETY: plain synthetic key press of an unassigned key.
                        unsafe {
                            keybd_event(0xFF, 0, KEYBD_EVENT_FLAGS(0), 0);
                            keybd_event(0xFF, 0, KEYEVENTF_KEYUP, 0);
                        }
                        pressed();
                        return LRESULT(1);
                    }
                } else if (msg == WM_KEYUP || msg == WM_SYSKEYUP) && SWALLOWING.swap(false, Ordering::Relaxed) {
                    return LRESULT(1);
                } else if SWALLOWING.load(Ordering::Relaxed) {
                    // Auto-repeat of a swallowed key-down.
                    return LRESULT(1);
                }
            }
        }
        // SAFETY: passes the event on unchanged.
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    fn run(ready: mpsc::Sender<Option<u32>>) {
        // SAFETY: the hook belongs to this thread and is removed before it ends.
        unsafe {
            let mut msg = MSG::default();
            let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
            let installed = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), None, 0);
            let _ = ready.send(installed.as_ref().ok().map(|_| GetCurrentThreadId()));
            let Ok(installed) = installed else { return };
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
            let _ = UnhookWindowsHookEx(installed);
        }
    }

    pub fn start() -> Option<Worker> {
        let (tx, rx) = mpsc::channel();
        let handle = std::thread::spawn(move || run(tx));
        let thread_id = rx.recv().ok()??;
        Some(Worker { thread_id, handle })
    }
}

#[cfg(not(windows))]
mod imp {
    pub struct Worker;
    impl Worker {
        pub fn stop(self) {}
    }
    pub fn start() -> Option<Worker> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_win_e_is_taken() {
        assert!(is_win_e(true, true, false));
        assert!(!is_win_e(true, false, false), "plain E is typing");
        assert!(!is_win_e(true, true, true), "Win+Ctrl+E belongs to Windows");
        assert!(!is_win_e(false, true, false));
    }

    /// Needs a desktop session: sends a real Win+E and checks the hook takes it.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn hook_takes_a_real_win_e() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use windows::Win32::UI::Input::KeyboardAndMouse::{KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, keybd_event};
        static HITS: AtomicUsize = AtomicUsize::new(0);
        set(Some(|| {
            HITS.fetch_add(1, Ordering::SeqCst);
        }));
        std::thread::sleep(std::time::Duration::from_millis(500));
        // SAFETY: synthetic key presses for the test.
        unsafe {
            keybd_event(0x5B, 0, KEYBD_EVENT_FLAGS(0), 0);
            keybd_event(0x45, 0, KEYBD_EVENT_FLAGS(0), 0);
            keybd_event(0x45, 0, KEYEVENTF_KEYUP, 0);
            keybd_event(0x5B, 0, KEYEVENTF_KEYUP, 0);
        }
        std::thread::sleep(std::time::Duration::from_millis(1500));
        set(None::<fn()>);
        assert_eq!(HITS.load(Ordering::SeqCst), 1);
    }
}
