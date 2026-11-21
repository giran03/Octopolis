//! `octopolis-keys.exe`: the Win+E helper (WE-01). A small native process, no
//! WebView, started at sign-in from the HKCU Run value Octopolis owns, and by
//! Octopolis itself. One per session. It holds the Win+E hook, so Win+E opens
//! Octopolis while the Octopolis window is closed, crashed or hung.
//!
//! - `octopolis-keys.exe`           runs the helper (exits at once unless this copy is the one the entries point at)
//! - `octopolis-keys.exe --stop`    stops the running helper
//! - `octopolis-keys.exe --restore` stops it and gives folders and Win+E back to File Explorer (WE-10)

#![cfg_attr(not(test), windows_subsystem = "windows")]

mod flow;

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use octo_core::explorer_mode::{self, THIS_PC};
use octo_core::winkey::handoff::Requests;
use octo_core::winkey::log::{self, Stage};
use octo_core::winkey::pipe::{self, Message};

/// `%LOCALAPPDATA%\app.octopolis.explorer`.
fn data_dir() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join(explorer_mode::record::DIR_NAME))
}

/// The Octopolis.exe beside this helper.
fn octopolis_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.with_file_name("Octopolis.exe");
    exe.is_file().then_some(exe)
}

fn same_file(a: &Path, b: &Path) -> bool {
    a.as_os_str().eq_ignore_ascii_case(b.as_os_str())
}

/// Whether this copy is the one the entries point at (WE-15).
fn is_target(octopolis: &Path) -> bool {
    explorer_mode::status_for(octopolis).catches_here
}

/// The helper runs and catches only when this copy is the target, "Win+E opens
/// Octopolis" is on, and the record lists this helper's Run value (WE-01, WE-15).
fn may_run(is_target: bool, switch_on: bool, registered: bool) -> bool {
    is_target && switch_on && registered
}

fn should_run(octopolis: &Path) -> bool {
    let helper = pipe::helper_beside(octopolis);
    may_run(is_target(octopolis), data_dir().is_none_or(|d| pipe::read_switch(&d)), explorer_mode::helper_registered(&helper))
}

fn write_status() {
    if let Some(dir) = data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join(pipe::STATUS_FILE), pipe::format_status(&octo_core::winkey::health_state()));
    }
}

fn main() {
    if let Some(dir) = data_dir() {
        log::init(&dir.join("logs"));
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let has = |flag: &str| args.iter().any(|a| a.eq_ignore_ascii_case(flag));
    if has("--stop") {
        std::process::exit(stop());
    }
    if has("--restore") {
        std::process::exit(restore());
    }
    run();
}

/// Stops the running helper and waits for it to end. 0 when none is left running.
/// Only this copy's: when the entries point at another copy, its helper is left alone.
fn stop() -> i32 {
    #[cfg(windows)]
    {
        use pipe::sys;
        if !sys::exists(pipe::HELPER_MUTEX) || octopolis_exe().is_some_and(|o| !is_target(&o)) {
            return 0;
        }
        sys::signal(pipe::QUIT_EVENT);
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(5) {
            if !sys::exists(pipe::HELPER_MUTEX) {
                return 0;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        1
    }
    #[cfg(not(windows))]
    0
}

/// `--restore` (WE-10): stops the helper, then the same restore as `Octopolis.exe --restore-explorer`
/// (which also removes the Run value, since it is in the record). 0 restored, 1 something left.
fn restore() -> i32 {
    let Some(octopolis) = octopolis_exe() else {
        log::write(Stage::Restore, "Octopolis.exe isn't beside the helper", None);
        return 1;
    };
    // Only this copy's own helper is stopped: another copy's entries are left as they are.
    if stop() != 0 {
        log::write(Stage::Restore, "the running helper didn't stop", None);
    }
    let (code, line) = explorer_mode::restore_cli(&octopolis);
    log::write(Stage::Restore, &line, None);
    code
}

static REQUESTS: LazyLock<Mutex<Requests>> = LazyLock::new(|| Mutex::new(Requests::default()));
static OCTOPOLIS: OnceLock<PathBuf> = OnceLock::new();

#[cfg(windows)]
struct RealLink(pipe::sys::Conn);

#[cfg(windows)]
impl flow::Link for RealLink {
    fn send(&self, m: Message) -> bool {
        self.0.send(m)
    }
    fn recv(&self, timeout: Duration) -> Result<Option<Message>, pipe::HungUp> {
        self.0.recv(timeout)
    }
}

#[cfg(windows)]
struct RealEnv {
    octopolis: PathBuf,
    pipe: String,
}

#[cfg(windows)]
impl flow::Env for RealEnv {
    type L = RealLink;

    fn connect(&self) -> Option<RealLink> {
        let conn = pipe::sys::connect(&self.pipe)?;
        // Hand Win+E only to the copy the entries point at (WE-15).
        let server = conn.server_pid().and_then(pipe::sys::process_image)?;
        if !same_file(&server, &self.octopolis) {
            log::write(Stage::Handoff, "the pipe is served by another copy of Octopolis; ignored", None);
            return None;
        }
        Some(RealLink(conn))
    }

    fn start_octopolis(&self, id: u64) -> bool {
        std::process::Command::new(&self.octopolis).arg(THIS_PC).arg(pipe::REQUEST_ARG).arg(id.to_string()).spawn().is_ok()
    }

    fn fall_back(&self, id: u64, _reason: &str, failed_start: bool) {
        let opened = std::process::Command::new(octo_core::shell::explorer_exe()).arg(THIS_PC).spawn();
        log::write(Stage::Fallback, &match opened {
            Ok(_) => format!("request {id}: File Explorer opened on This PC"),
            Err(e) => format!("request {id}: File Explorer couldn't start: {e}"),
        }, None);
        notice::show("Octopolis", "Octopolis didn't open, so File Explorer was used");
        if failed_start {
            if let Some(dir) = data_dir() {
                octo_core::failsafe::failed_start(&dir);
            }
            log::write(Stage::Fallback, "two fallbacks in a row: counted as one failed start", None);
        }
    }

    fn log(&self, stage: Stage, reason: &str, elapsed: Option<Duration>) {
        log::write(stage, reason, elapsed.map(|d| d.as_millis()));
    }
}

/// A caught Win+E, on a thread of its own (never the hook's).
fn on_press() {
    log::write(Stage::Catch, "Win+E caught", None);
    #[cfg(windows)]
    if let Some(octopolis) = OCTOPOLIS.get() {
        let env = RealEnv { octopolis: octopolis.clone(), pipe: pipe::pipe_name(pipe::sys::session()) };
        flow::handle(&env, &REQUESTS);
    }
    write_status();
}

#[cfg(windows)]
fn run() {
    use octo_core::winkey::{self, liveness::Trigger};
    use pipe::sys;
    let Some(_one) = sys::single_instance(pipe::HELPER_MUTEX) else { return };
    let (Some(quit), Some(repair)) = (sys::event(pipe::QUIT_EVENT), sys::event(pipe::REPAIR_EVENT)) else { return };
    let Some(octopolis) = octopolis_exe() else { return };
    if !should_run(&octopolis) {
        log::write(Stage::Install, "helper: not started (not the copy the entries point at, or \"Win+E opens Octopolis\" is off)", None);
        return;
    }
    let _ = OCTOPOLIS.set(octopolis.clone());
    winkey::set(Some(on_press));
    winkey::self_test(Trigger::SelfTest);
    write_status();
    log::write(Stage::Install, "helper running", None);
    loop {
        match sys::wait_any(&[&quit, &repair], Duration::from_secs(60)) {
            Some(0) => break,
            Some(_) => {
                winkey::restart();
            }
            None => {
                if !should_run(&octopolis) {
                    log::write(Stage::Install, "helper: stopping (no longer the target copy, or \"Win+E opens Octopolis\" is off)", None);
                    break;
                }
            }
        }
        write_status();
    }
    winkey::set(None::<fn()>);
    if let Some(dir) = data_dir() {
        let _ = std::fs::remove_file(dir.join(pipe::STATUS_FILE));
    }
    log::write(Stage::Install, "helper stopped", None);
}

#[cfg(not(windows))]
fn run() {}

#[cfg(windows)]
mod notice {
    //! One non-blocking notice: a notification-area balloon, shown from its own thread.

    use windows::Win32::UI::Shell::{NIF_ICON, NIF_INFO, NIF_TIP, NIIF_INFO, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW, Shell_NotifyIconW};
    use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, HWND_MESSAGE, IDI_INFORMATION, LoadIconW, WINDOW_EX_STYLE, WINDOW_STYLE};
    use windows::core::w;

    fn copy(dst: &mut [u16], text: &str) {
        for (d, s) in dst.iter_mut().zip(text.encode_utf16().chain(std::iter::once(0))) {
            *d = s;
        }
        if let Some(last) = dst.last_mut() {
            *last = 0;
        }
    }

    pub fn show(title: &'static str, body: &'static str) {
        std::thread::spawn(move || {
            // SAFETY: a message-only window and a notification icon, both removed before the thread ends.
            unsafe {
                let Ok(hwnd) = CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), w!(""), WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, None, None) else { return };
                let mut data = NOTIFYICONDATAW { cbSize: size_of::<NOTIFYICONDATAW>() as u32, hWnd: hwnd, uID: 1, uFlags: NIF_ICON | NIF_INFO | NIF_TIP, dwInfoFlags: NIIF_INFO, ..Default::default() };
                data.hIcon = LoadIconW(None, IDI_INFORMATION).unwrap_or_default();
                copy(&mut data.szTip, title);
                copy(&mut data.szInfoTitle, title);
                copy(&mut data.szInfo, body);
                let _ = Shell_NotifyIconW(NIM_ADD, &data);
                std::thread::sleep(std::time::Duration::from_secs(10));
                let _ = Shell_NotifyIconW(NIM_DELETE, &data);
                let _ = DestroyWindow(hwnd);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::may_run;

    #[test]
    fn the_helper_runs_only_in_the_target_copy_with_the_switch_on_and_registered() {
        assert!(may_run(true, true, true));
        assert!(!may_run(false, true, true), "another copy is the target (WE-15)");
        assert!(!may_run(true, false, true), "\"Win+E opens Octopolis\" is off");
        assert!(!may_run(true, true, false), "its Run value isn't Octopolis's (or was removed)");
    }
}
