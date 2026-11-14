//! Optional: hands new File Explorer folder windows over to Octopolis.
//!
//! Some requests never reach the folder-open setting: "Show in folder" for a
//! folder no Octopolis tab is showing, and apps that start `explorer.exe`
//! themselves. Windows opens a File Explorer window for those. With this on,
//! Octopolis is told when a new File Explorer window registers (the shell
//! windows table's own event), reads its folder and selection through the
//! documented scripting interfaces, closes it, and reports what to open.
//!
//! Nothing is loaded into File Explorer or any other app. Windows that show a
//! place that is not a real folder (Control Panel, This PC), windows that were
//! already open, and extra tabs of an existing window are left alone.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// A File Explorer window that was handed over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caught {
    pub folder: String,
    /// Full paths of the items that were selected in it.
    pub selected: Vec<String>,
}

/// The folder path behind a `file:` address as File Explorer reports it, or
/// `None` for anything else (an empty address means a place that is not a folder).
pub fn path_from_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file:")?;
    let rest = rest.strip_prefix("//")?;
    let (host, path) = match rest.strip_prefix('/') {
        Some(local) => ("", local),
        None => rest.split_once('/').unwrap_or((rest, "")),
    };
    let decoded = percent_decode(path)?.replace('/', "\\");
    if host.is_empty() {
        // "C:/Users/x" -> "C:\Users\x"; anything without a drive is not a local folder.
        let b = decoded.as_bytes();
        if b.len() < 2 || !b[0].is_ascii_alphabetic() || b[1] != b':' {
            return None;
        }
        Some(if decoded.len() == 2 { format!("{decoded}\\") } else { decoded })
    } else {
        Some(format!("\\\\{host}\\{decoded}"))
    }
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Until when new windows are left alone (milliseconds since the Unix epoch).
static PAUSED_UNTIL: AtomicU64 = AtomicU64::new(0);

/// Leaves new File Explorer windows alone for a while. Call just before
/// Octopolis itself opens one on purpose ("Show in File Explorer").
pub fn pause(time: Duration) {
    PAUSED_UNTIL.store(now_ms() + time.as_millis() as u64, Ordering::Relaxed);
}

fn paused() -> bool {
    now_ms() < PAUSED_UNTIL.load(Ordering::Relaxed)
}

static WORKER: Mutex<Option<imp::Worker>> = Mutex::new(None);

/// Turns catching on or off. `on_caught` runs on a background thread.
pub fn set(enabled: bool, on_caught: impl Fn(Caught) + Send + Sync + 'static) {
    let mut worker = WORKER.lock().unwrap_or_else(|e| e.into_inner());
    match (enabled, worker.is_some()) {
        (true, false) => *worker = Some(imp::Worker::start(Box::new(on_caught))),
        (false, true) => {
            if let Some(w) = worker.take() {
                w.stop();
            }
        }
        _ => {}
    }
}

#[cfg(windows)]
mod imp {
    #![allow(non_snake_case)]

    use std::collections::HashSet;
    use std::ffi::c_void;
    use std::sync::mpsc::{Receiver, Sender, channel};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::{DISP_E_UNKNOWNNAME, E_NOTIMPL, HWND};
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize, DISPATCH_FLAGS, DISPPARAMS, EXCEPINFO, IConnectionPoint,
        IConnectionPointContainer, IDispatch, IDispatch_Impl, ITypeInfo,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Shell::{IShellFolderViewDual, IShellWindows, IWebBrowserApp, ShellWindows};
    use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, IsWindow, SW_HIDE, SW_SHOW, ShowWindow};
    use windows::core::{GUID, Interface, PCWSTR, Result, implement};

    use super::{Caught, path_from_url, paused};

    /// The shell windows table's event interface, and its "a window registered" event.
    const DIID_SHELL_WINDOWS_EVENTS: GUID = GUID::from_u128(0xFE4106E0_399A_11D0_A48C_00A0C90A8F39);
    const DISPID_WINDOW_REGISTERED: i32 = 200;
    /// How long a new window gets to say which folder it shows.
    const LOCATION_WAIT: Duration = Duration::from_millis(1500);
    /// How long to wait for the app that opened it to select its file.
    const SELECTION_WAIT: Duration = Duration::from_millis(600);
    const STEP: Duration = Duration::from_millis(40);

    enum Msg {
        Registered,
        Stop,
    }

    /// Receives the shell windows table's events and passes them to the worker.
    #[implement(IDispatch)]
    struct Sink {
        events: Sender<Msg>,
    }

    impl IDispatch_Impl for Sink_Impl {
        fn GetTypeInfoCount(&self) -> Result<u32> {
            Ok(0)
        }
        fn GetTypeInfo(&self, _: u32, _: u32) -> Result<ITypeInfo> {
            Err(E_NOTIMPL.into())
        }
        fn GetIDsOfNames(&self, _: *const GUID, _: *const PCWSTR, _: u32, _: u32, _: *mut i32) -> Result<()> {
            Err(DISP_E_UNKNOWNNAME.into())
        }
        fn Invoke(&self, id: i32, _: *const GUID, _: u32, _: DISPATCH_FLAGS, _: *const DISPPARAMS, _: *mut VARIANT, _: *mut EXCEPINFO, _: *mut u32) -> Result<()> {
            if id == DISPID_WINDOW_REGISTERED {
                let _ = self.events.send(Msg::Registered);
            }
            Ok(())
        }
    }

    fn is_explorer_window(hwnd: isize) -> bool {
        let mut buf = [0u16; 32];
        // SAFETY: plain window query into a local buffer.
        let n = unsafe { GetClassNameW(HWND(hwnd as *mut c_void), &mut buf) } as usize;
        String::from_utf16_lossy(&buf[..n.min(buf.len())]) == "CabinetWClass"
    }

    /// Every File Explorer entry in the table, with its window handle.
    fn explorer_windows(shell: &IShellWindows) -> Vec<(isize, IWebBrowserApp)> {
        let mut out = Vec::new();
        // SAFETY: plain calls on the shell windows table.
        unsafe {
            let count = shell.Count().unwrap_or(0);
            for i in 0..count {
                let Ok(item) = shell.Item(&VARIANT::from(i)) else { continue };
                let Ok(window) = item.cast::<IWebBrowserApp>() else { continue };
                let Ok(hwnd) = window.HWND() else { continue };
                if is_explorer_window(hwnd.0) {
                    out.push((hwnd.0, window));
                }
            }
        }
        out
    }

    fn selected_paths(window: &IWebBrowserApp) -> Vec<String> {
        // SAFETY: plain calls on File Explorer's scripting objects.
        unsafe {
            let Ok(view) = window.Document().and_then(|d| d.cast::<IShellFolderViewDual>()) else { return Vec::new() };
            let Ok(items) = view.SelectedItems() else { return Vec::new() };
            let count = items.Count().unwrap_or(0);
            (0..count).filter_map(|i| items.Item(&VARIANT::from(i)).ok()?.Path().ok()).map(|p| p.to_string()).filter(|p| !p.is_empty()).collect()
        }
    }

    /// Takes over one new window. `None` leaves it as it is.
    fn take_over(hwnd: isize, window: &IWebBrowserApp, alone: bool) -> Option<Caught> {
        if !alone || paused() {
            return None;
        }
        let started = Instant::now();
        // SAFETY: plain calls on File Explorer's scripting object and its window.
        unsafe {
            let folder = loop {
                let url = window.LocationURL().map(|u| u.to_string()).unwrap_or_default();
                if let Some(path) = path_from_url(&url) {
                    break path;
                }
                // No address yet, or a place that is not a folder: give it a moment, then leave it alone.
                if started.elapsed() > LOCATION_WAIT || !IsWindow(Some(HWND(hwnd as *mut c_void))).as_bool() {
                    return None;
                }
                std::thread::sleep(STEP);
            };
            if !std::path::Path::new(&folder).is_dir() {
                return None;
            }
            let handle = HWND(hwnd as *mut c_void);
            let _ = ShowWindow(handle, SW_HIDE);
            // "Show in folder" selects its file a moment after the window appears.
            let waiting = Instant::now();
            let mut selected = selected_paths(window);
            while selected.is_empty() && waiting.elapsed() < SELECTION_WAIT {
                std::thread::sleep(STEP);
                selected = selected_paths(window);
            }
            if window.Quit().is_err() {
                let _ = ShowWindow(handle, SW_SHOW);
                return None;
            }
            Some(Caught { folder, selected })
        }
    }

    fn run(events: Receiver<Msg>, sender: Sender<Msg>, on_caught: Box<dyn Fn(Caught) + Send + Sync>) {
        // SAFETY: COM is set up for this thread and torn down when it ends; events arrive on COM's own threads.
        unsafe {
            if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
                return;
            }
            if let Ok(shell) = CoCreateInstance::<_, IShellWindows>(&ShellWindows, None, CLSCTX_ALL) {
                let point: Option<IConnectionPoint> = shell.cast::<IConnectionPointContainer>().and_then(|c| c.FindConnectionPoint(&DIID_SHELL_WINDOWS_EVENTS)).ok();
                let sink: IDispatch = Sink { events: sender }.into();
                let cookie = point.as_ref().and_then(|p| p.Advise(&sink).ok());
                // Windows that are already open stay as they are.
                let mut known: HashSet<isize> = explorer_windows(&shell).into_iter().map(|(h, _)| h).collect();
                while let Ok(Msg::Registered) = events.recv() {
                    let windows = explorer_windows(&shell);
                    known.retain(|h| IsWindow(Some(HWND(*h as *mut c_void))).as_bool());
                    for (hwnd, window) in &windows {
                        if known.contains(hwnd) {
                            continue;
                        }
                        known.insert(*hwnd);
                        // A window that already has several tabs is the user's own; only single new windows are taken.
                        let alone = windows.iter().filter(|(h, _)| h == hwnd).count() == 1;
                        if let Some(caught) = take_over(*hwnd, window, alone) {
                            on_caught(caught);
                        }
                    }
                }
                if let (Some(point), Some(cookie)) = (point, cookie) {
                    let _ = point.Unadvise(cookie);
                }
            }
            CoUninitialize();
        }
    }

    pub struct Worker {
        events: Sender<Msg>,
        handle: JoinHandle<()>,
    }

    impl Worker {
        pub fn start(on_caught: Box<dyn Fn(Caught) + Send + Sync>) -> Worker {
            let (events, rx) = channel();
            let sender = events.clone();
            let handle = std::thread::spawn(move || run(rx, sender, on_caught));
            Worker { events, handle }
        }

        pub fn stop(self) {
            let _ = self.events.send(Msg::Stop);
            let _ = self.handle.join();
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Caught;

    pub struct Worker;
    impl Worker {
        pub fn start(_: Box<dyn Fn(Caught) + Send + Sync>) -> Worker {
            Worker
        }
        pub fn stop(self) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_local_and_network_folders_from_addresses() {
        assert_eq!(path_from_url("file:///C:/Users/Ann/My%20Files").as_deref(), Some("C:\\Users\\Ann\\My Files"));
        assert_eq!(path_from_url("file:///D:/caf%C3%A9").as_deref(), Some("D:\\caf\u{e9}"));
        assert_eq!(path_from_url("file:///C:").as_deref(), Some("C:\\"));
        assert_eq!(path_from_url("file://nas/share/x%20y").as_deref(), Some("\\\\nas\\share\\x y"));
    }

    #[test]
    fn places_that_are_not_folders_have_no_path() {
        assert_eq!(path_from_url(""), None);
        assert_eq!(path_from_url("https://example.com/x"), None);
        assert_eq!(path_from_url("file:///not-a-drive/x"), None);
        assert_eq!(path_from_url("file:///C:/bad%zz"), None);
    }

    #[test]
    fn pausing_expires() {
        pause(Duration::from_millis(0));
        assert!(!paused());
        pause(Duration::from_secs(60));
        assert!(paused());
        pause(Duration::from_millis(0));
    }
}
