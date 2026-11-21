//! Win+E hand-off inside the running Octopolis (WE-03, WE-04).
//!
//! With the helper (`octopolis-keys.exe`, WE-01) the hook lives there, and
//! this copy (when it is the one the entries point at) serves the session's
//! pipe: the helper sends `OPEN(id)` or `WAIT(id)`, this window opens This PC
//! and answers `SHOWN(id)`. If the helper hangs up first, the request is
//! cancelled and never opened. Without the helper, the hook runs in this
//! process and a catch opens This PC here directly: no second Octopolis.exe.
//!
//! Each catch is a request with an id. The window claims it, opens This PC
//! and acknowledges "shown" once it is visible and has painted. Without that
//! acknowledgement in time, the request is cancelled and File Explorer opens
//! on This PC instead, with one notice. Every stage goes to `winkey.log` (WE-13).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard, OnceLock, mpsc};
use std::time::{Duration, Instant};

use octo_core::winkey::handoff::{COLD_TIMEOUT, Expired, Requests};
use octo_core::winkey::log::{self, Stage};
use tauri::{AppHandle, Emitter};

/// Sent to the window with the request id.
pub const WIN_E_EVENT: &str = "octopolis://win-e";
/// The notice shown when File Explorer was used instead.
pub const FALLBACK_NOTICE: &str = "Octopolis didn't open, so File Explorer was used";

static APP: OnceLock<AppHandle> = OnceLock::new();
static REQUESTS: LazyLock<Mutex<Requests>> = LazyLock::new(|| Mutex::new(Requests::default()));
/// The page has started and listens for requests; until then a request gets the cold-start timeout.
static PAGE_READY: AtomicBool = AtomicBool::new(false);

/// Requests that came before the page listened; sent once it is ready.
static PENDING: Mutex<Vec<u64>> = Mutex::new(Vec::new());
/// Helper requests waiting for "shown".
static WAITERS: LazyLock<Mutex<HashMap<u64, mpsc::Sender<()>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// This copy serves the Win+E pipe.
static SERVING: AtomicBool = AtomicBool::new(false);

fn requests() -> MutexGuard<'static, Requests> {
    REQUESTS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Sends request `id` to the page, or keeps it until the page is ready.
fn emit_request(app: &AppHandle, id: u64) {
    let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    if !PAGE_READY.load(Ordering::SeqCst) {
        pending.push(id);
        return;
    }
    drop(pending);
    let _ = app.emit_to("main", WIN_E_EVENT, id);
}

/// How long this side keeps a helper request before giving up on it itself.
const HELPER_REQUEST_LIMIT: Duration = Duration::from_secs(COLD_TIMEOUT.as_secs() + 2);

fn same_file(a: &Path, b: &Path) -> bool {
    a.as_os_str().eq_ignore_ascii_case(b.as_os_str())
}

/// Serves the session's Win+E pipe for `helper` (WE-03). Does nothing when it already runs.
#[cfg(windows)]
pub fn serve(helper: PathBuf) {
    use octo_core::winkey::pipe::{self, sys};
    if SERVING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let name = pipe::pipe_name(sys::session());
        let served = sys::serve(&name, || SERVING.load(Ordering::SeqCst), move |conn| on_helper(&conn, &helper));
        if let Err(e) = served {
            log::write(Stage::Handoff, &format!("the Win+E pipe couldn't be served: {e}"), None);
        }
        SERVING.store(false, Ordering::SeqCst);
    });
}

#[cfg(not(windows))]
pub fn serve(_helper: PathBuf) {}

/// Stops serving the pipe.
pub fn stop_serving() {
    if SERVING.swap(false, Ordering::SeqCst) {
        // Wake the server from waiting for a client, so it sees the stop.
        #[cfg(windows)]
        let _ = octo_core::winkey::pipe::sys::connect(&octo_core::winkey::pipe::pipe_name(octo_core::winkey::pipe::sys::session()));
    }
}

/// One helper connection: one fixed message, one request.
#[cfg(windows)]
fn on_helper(conn: &octo_core::winkey::pipe::sys::Conn, helper: &Path) {
    use octo_core::winkey::pipe::{Message, sys};
    // Only this copy's own helper is answered; nothing but the fixed message is read.
    let client = conn.client_pid().and_then(sys::process_image);
    if !client.as_deref().is_some_and(|c| same_file(c, helper)) {
        return;
    }
    let id = match conn.recv(Duration::from_secs(2)) {
        Ok(Some(Message::Open(id) | Message::Wait(id))) => id,
        _ => return,
    };
    let Some(app) = APP.get() else { return };
    let started = Instant::now();
    let (tx, rx) = mpsc::channel();
    WAITERS.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
    requests().begin_with(id, started, HELPER_REQUEST_LIMIT);
    crate::launch::show_main(app);
    emit_request(app, id);
    log::write(Stage::Handoff, &format!("request {id} from the helper sent to the window"), ms(started.elapsed()));
    loop {
        if rx.recv_timeout(Duration::from_millis(50)).is_ok() {
            conn.send(Message::Shown(id));
            break;
        }
        if !conn.alive() || started.elapsed() > HELPER_REQUEST_LIMIT {
            if requests().cancel(id) {
                log::write(Stage::Cancel, &format!("request {id}: the helper gave up on it, so it won't be opened"), ms(started.elapsed()));
            }
            break;
        }
    }
    WAITERS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
}

fn ms(d: Duration) -> Option<u128> {
    Some(d.as_millis())
}

/// Call once the app is set up.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

/// A caught Win+E. Runs on its own thread (never the hook's), and waits there
/// for the request's deadline.
pub fn on_press() {
    log::write(Stage::Catch, "Win+E caught", None);
    let Some(app) = APP.get() else {
        log::write(Stage::Handoff, "the window isn't set up yet", None);
        return;
    };
    let started = Instant::now();
    let (id, timeout) = requests().begin(started, !PAGE_READY.load(Ordering::Relaxed));
    crate::launch::show_main(app);
    emit_request(app, id);
    log::write(Stage::Handoff, &format!("request {id} sent to the window"), ms(started.elapsed()));
    std::thread::sleep(timeout);
    let expired = requests().expire(id, Instant::now());
    if let Some(e) = expired {
        fallback(app, id, timeout, e);
    }
}

/// Why a request was cancelled, for the log.
pub fn cancel_reason(id: u64, timeout: Duration, e: &Expired) -> String {
    let stage = if e.claimed { "the window took it but wasn't shown" } else { "the window didn't answer" };
    format!("request {id}: {stage} within {} s", timeout.as_secs())
}

fn fallback(app: &AppHandle, id: u64, timeout: Duration, e: Expired) {
    let reason = cancel_reason(id, timeout, &e);
    log::write(Stage::Cancel, &reason, ms(e.elapsed));
    crate::diag::write("warn", &format!("win+e: {reason}; File Explorer was used"));
    let opened = std::process::Command::new(octo_core::shell::explorer_exe()).arg(octo_core::explorer_mode::THIS_PC).spawn();
    match opened {
        Ok(_) => log::write(Stage::Fallback, &format!("request {id}: File Explorer opened on This PC"), ms(e.elapsed)),
        Err(err) => log::write(Stage::Fallback, &format!("request {id}: File Explorer couldn't start: {err}"), ms(e.elapsed)),
    }
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title("Octopolis").body(FALLBACK_NOTICE).show();
    }
    if e.failed_start {
        // Two fallbacks in a row count as one failed start (WE-04).
        crate::failsafe::win_e_failed_start();
        log::write(Stage::Fallback, "two fallbacks in a row: counted as one failed start", None);
    }
}

/// The page listens for Win+E requests now.
#[tauri::command]
pub fn win_e_ready() {
    let waiting: Vec<u64> = {
        let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        PAGE_READY.store(true, Ordering::SeqCst);
        std::mem::take(&mut *pending)
    };
    if let Some(app) = APP.get() {
        for id in waiting {
            let _ = app.emit_to("main", WIN_E_EVENT, id);
        }
    }
}

/// The window asks to open request `id`. `false`: it was cancelled; don't open it.
#[tauri::command]
pub fn win_e_claim(id: u64) -> bool {
    let ok = requests().claim(id);
    if !ok {
        log::write(Stage::Cancel, &format!("request {id} came too late and was not opened"), None);
    }
    ok
}

/// The window is visible and painted for request `id`.
#[tauri::command]
pub fn win_e_shown(id: u64) {
    let shown = requests().shown(id, Instant::now());
    if let Some(tx) = WAITERS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
        let _ = tx.send(());
    }
    match shown {
        Some(elapsed) => log::write(Stage::Shown, &format!("request {id}"), ms(elapsed)),
        None => log::write(Stage::Shown, &format!("request {id} was already cancelled"), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cancel_reason_names_the_stage_and_never_a_key() {
        let e = |claimed| Expired { elapsed: Duration::from_secs(3), claimed, failed_start: false };
        assert_eq!(cancel_reason(4, Duration::from_secs(3), &e(false)), "request 4: the window didn't answer within 3 s");
        assert_eq!(cancel_reason(5, Duration::from_secs(8), &e(true)), "request 5: the window took it but wasn't shown within 8 s");
    }

    #[test]
    fn a_helper_request_the_helper_gave_up_on_is_never_opened() {
        let now = Instant::now();
        requests().begin_with(9_000_001, now, HELPER_REQUEST_LIMIT);
        assert!(requests().cancel(9_000_001), "the helper hung up");
        assert!(!win_e_claim(9_000_001), "the window can't open it any more");
    }

    #[test]
    fn a_helper_request_shown_in_time_wakes_its_connection() {
        let (tx, rx) = mpsc::channel();
        requests().begin_with(9_000_002, Instant::now(), HELPER_REQUEST_LIMIT);
        WAITERS.lock().unwrap().insert(9_000_002, tx);
        assert!(win_e_claim(9_000_002));
        win_e_shown(9_000_002);
        assert!(rx.recv_timeout(Duration::from_secs(1)).is_ok(), "SHOWN goes back to the helper");
    }

    #[test]
    fn a_late_claim_after_the_timeout_is_refused() {
        // The same tracker the commands use: once a request expires, the window can't open it.
        let t0 = Instant::now();
        let (id, timeout) = requests().begin(t0, false);
        assert!(requests().expire(id, t0 + timeout).is_some());
        assert!(!win_e_claim(id));
    }
}
