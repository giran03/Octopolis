//! Help in other apps' Open and Save dialogs. The Windows dialog stays; while
//! one is in front, two shortcuts are available:
//!
//! - Ctrl+G sends the dialog to the folder Octopolis is showing.
//! - Ctrl+Shift+G brings Octopolis forward to pick the file there.
//!
//! Nothing is loaded into the other app. Octopolis learns that a dialog is in
//! front from an out-of-context foreground event, registers the two shortcuts
//! only for that time, and drives the dialog the way a person would: it puts a
//! path in the file-name box and presses the default button. Apps running as
//! administrator ignore this (Windows blocks it), and so do excluded apps.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::error::{Error, Result};

/// Which shortcut was pressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    /// Send the dialog to Octopolis's folder.
    Jump,
    /// Pick the file in Octopolis.
    Pick,
}

/// An Open or Save dialog in another app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dialog {
    pub hwnd: isize,
    pub title: String,
    /// File name of the program showing it, e.g. `notepad.exe`. Empty if unknown.
    pub app: String,
    /// A Save dialog: only its folder should be changed, never the file name.
    pub save: bool,
}

/// Splits the "don't help in these apps" setting into lower-case program names.
pub fn parse_excluded(text: &str) -> Vec<String> {
    text.split([',', ';', '\n'])
        .map(|s| s.trim().trim_matches('"').to_lowercase())
        .filter(|s| !s.is_empty())
        .map(|s| if s.ends_with(".exe") { s } else { format!("{s}.exe") })
        .collect()
}

pub fn is_excluded(app: &str, excluded: &[String]) -> bool {
    let app = app.to_lowercase();
    excluded.contains(&app)
}

/// Text for the file-name box that opens `files`: one path as is, several as quoted paths.
pub fn file_name_text(files: &[PathBuf]) -> String {
    match files {
        [one] => one.to_string_lossy().into_owned(),
        many => many.iter().map(|f| format!("\"{}\"", f.display())).collect::<Vec<_>>().join(" "),
    }
}

/// Text for the file-name box that makes the dialog go to `folder`. The
/// trailing slash makes Windows treat it as a folder, never as a file name.
pub fn folder_text(folder: &Path) -> String {
    let s = folder.to_string_lossy();
    if s.ends_with('\\') { s.into_owned() } else { format!("{s}\\") }
}

fn refuse(what: &str) -> Error {
    Error::io(Path::new("dialog"), std::io::Error::other(what.to_string()))
}

type Callback = Box<dyn Fn(Key, Dialog) + Send + Sync>;

struct Shared {
    excluded: Vec<String>,
    on_key: Option<Callback>,
    worker: Option<imp::Worker>,
}

static SHARED: Mutex<Shared> = Mutex::new(Shared { excluded: Vec::new(), on_key: None, worker: None });

fn shared() -> std::sync::MutexGuard<'static, Shared> {
    SHARED.lock().unwrap_or_else(|e| e.into_inner())
}

/// Turns the dialog shortcuts on or off. `on_key` runs on the shortcut thread; keep it quick.
pub fn set(enabled: bool, excluded: Vec<String>, on_key: impl Fn(Key, Dialog) + Send + Sync + 'static) {
    let mut s = shared();
    s.excluded = excluded;
    s.on_key = Some(Box::new(on_key));
    match (enabled, s.worker.is_some()) {
        (true, false) => {
            drop(s);
            let worker = imp::start();
            shared().worker = worker;
        }
        (false, true) => {
            let worker = s.worker.take();
            drop(s);
            if let Some(w) = worker {
                w.stop();
            }
        }
        _ => {}
    }
}

/// The Open or Save dialog behind `hwnd`, if that is what it is and it belongs to another app.
pub fn inspect(hwnd: isize) -> Option<Dialog> {
    imp::inspect(hwnd)
}

/// Sends the dialog to `folder`, keeping whatever file name was typed.
pub fn go_to_folder(hwnd: isize, folder: &Path) -> Result<()> {
    if !folder.is_dir() {
        return Err(Error::NotFound(folder.to_path_buf()));
    }
    imp::go_to_folder(hwnd, &folder_text(folder))
}

/// Opens `files` in the dialog, as if their paths had been typed and Open pressed.
/// Refused for Save dialogs, where a picked file would be offered for overwriting.
pub fn choose_files(hwnd: isize, files: &[PathBuf]) -> Result<()> {
    if files.is_empty() {
        return Err(refuse("nothing is selected"));
    }
    if let Some(missing) = files.iter().find(|f| !f.exists()) {
        return Err(Error::NotFound(missing.clone()));
    }
    imp::choose(hwnd, &file_name_text(files))
}

/// Brings the dialog back in front.
pub fn focus(hwnd: isize) {
    imp::focus(hwnd);
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::thread::JoinHandle;
    use std::time::Duration;

    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::{
        GetCurrentProcessId, GetCurrentThreadId, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
    use windows::Win32::UI::Input::KeyboardAndMouse::{MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, RegisterHotKey, UnregisterHotKey, VK_G};
    use windows::Win32::UI::WindowsAndMessaging::{
        EVENT_SYSTEM_FOREGROUND, EnumChildWindows, GetClassNameW, GetDlgItem, GetForegroundWindow, GetMessageW, GetWindowTextW, GetWindowThreadProcessId, IsWindow,
        KillTimer, MSG, PM_NOREMOVE, PeekMessageW, PostMessageW, PostThreadMessageW, SMTO_ABORTIFHUNG, SendMessageTimeoutW, SetForegroundWindow, SetTimer,
        WINEVENT_OUTOFCONTEXT, WM_COMMAND, WM_GETTEXT, WM_GETTEXTLENGTH, WM_HOTKEY, WM_QUIT, WM_SETTEXT, WM_TIMER,
    };
    use windows::core::{BOOL, PCWSTR, PWSTR};

    use super::{Dialog, Key, Result, is_excluded, refuse, shared};

    const ID_JUMP: i32 = 1;
    const ID_PICK: i32 = 2;
    /// File-name combo box of an Open dialog, and the plain edit box of old-style dialogs.
    const CMB13: i32 = 0x47C;
    const EDT1: i32 = 0x480;
    const IDOK: usize = 1;
    /// A dialog is not fully built at the moment it comes to the front; look again a few times.
    const RECHECKS: usize = 3;
    const RECHECK_MS: u32 = 250;
    /// How often to confirm the dialog is still in front while the shortcuts are held.
    const HELD_CHECK_MS: u32 = 400;
    /// Never wait on a hung app.
    const SEND_TIMEOUT_MS: u32 = 1000;

    /// Whether the shortcut thread holds the two shortcuts. Only that thread touches these.
    static HELD: AtomicBool = AtomicBool::new(false);
    static RECHECKS_LEFT: AtomicUsize = AtomicUsize::new(0);
    static TIMER: AtomicUsize = AtomicUsize::new(0);

    fn h(hwnd: isize) -> HWND {
        HWND(hwnd as *mut c_void)
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn class_of(hwnd: HWND) -> String {
        let mut buf = [0u16; 64];
        // SAFETY: plain window query into a local buffer.
        let n = unsafe { GetClassNameW(hwnd, &mut buf) } as usize;
        String::from_utf16_lossy(&buf[..n.min(buf.len())])
    }

    struct Search<'a> {
        class: &'a str,
        found: Option<HWND>,
    }

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: `lparam` is the `Search` passed by `find_child`, alive for the whole enumeration.
        let search = unsafe { &mut *(lparam.0 as *mut Search) };
        if class_of(hwnd) == search.class {
            search.found = Some(hwnd);
            return BOOL(0);
        }
        BOOL(1)
    }

    /// First window of `class` anywhere below `parent`.
    fn find_child(parent: HWND, class: &str) -> Option<HWND> {
        let mut search = Search { class, found: None };
        // SAFETY: the callback only runs during this call and only touches `search`.
        let _ = unsafe { EnumChildWindows(Some(parent), Some(visit), LPARAM(&mut search as *mut Search as isize)) };
        search.found
    }

    fn dlg_item(dialog: HWND, id: i32) -> Option<HWND> {
        // SAFETY: plain window query.
        unsafe { GetDlgItem(Some(dialog), id) }.ok().filter(|w| !w.is_invalid())
    }

    fn pid_of(hwnd: HWND) -> u32 {
        let mut pid = 0;
        // SAFETY: plain window query.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        pid
    }

    /// The program's file name. Asks only for the limited query right, which reads nothing from the process.
    fn exe_of(pid: u32) -> Option<String> {
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
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            Some(path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string())
        }
    }

    /// The box the file name is typed in.
    fn file_name_edit(dialog: HWND) -> Option<HWND> {
        if let Some(edit) = dlg_item(dialog, CMB13).and_then(|combo| find_child(combo, "Edit")) {
            return Some(edit);
        }
        if let Some(edit) = dlg_item(dialog, EDT1) {
            return Some(edit);
        }
        // Save dialogs keep the file-name box inside the folder view's frame.
        find_child(dialog, "FloatNotifySink").and_then(|sink| find_child(sink, "Edit")).or_else(|| find_child(dialog, "Edit"))
    }

    pub fn inspect(hwnd: isize) -> Option<Dialog> {
        let dialog = h(hwnd);
        // SAFETY: plain window queries.
        if hwnd == 0 || !unsafe { IsWindow(Some(dialog)) }.as_bool() || class_of(dialog) != "#32770" {
            return None;
        }
        let pid = pid_of(dialog);
        // SAFETY: plain query.
        if pid == 0 || pid == unsafe { GetCurrentProcessId() } {
            return None;
        }
        let modern = find_child(dialog, "DUIViewWndClassName").is_some();
        let open_combo = dlg_item(dialog, CMB13).is_some();
        if !(modern || open_combo || dlg_item(dialog, EDT1).is_some()) {
            return None;
        }
        file_name_edit(dialog)?;
        let mut buf = [0u16; 256];
        // SAFETY: plain window query into a local buffer.
        let n = unsafe { GetWindowTextW(dialog, &mut buf) }.max(0) as usize;
        Some(Dialog { hwnd, title: String::from_utf16_lossy(&buf[..n.min(buf.len())]), app: exe_of(pid).unwrap_or_default(), save: modern && !open_combo })
    }

    fn send(hwnd: HWND, msg: u32, wparam: usize, lparam: isize) -> Option<usize> {
        let mut result = 0usize;
        // SAFETY: standard window messages, which Windows carries across processes; bounded by a timeout.
        let sent = unsafe { SendMessageTimeoutW(hwnd, msg, WPARAM(wparam), LPARAM(lparam), SMTO_ABORTIFHUNG, SEND_TIMEOUT_MS, Some(&mut result)) };
        (sent != LRESULT(0)).then_some(result)
    }

    fn get_text(edit: HWND) -> Option<String> {
        let len = send(edit, WM_GETTEXTLENGTH, 0, 0)?;
        let mut buf = vec![0u16; len + 1];
        let got = send(edit, WM_GETTEXT, buf.len(), buf.as_mut_ptr() as isize)?;
        Some(String::from_utf16_lossy(&buf[..got.min(len)]))
    }

    fn set_text(edit: HWND, text: &str) -> Result<()> {
        let w = wide(text);
        match send(edit, WM_SETTEXT, 0, PCWSTR(w.as_ptr()).0 as isize) {
            Some(1) => Ok(()),
            _ => Err(refuse("the dialog did not accept the path (the app may be running as administrator)")),
        }
    }

    /// Presses the dialog's default button without waiting for what it does next.
    fn press_ok(dialog: HWND) -> Result<()> {
        // SAFETY: posts a standard command message.
        unsafe { PostMessageW(Some(dialog), WM_COMMAND, WPARAM(IDOK), LPARAM(0)) }.map_err(|_| refuse("the dialog did not respond"))
    }

    fn target(hwnd: isize) -> Result<(Dialog, HWND)> {
        let dialog = inspect(hwnd).ok_or_else(|| refuse("the dialog is no longer open"))?;
        let edit = file_name_edit(h(hwnd)).ok_or_else(|| refuse("the dialog has no file name box"))?;
        Ok((dialog, edit))
    }

    pub fn go_to_folder(hwnd: isize, folder_text: &str) -> Result<()> {
        let (_, edit) = target(hwnd)?;
        let typed = get_text(edit).unwrap_or_default();
        set_text(edit, folder_text)?;
        press_ok(h(hwnd))?;
        // Give the dialog a moment to read the path, then put the file name back.
        std::thread::sleep(Duration::from_millis(250));
        if inspect(hwnd).is_some() {
            let _ = set_text(edit, &typed);
        }
        Ok(())
    }

    pub fn choose(hwnd: isize, text: &str) -> Result<()> {
        let (dialog, edit) = target(hwnd)?;
        if dialog.save {
            return Err(refuse("a Save dialog only takes a folder"));
        }
        set_text(edit, text)?;
        focus(hwnd);
        press_ok(h(hwnd))
    }

    pub fn focus(hwnd: isize) {
        // SAFETY: plain window call; fails harmlessly if the window is gone.
        let _ = unsafe { SetForegroundWindow(h(hwnd)) };
    }

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

    /// Holds the shortcuts exactly while an Open or Save dialog of a non-excluded app is in front.
    fn hold(want: bool) {
        if want == HELD.load(Ordering::Relaxed) {
            return;
        }
        // SAFETY: registers or releases shortcuts owned by this thread.
        unsafe {
            if want {
                let key = u32::from(VK_G.0);
                let jump = RegisterHotKey(None, ID_JUMP, MOD_CONTROL | MOD_NOREPEAT, key).is_ok();
                let pick = RegisterHotKey(None, ID_PICK, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, key).is_ok();
                HELD.store(jump || pick, Ordering::Relaxed);
            } else {
                let _ = UnregisterHotKey(None, ID_JUMP);
                let _ = UnregisterHotKey(None, ID_PICK);
                HELD.store(false, Ordering::Relaxed);
            }
        }
    }

    fn cancel_recheck() {
        let id = TIMER.swap(0, Ordering::Relaxed);
        if id != 0 {
            // SAFETY: the timer belongs to this thread.
            let _ = unsafe { KillTimer(None, id) };
        }
    }

    /// Matches the shortcuts to the window that is in front right now. The window an event names
    /// is not trusted: Windows also reports windows that asked for the front and did not get it.
    fn evaluate(rechecks: usize) {
        cancel_recheck();
        // SAFETY: plain queries; the timer is delivered to this thread's message loop.
        unsafe {
            let foreground = GetForegroundWindow();
            let dialog = inspect(foreground.0 as isize);
            let helped = dialog.as_ref().is_some_and(|d| !is_excluded(&d.app, &shared().excluded));
            hold(helped);
            // A dialog that is still being built has no file-name box yet: look again shortly.
            let building = dialog.is_none() && rechecks > 0 && class_of(foreground) == "#32770" && pid_of(foreground) != GetCurrentProcessId();
            // While the shortcuts are held, keep checking, so they are let go even if no event says the dialog went away.
            if helped || building {
                RECHECKS_LEFT.store(if helped { RECHECKS } else { rechecks - 1 }, Ordering::Relaxed);
                TIMER.store(SetTimer(None, 0, if helped { HELD_CHECK_MS } else { RECHECK_MS }, None), Ordering::Relaxed);
            }
        }
    }

    unsafe extern "system" fn on_foreground(_: HWINEVENTHOOK, _: u32, _: HWND, _: i32, _: i32, _: u32, _: u32) {
        evaluate(RECHECKS);
    }

    fn run(ready: mpsc::Sender<u32>) {
        // SAFETY: everything registered here belongs to this thread and is released before it ends.
        unsafe {
            let mut msg = MSG::default();
            // Creates the message queue, so the thread id can be posted to straight away.
            let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
            let _ = ready.send(GetCurrentThreadId());
            HELD.store(false, Ordering::Relaxed);
            // Out of context: the callback runs on this thread, and nothing is loaded into other apps.
            let hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, Some(on_foreground), 0, 0, WINEVENT_OUTOFCONTEXT);
            evaluate(RECHECKS);
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                match msg.message {
                    WM_HOTKEY => {
                        let key = if msg.wParam.0 as i32 == ID_PICK { Key::Pick } else { Key::Jump };
                        if let Some(dialog) = inspect(GetForegroundWindow().0 as isize)
                            && let Some(f) = &shared().on_key
                        {
                            f(key, dialog);
                        }
                    }
                    WM_TIMER => evaluate(RECHECKS_LEFT.load(Ordering::Relaxed)),
                    _ => {}
                }
            }
            cancel_recheck();
            hold(false);
            let _ = UnhookWinEvent(hook);
        }
    }

    pub fn start() -> Option<Worker> {
        let (tx, rx) = mpsc::channel();
        let handle = std::thread::spawn(move || run(tx));
        let thread_id = rx.recv().ok()?;
        Some(Worker { thread_id, handle })
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{Dialog, Result, refuse};

    pub struct Worker;
    impl Worker {
        pub fn stop(self) {}
    }
    pub fn start() -> Option<Worker> {
        None
    }
    pub fn inspect(_: isize) -> Option<Dialog> {
        None
    }
    pub fn go_to_folder(_: isize, _: &str) -> Result<()> {
        Err(refuse("not available on this system"))
    }
    pub fn choose(_: isize, _: &str) -> Result<()> {
        Err(refuse("not available on this system"))
    }
    pub fn focus(_: isize) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excluded_apps_are_matched_by_program_name() {
        let list = parse_excluded("Game.exe, \"launcher\" ;\n  ");
        assert_eq!(list, vec!["game.exe", "launcher.exe"]);
        assert!(is_excluded("GAME.EXE", &list));
        assert!(!is_excluded("notepad.exe", &list));
        assert!(!is_excluded("", &list));
    }

    #[test]
    fn one_file_is_typed_plainly_and_several_are_quoted() {
        assert_eq!(file_name_text(&[PathBuf::from("C:\\a b\\c.txt")]), "C:\\a b\\c.txt");
        assert_eq!(file_name_text(&[PathBuf::from("C:\\a\\1.txt"), PathBuf::from("C:\\a\\2 x.txt")]), "\"C:\\a\\1.txt\" \"C:\\a\\2 x.txt\"");
    }

    #[test]
    fn a_folder_always_ends_with_a_slash() {
        assert_eq!(folder_text(Path::new("C:\\Users\\Ann")), "C:\\Users\\Ann\\");
        assert_eq!(folder_text(Path::new("D:\\")), "D:\\");
    }

    #[test]
    fn missing_folders_and_files_are_refused_before_touching_the_dialog() {
        assert!(go_to_folder(0, Path::new("Z:\\no\\such\\folder")).is_err());
        assert!(choose_files(0, &[]).is_err());
        assert!(choose_files(0, &[PathBuf::from("Z:\\no\\such\\file.txt")]).is_err());
    }
}
