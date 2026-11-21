//! Win+E fallback for "Use Octopolis instead of File Explorer".
//!
//! Newer Windows 11 builds no longer read the registry entry that redirects
//! Win+E, so while that mode is on Octopolis also catches the combination
//! itself. It uses a low-level keyboard hook that looks at one thing only: an E
//! key-down while Win is held and nothing else is. Every other key passes
//! through untouched and is never stored or read further; the hook only
//! counts how many real key events reached it, as proof that it is alive.
//!
//! The hook thread never blocks: the hook body is a few atomic operations,
//! and a catch is handed to a dispatcher thread over a channel. A reinstall
//! installs the new hook before the old one is removed (each hook has a
//! generation, and only the active one acts), so there is never a moment
//! without a hook and never two acting on the same press.
//!
//! The hook is checked with a self-test (WE-05): Octopolis injects one
//! unassigned key marked with a private `dwExtraInfo` value, from another
//! thread; the hook swallows it, so no app receives it, and counts it. Win+E
//! itself is never injected. The same probe runs every minute, after unlock,
//! after resume and when Explorer restarts (WE-06).

use std::cell::Cell;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock, mpsc};
use std::time::{Duration, Instant};

pub mod handoff;
pub mod liveness;
pub mod log;
pub mod pipe;

use liveness::{Context, ProbeError, ProbeResult, REINSTALL_BACKOFF, Trigger};

/// The last self-test, for status (WE-05, WE-11).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Health {
    /// Not catching.
    Off,
    /// Catching, but no probe result yet.
    Checking,
    Working,
    NotWorking(String),
}

type Callback = std::sync::Arc<dyn Fn() + Send + Sync>;

struct Shared {
    on_press: Option<Callback>,
    worker: Option<imp::Worker>,
    watch: Option<imp::Watch>,
}

static SHARED: Mutex<Shared> = Mutex::new(Shared { on_press: None, worker: None, watch: None });

fn shared() -> std::sync::MutexGuard<'static, Shared> {
    SHARED.lock().unwrap_or_else(|e| e.into_inner())
}

/// The unassigned virtual key the probe injects.
pub const PROBE_VK: u32 = 0x97;
/// Marks Octopolis's own probe key (`dwExtraInfo`); anything without it passes untouched.
pub const PROBE_MARK: usize = 0x4F43_5052;
/// How long a probe waits for the hook to see the test key.
pub const PROBE_WAIT: Duration = Duration::from_millis(500);
const VK_E: u32 = 0x45;

/// An E key-down was taken, so its repeats and key-up are taken too.
static SWALLOWING: AtomicBool = AtomicBool::new(false);
/// Probe keys the hook has seen (key-downs).
static PROBES_SEEN: AtomicU64 = AtomicU64::new(0);
/// Real (not injected) key events the active hook has seen: a count, nothing about the keys.
static REAL_EVENTS: AtomicU64 = AtomicU64::new(0);
/// [`REAL_EVENTS`] at the last check.
static REAL_AT_CHECK: AtomicU64 = AtomicU64::new(0);
/// The generation of the hook that acts; 0 when none.
static ACTIVE_GEN: AtomicU64 = AtomicU64::new(0);
static NEXT_GEN: AtomicU64 = AtomicU64::new(1);
/// Catches go from the hook to the dispatcher thread over this channel.
static DISPATCH: OnceLock<mpsc::Sender<()>> = OnceLock::new();
/// When the hook was last reinstalled.
static LAST_REINSTALL: Mutex<Option<Instant>> = Mutex::new(None);
/// Only one check at a time.
static CHECK: Mutex<()> = Mutex::new(());
/// The last self-test result while catching; `None` before the first, or while off.
static HEALTH: Mutex<Option<Result<(), String>>> = Mutex::new(None);

thread_local! {
    /// On a hook thread: that hook's generation. 0 on every other thread.
    static HOOK_GEN: Cell<u64> = const { Cell::new(0) };
}

fn health_slot() -> std::sync::MutexGuard<'static, Option<Result<(), String>>> {
    HEALTH.lock().unwrap_or_else(|e| e.into_inner())
}

/// The dispatcher: takes catches off the hook thread, stops the Start menu
/// opening, and runs the callback on a thread of its own.
fn dispatcher() -> &'static mpsc::Sender<()> {
    DISPATCH.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<()>();
        std::thread::spawn(move || {
            for () in rx {
                imp::mask_start_menu();
                // A real Win+E caught is proof the hook works.
                *health_slot() = Some(Ok(()));
                let callback = shared().on_press.clone();
                if let Some(f) = callback {
                    std::thread::spawn(move || f());
                }
            }
        });
        tx
    })
}

/// What re-applying the switches should do with the hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Apply {
    /// Already as wanted: the running hook is left alone.
    Nothing,
    Start,
    Stop,
}

pub fn plan_apply(running: bool, want: bool) -> Apply {
    match (running, want) {
        (false, true) => Apply::Start,
        (true, false) => Apply::Stop,
        _ => Apply::Nothing,
    }
}

/// Starts or stops catching to match `want`, and self-tests a hook it starts.
/// When the hook is already as wanted nothing happens: no reinstall, no probe.
pub fn apply(want: bool, on_press: impl Fn() + Send + Sync + 'static) -> Apply {
    let plan = plan_apply(is_running(), want);
    match plan {
        Apply::Start => {
            set(Some(on_press));
            self_test(Trigger::SelfTest);
        }
        Apply::Stop => set(None::<fn()>),
        Apply::Nothing => {}
    }
    plan
}

/// Starts (`Some`) or stops (`None`) catching Win+E. `on_press` runs on its own
/// thread each time the combination is caught. Starting also starts the
/// liveness checks; run [`self_test`] after it to know whether catching works.
/// Calling it with `Some` while a hook runs only replaces the callback.
pub fn set(on_press: Option<impl Fn() + Send + Sync + 'static>) {
    let mut s = shared();
    match on_press {
        Some(f) => {
            dispatcher();
            s.on_press = Some(std::sync::Arc::new(f));
            if s.worker.is_none() {
                s.worker = start_active();
                log::write(log::Stage::Install, if s.worker.is_some() { "keyboard hook installed" } else { "the keyboard hook could not be installed" }, None);
            }
            if s.watch.is_none() {
                s.watch = imp::watch();
            }
        }
        None => {
            s.on_press = None;
            let old = s.worker.take();
            let watch = s.watch.take();
            ACTIVE_GEN.store(0, Ordering::SeqCst);
            drop(s);
            if let Some(w) = watch {
                w.stop();
            }
            if let Some(w) = old {
                w.stop();
                log::write(log::Stage::Install, "keyboard hook removed", None);
            }
            *health_slot() = None;
        }
    }
}

fn start_active() -> Option<imp::Worker> {
    let w = imp::start(NEXT_GEN.fetch_add(1, Ordering::SeqCst))?;
    ACTIVE_GEN.store(w.generation, Ordering::SeqCst);
    REAL_AT_CHECK.store(REAL_EVENTS.load(Ordering::SeqCst), Ordering::SeqCst);
    Some(w)
}

/// Replaces `old` with a new hook, new first: `start` installs it, `activate`
/// makes it the one that acts, then `stop` removes the old one. If the new one
/// can't be installed, the old one stays. Returns the hook and whether it is new.
pub fn replace<W>(old: Option<W>, start: impl FnOnce() -> Option<W>, activate: impl FnOnce(&W), stop: impl FnOnce(W)) -> (Option<W>, bool) {
    match start() {
        Some(new) => {
            activate(&new);
            if let Some(o) = old {
                stop(o);
            }
            (Some(new), true)
        }
        None => (old, false),
    }
}

/// Whether the hook of generation `mine` acts on events now.
pub fn owns(mine: u64, active: u64) -> bool {
    mine != 0 && mine == active
}

/// Whether the key event is the Win+E press to take over.
pub fn is_win_e(vk_is_e: bool, win_held: bool, ctrl_shift_alt_held: bool) -> bool {
    vk_is_e && win_held && !ctrl_shift_alt_held
}

/// What the hook does with one key event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Not ours: passed on unchanged.
    Pass,
    /// Win+E: taken, and handed off.
    Catch,
    /// A repeat or the key-up of a taken E.
    Swallow,
    /// Octopolis's own marked probe key: taken and counted, never passed on.
    Probe,
}

/// The hook's decision (WE-02, WE-05). `swallowing`: an E key-down was taken
/// and its key-up hasn't come yet. Cheap: no allocation, no lock, no system call.
pub fn decide(vk: u32, extra: usize, key_down: bool, win_held: bool, ctrl_shift_alt_held: bool, swallowing: bool) -> Decision {
    if extra == PROBE_MARK && vk == PROBE_VK {
        return Decision::Probe;
    }
    if vk != VK_E {
        return Decision::Pass;
    }
    if swallowing {
        // The taken E's auto-repeats and its key-up.
        return Decision::Swallow;
    }
    if key_down && is_win_e(true, win_held, ctrl_shift_alt_held) {
        return Decision::Catch;
    }
    Decision::Pass
}

/// The hook's body apart from Windows: atomics and a channel send, nothing
/// that can block. `true`: swallow the event.
pub fn on_key(vk: u32, extra: usize, key_down: bool, injected: bool, win_held: bool, ctrl_shift_alt_held: bool) -> bool {
    if !injected {
        REAL_EVENTS.fetch_add(1, Ordering::Relaxed);
    }
    match decide(vk, extra, key_down, win_held, ctrl_shift_alt_held, SWALLOWING.load(Ordering::Relaxed)) {
        Decision::Pass => false,
        Decision::Probe => {
            if key_down {
                PROBES_SEEN.fetch_add(1, Ordering::SeqCst);
            }
            true
        }
        Decision::Swallow => {
            if !key_down {
                SWALLOWING.store(false, Ordering::Relaxed);
            }
            true
        }
        Decision::Catch => {
            SWALLOWING.store(true, Ordering::Relaxed);
            if let Some(tx) = DISPATCH.get() {
                let _ = tx.send(());
            }
            true
        }
    }
}

/// Whether the hook keyboard hook is installed right now.
pub fn is_running() -> bool {
    shared().worker.is_some()
}

/// Whether this is a hook thread (a probe must never be sent or waited on from one).
pub fn is_hook_thread() -> bool {
    HOOK_GEN.with(Cell::get) != 0
}

/// The last self-test: `Some(Ok)` working, `Some(Err(reason))` not working, `None` not tested yet or off.
pub fn health() -> Option<Result<(), String>> {
    health_slot().clone()
}

/// [`health`] with "checking" for a hook that has no result yet.
pub fn health_state() -> Health {
    if shared().on_press.is_none() {
        return Health::Off;
    }
    match health() {
        None => Health::Checking,
        Some(Ok(())) => Health::Working,
        Some(Err(why)) => Health::NotWorking(why),
    }
}

/// Injects the marked test key and waits for the hook to see it.
pub fn probe() -> ProbeResult {
    if !is_running() {
        return Err(ProbeError::NotInstalled);
    }
    // A window in front that can't receive injected input: nothing to learn now (WE-05).
    if let Some(why) = liveness::cant_test_now(imp::foreground()) {
        return Err(ProbeError::CantTestNow(why.into()));
    }
    probe_with(imp::inject_probe, PROBE_WAIT)
}

/// The probe, with the injection given. Runs on the calling thread, which is
/// never a hook thread: the hook has to be free to see the key.
pub fn probe_with(inject: impl FnOnce() -> Result<(), String>, wait: Duration) -> ProbeResult {
    if is_hook_thread() {
        return Err(ProbeError::CantTestNow("asked from the hook's own thread".into()));
    }
    let before = PROBES_SEEN.load(Ordering::SeqCst);
    let started = Instant::now();
    inject().map_err(ProbeError::CantTestNow)?;
    while started.elapsed() < wait {
        if PROBES_SEEN.load(Ordering::SeqCst) > before {
            return Ok(started.elapsed());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Err(ProbeError::NotSeen)
}

/// Installs a new hook and then removes the old one. `false` when catching was
/// turned off meanwhile, or the new hook couldn't be installed (the old one stays).
fn reinstall() -> bool {
    let mut s = shared();
    if s.on_press.is_none() {
        return false;
    }
    let old = s.worker.take();
    let (worker, fresh) = swap_hook(old, |w| w.generation, || imp::start(NEXT_GEN.fetch_add(1, Ordering::SeqCst)), imp::Worker::stop);
    s.worker = worker;
    fresh
}

/// The reinstall itself: the new hook is installed and made the active one
/// (so it acts from then on), and only then is the old one stopped.
fn swap_hook<W>(old: Option<W>, generation: impl Fn(&W) -> u64, start: impl FnOnce() -> Option<W>, stop: impl FnOnce(W)) -> (Option<W>, bool) {
    replace(old, start, |w| ACTIVE_GEN.store(generation(w), Ordering::SeqCst), stop)
}

fn note_reinstall() {
    *LAST_REINSTALL.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
}

/// A reinstall is allowed when there was none, or the last was [`REINSTALL_BACKOFF`] ago.
pub fn may_reinstall_at(last: Option<Instant>, now: Instant) -> bool {
    last.is_none_or(|t| now.saturating_duration_since(t) >= REINSTALL_BACKOFF)
}

/// Repair: a fresh hook (new before old), then the self-test.
pub fn restart() -> Option<Result<(), String>> {
    note_reinstall();
    if reinstall() {
        log::write(log::Stage::Reinstall, "repair: hook reinstalled", None);
    }
    self_test(Trigger::SelfTest)
}

/// Runs the self-test now (turning on, Repair) or for a liveness trigger, and
/// keeps the result for [`health`]. Does nothing while catching is off.
pub fn self_test(trigger: Trigger) -> Option<Result<(), String>> {
    self_test_with(trigger, probe, reinstall)
}

/// [`self_test`] with the probe and the reinstall given (tests).
fn self_test_with(trigger: Trigger, probe: impl FnMut() -> ProbeResult, reinstall: impl FnOnce() -> bool) -> Option<Result<(), String>> {
    let _one = CHECK.lock().unwrap_or_else(|e| e.into_inner());
    shared().on_press.as_ref()?;
    let real = REAL_EVENTS.load(Ordering::SeqCst);
    let hook_alive = real > REAL_AT_CHECK.swap(real, Ordering::SeqCst);
    let last = *LAST_REINSTALL.lock().unwrap_or_else(|e| e.into_inner());
    let may_reinstall = may_reinstall_at(last, Instant::now());
    let reinstall = || {
        note_reinstall();
        reinstall()
    };
    let out = liveness::check(trigger, Context { hook_alive, may_reinstall }, probe, reinstall, |(stage, reason, detail, ms)| log::write_with(stage, &reason, detail.as_deref(), ms));
    if let Some(h) = out.health
        && shared().on_press.is_some()
    {
        *health_slot() = Some(h);
    }
    health()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn on_trigger(trigger: Trigger) {
    std::thread::spawn(move || {
        self_test(trigger);
    });
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

    use std::sync::mpsc;
    use std::thread::JoinHandle;

    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Security::{GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TokenIntegrityLevel};
    use windows::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    use windows::Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, WTSUnRegisterSessionNotification};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, KBDLLHOOKSTRUCT, KillTimer, MSG, PM_NOREMOVE, PeekMessageW, PostThreadMessageW,
        RegisterClassW, RegisterWindowMessageW, SetTimer, SetWindowsHookExW, UnhookWindowsHookEx, WH_KEYBOARD_LL, WINDOW_EX_STYLE, WINDOW_STYLE, WM_KEYDOWN, WM_POWERBROADCAST, WM_QUIT,
        WM_SYSKEYDOWN, WM_TIMER, WNDCLASSW,
    };
    use windows::core::w;

    use super::liveness::{Foreground, should_probe};
    use super::{ACTIVE_GEN, HOOK_GEN, PROBE_MARK, PROBE_VK, Trigger, VK_E, on_key, on_trigger, owns};

    /// `KBDLLHOOKSTRUCT.flags`: the event was injected.
    const LLKHF_INJECTED: u32 = 0x10;

    pub struct Worker {
        thread_id: u32,
        handle: JoinHandle<()>,
        /// This hook's generation; it acts only while it is the active one.
        pub generation: u64,
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

    /// The hook. It never waits: a key state read for an E key-down, atomics, and
    /// at most one channel send. A hook that isn't the active one passes everything.
    unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && owns(HOOK_GEN.with(std::cell::Cell::get), ACTIVE_GEN.load(Ordering::SeqCst)) {
            // SAFETY: for WH_KEYBOARD_LL, lparam points at a KBDLLHOOKSTRUCT for the duration of the call.
            let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            let msg = wparam.0 as u32;
            let key_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            // Modifier state is only read for an E key-down.
            let (win, others) = if info.vkCode == VK_E && key_down {
                (down(VK_LWIN.0) || down(VK_RWIN.0), down(VK_CONTROL.0) || down(VK_SHIFT.0) || down(VK_MENU.0))
            } else {
                (false, false)
            };
            if on_key(info.vkCode, info.dwExtraInfo, key_down, info.flags.0 & LLKHF_INJECTED != 0, win, others) {
                return LRESULT(1);
            }
        }
        // SAFETY: passes the event on unchanged.
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    /// After a catch, on the dispatcher thread: a key pressed in between stops
    /// Windows opening the Start menu when Win is let go.
    pub fn mask_start_menu() {
        // Tests never send keys.
        #[cfg(not(test))]
        // SAFETY: plain synthetic key press of an unassigned key.
        unsafe {
            use windows::Win32::UI::Input::KeyboardAndMouse::keybd_event;
            keybd_event(0xFF, 0, KEYBD_EVENT_FLAGS(0), 0);
            keybd_event(0xFF, 0, KEYEVENTF_KEYUP, 0);
        }
    }

    fn run(generation: u64, ready: mpsc::Sender<Option<u32>>) {
        HOOK_GEN.with(|g| g.set(generation));
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

    /// Installs a hook of generation `generation` on a thread of its own. It acts once it is made active.
    pub fn start(generation: u64) -> Option<Worker> {
        let (tx, rx) = mpsc::channel();
        let handle = std::thread::spawn(move || run(generation, tx));
        let thread_id = rx.recv().ok()??;
        Some(Worker { thread_id, handle, generation })
    }

    /// Sends the marked test key (down and up).
    pub fn inject_probe() -> Result<(), String> {
        let key = |flags: KEYBD_EVENT_FLAGS| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(PROBE_VK as u16), wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: PROBE_MARK } },
        };
        let inputs = [key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)];
        // SAFETY: two well-formed keyboard inputs.
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent == inputs.len() as u32 { Ok(()) } else { Err(format!("Windows took {sent} of 2 events: {}", windows::core::Error::from_thread().message())) }
    }

    /// Integrity level (the last sub-authority of the token's mandatory label) of a process.
    ///
    /// # Safety
    /// `process` must be a valid process handle with query access.
    unsafe fn integrity(process: HANDLE) -> Option<u32> {
        let mut token = HANDLE::default();
        // SAFETY: valid process handle; the token handle is closed below.
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.ok()?;
        let mut len = 0u32;
        // SAFETY: size query with no buffer.
        let _ = unsafe { GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut len) };
        // u64 storage keeps TOKEN_MANDATORY_LABEL's pointer aligned.
        let mut buf = vec![0u64; (len as usize).div_ceil(8).max(1)];
        // SAFETY: the buffer holds at least `len` bytes.
        let read = unsafe { GetTokenInformation(token, TokenIntegrityLevel, Some(buf.as_mut_ptr().cast()), len, &mut len) };
        // SAFETY: closes the token opened above.
        let _ = unsafe { CloseHandle(token) };
        read.ok()?;
        // SAFETY: on success the buffer starts with a TOKEN_MANDATORY_LABEL whose SID lives in the buffer.
        unsafe {
            let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
            let count = *GetSidSubAuthorityCount(label.Label.Sid);
            Some(*GetSidSubAuthority(label.Label.Sid, u32::from(count).checked_sub(1)?))
        }
    }

    /// What is in front, for the "can't test now" decision.
    pub fn foreground() -> Foreground {
        // SAFETY: plain window and process queries; every handle opened is closed.
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_invalid() {
                return Foreground::Ours;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 || pid == GetCurrentProcessId() {
                return Foreground::Ours;
            }
            let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return Foreground::CantOpen;
            };
            let theirs = integrity(process);
            let _ = CloseHandle(process);
            match (theirs, integrity(GetCurrentProcess())) {
                (Some(theirs), Some(ours)) => Foreground::Integrity { theirs, ours },
                _ => Foreground::CantOpen,
            }
        }
    }

    // Window messages for the liveness triggers.
    const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
    const WTS_SESSION_LOCK: usize = 0x7;
    const WTS_SESSION_UNLOCK: usize = 0x8;
    const PBT_APMRESUMESUSPEND: usize = 0x7;
    const PBT_APMRESUMEAUTOMATIC: usize = 0x12;
    const NOTIFY_FOR_THIS_SESSION: u32 = 0;
    const MINUTE_TIMER: usize = 1;

    static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);
    static LOCKED: AtomicBool = AtomicBool::new(false);

    /// A hidden top-level window that receives unlock, resume and TaskbarCreated, plus a one-minute timer.
    pub struct Watch {
        thread_id: u32,
        handle: JoinHandle<()>,
    }

    impl Watch {
        pub fn stop(self) {
            // SAFETY: asks the thread's message loop to end.
            let _ = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
            let _ = self.handle.join();
        }
    }

    unsafe extern "system" fn watch_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        match msg {
            WM_TIMER if wparam.0 == MINUTE_TIMER => {
                // A locked session can't take the test key; unlock checks again.
                if should_probe(Trigger::Minute, LOCKED.load(Ordering::Relaxed)) {
                    on_trigger(Trigger::Minute);
                }
            }
            WM_WTSSESSION_CHANGE => match wparam.0 {
                WTS_SESSION_LOCK => LOCKED.store(true, Ordering::Relaxed),
                WTS_SESSION_UNLOCK => {
                    LOCKED.store(false, Ordering::Relaxed);
                    on_trigger(Trigger::Unlock);
                }
                _ => {}
            },
            WM_POWERBROADCAST => {
                if matches!(wparam.0, PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND) {
                    on_trigger(Trigger::Resume);
                }
                return LRESULT(1);
            }
            m if m != 0 && m == TASKBAR_CREATED.load(Ordering::Relaxed) => on_trigger(Trigger::TaskbarCreated),
            _ => {}
        }
        // SAFETY: default handling for everything else.
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    fn watch_run(ready: mpsc::Sender<Option<u32>>) {
        // SAFETY: the window, timer and notification belong to this thread and are removed before it ends.
        unsafe {
            let class = w!("OctopolisWinEWatch");
            let wc = WNDCLASSW { lpfnWndProc: Some(watch_proc), lpszClassName: class, ..Default::default() };
            // Fails harmlessly when the class is already registered by an earlier watch.
            let _ = RegisterClassW(&wc);
            let Ok(hwnd) = CreateWindowExW(WINDOW_EX_STYLE(0), class, w!(""), WINDOW_STYLE(0), 0, 0, 0, 0, None, None, None, None) else {
                let _ = ready.send(None);
                return;
            };
            TASKBAR_CREATED.store(RegisterWindowMessageW(w!("TaskbarCreated")), Ordering::Relaxed);
            let session = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION).is_ok();
            SetTimer(Some(hwnd), MINUTE_TIMER, 60_000, None);
            let _ = ready.send(Some(GetCurrentThreadId()));
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                DispatchMessageW(&msg);
            }
            let _ = KillTimer(Some(hwnd), MINUTE_TIMER);
            if session {
                let _ = WTSUnRegisterSessionNotification(hwnd);
            }
            let _ = DestroyWindow(hwnd);
        }
    }

    pub fn watch() -> Option<Watch> {
        let (tx, rx) = mpsc::channel();
        let handle = std::thread::spawn(move || watch_run(tx));
        let thread_id = rx.recv().ok()??;
        Some(Watch { thread_id, handle })
    }
}

#[cfg(not(windows))]
mod imp {
    pub struct Worker {
        pub generation: u64,
    }
    impl Worker {
        pub fn stop(self) {}
    }
    pub fn start(_gen: u64) -> Option<Worker> {
        None
    }
    pub fn mask_start_menu() {}
    pub struct Watch;
    impl Watch {
        pub fn stop(self) {}
    }
    pub fn watch() -> Option<Watch> {
        None
    }
    pub fn inject_probe() -> Result<(), String> {
        Err("not on Windows".into())
    }
    pub fn foreground() -> super::liveness::Foreground {
        super::liveness::Foreground::Ours
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

    #[test]
    fn the_marked_probe_is_swallowed_and_unmarked_keys_pass() {
        assert_eq!(decide(PROBE_VK, PROBE_MARK, true, false, false, false), Decision::Probe);
        assert_eq!(decide(PROBE_VK, PROBE_MARK, false, false, false, false), Decision::Probe, "its key-up is taken too");
        assert_eq!(decide(PROBE_VK, 0, true, false, false, false), Decision::Pass, "the same key, unmarked, passes");
        assert_eq!(decide(PROBE_VK, 12345, true, false, false, false), Decision::Pass, "another app's injected key passes");
        assert_eq!(decide(0x41, PROBE_MARK, true, false, false, false), Decision::Pass, "the mark alone isn't enough");
        assert_eq!(decide(VK_E, PROBE_MARK, true, false, false, false), Decision::Pass, "the probe is never an E");
    }

    #[test]
    fn win_e_is_caught_and_its_repeats_and_key_up_swallowed() {
        assert_eq!(decide(VK_E, 0, true, true, false, false), Decision::Catch);
        assert_eq!(decide(VK_E, 0, true, true, false, true), Decision::Swallow, "auto-repeat isn't a second catch");
        assert_eq!(decide(VK_E, 0, false, false, false, true), Decision::Swallow, "the key-up");
        assert_eq!(decide(VK_E, 0, true, false, false, false), Decision::Pass, "E alone");
        assert_eq!(decide(VK_E, 0, true, true, true, false), Decision::Pass, "Win+Shift/Ctrl/Alt+E");
        assert_eq!(decide(0x5B, 0, true, true, false, true), Decision::Pass, "other keys pass even while swallowing");
    }

    #[test]
    fn the_decision_takes_well_under_a_millisecond() {
        let started = Instant::now();
        let mut taken = 0u32;
        for i in 0..100_000u32 {
            let d = decide(std::hint::black_box(0x40 + i % 8), (i % 3) as usize, i % 2 == 1, i % 3 == 0, i % 7 == 0, i % 11 == 0);
            if d != Decision::Pass {
                taken += 1;
            }
        }
        assert!(taken > 0);
        assert!(started.elapsed() < Duration::from_millis(100), "{:?} for 100 000 decisions", started.elapsed());
    }

    /// Tests that use the shared hook state run one at a time.
    static SERIAL: Mutex<()> = Mutex::new(());

    /// Points the dispatcher at a test callback (no hook is installed, no key is sent).
    fn with_callback(f: impl Fn() + Send + Sync + 'static) -> std::sync::MutexGuard<'static, ()> {
        let guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        dispatcher();
        shared().on_press = Some(std::sync::Arc::new(f));
        SWALLOWING.store(false, Ordering::SeqCst);
        guard
    }

    fn release_e() {
        on_key(VK_E, 0, false, false, false, false);
        assert!(!SWALLOWING.load(Ordering::SeqCst));
    }

    #[test]
    fn the_hook_never_waits_for_the_callback() {
        let (tx, rx) = mpsc::channel();
        let _g = with_callback(move || {
            let _ = tx.send(());
            std::thread::sleep(Duration::from_secs(2));
        });
        let started = Instant::now();
        assert!(on_key(VK_E, 0, true, false, true, false), "Win+E is taken");
        assert!(started.elapsed() < Duration::from_millis(50), "the hook returned after {:?}", started.elapsed());
        rx.recv_timeout(Duration::from_secs(5)).expect("the callback ran, off the hook thread");
        release_e();
        shared().on_press = None;
    }

    #[test]
    fn the_probe_is_sent_from_another_thread_and_the_hook_sees_it() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        assert!(!is_hook_thread());
        // Windows calls the hook on the hook's own thread, which is free while the probe waits.
        let seen = probe_with(
            || {
                std::thread::spawn(|| {
                    std::thread::sleep(Duration::from_millis(20));
                    assert!(on_key(PROBE_VK, PROBE_MARK, true, true, false, false), "the probe is swallowed");
                    assert!(on_key(PROBE_VK, PROBE_MARK, false, true, false, false));
                });
                Ok(())
            },
            Duration::from_millis(500),
        );
        assert!(seen.is_ok(), "{seen:?}");
    }

    #[test]
    fn a_probe_is_never_sent_from_the_hook_thread() {
        let r = std::thread::spawn(|| {
            HOOK_GEN.with(|g| g.set(42));
            probe_with(|| panic!("nothing may be injected from the hook thread"), Duration::from_millis(50))
        })
        .join()
        .unwrap();
        assert!(matches!(r, Err(ProbeError::CantTestNow(_))), "{r:?}");
    }

    #[test]
    fn a_reinstall_installs_the_new_hook_before_removing_the_old_one() {
        let steps = std::cell::RefCell::new(Vec::new());
        let (hook, fresh) = replace(Some("old"), || {
            steps.borrow_mut().push("install new");
            Some("new")
        }, |_| steps.borrow_mut().push("activate new"), |o| steps.borrow_mut().push(if o == "old" { "remove old" } else { "?" }));
        assert_eq!((hook, fresh), (Some("new"), true));
        assert_eq!(*steps.borrow(), ["install new", "activate new", "remove old"]);

        // A new hook that can't be installed leaves the old one running.
        let steps = std::cell::RefCell::new(Vec::new());
        let (hook, fresh) = replace(Some("old"), || None::<&str>, |_| steps.borrow_mut().push("activate"), |_| steps.borrow_mut().push("remove old"));
        assert_eq!((hook, fresh), (Some("old"), false));
        assert!(steps.borrow().is_empty(), "the old hook is never removed without a replacement");
    }

    /// How many hooks act on one Win+E, newest first, as Windows calls them.
    fn catches(chain: &[u64], active: u64) -> usize {
        // The first hook that owns the event takes and swallows it; the rest never see it.
        usize::from(chain.iter().any(|&g| owns(g, active)))
    }

    #[test]
    fn a_win_e_during_a_reinstall_is_caught_exactly_once() {
        // Old hook 1 runs; new hook 2 is installed (in front), made active, then 1 is removed.
        let steps: [(&[u64], u64); 4] = [(&[1], 1), (&[2, 1], 1), (&[2, 1], 2), (&[2], 2)];
        for (chain, active) in steps {
            assert_eq!(catches(chain, active), 1, "chain {chain:?}, active {active}");
        }
        assert!(!owns(1, 2), "a replaced hook passes everything");
        assert!(!owns(0, 0), "a thread that isn't a hook thread never acts");
    }

    #[test]
    fn a_win_e_during_a_probe_is_still_caught() {
        let (tx, rx) = mpsc::channel();
        let _g = with_callback(move || {
            let _ = tx.send(());
        });
        // A probe whose key never arrives keeps waiting for its full time.
        let probing = std::thread::spawn(|| probe_with(|| Ok(()), Duration::from_millis(300)));
        std::thread::sleep(Duration::from_millis(30));
        let started = Instant::now();
        assert!(on_key(VK_E, 0, true, false, true, false));
        assert!(started.elapsed() < Duration::from_millis(50));
        rx.recv_timeout(Duration::from_secs(2)).expect("caught while the probe waited");
        assert_eq!(probing.join().unwrap(), Err(ProbeError::NotSeen));
        release_e();
        shared().on_press = None;
    }

    #[test]
    fn reinstall_stops_the_old_hook_only_after_the_new_one_is_active() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        ACTIVE_GEN.store(1, Ordering::SeqCst);
        let active_when_stopped = std::cell::Cell::new(0);
        let (hook, fresh) = swap_hook(Some(1u64), |g| *g, || Some(2u64), |old| {
            assert_eq!(old, 1);
            active_when_stopped.set(ACTIVE_GEN.load(Ordering::SeqCst));
        });
        assert_eq!((hook, fresh), (Some(2), true));
        assert_eq!(active_when_stopped.get(), 2, "the new hook was already the one acting");
        // No new hook: the old one stays active and is never stopped.
        let (hook, fresh) = swap_hook(Some(2u64), |g| *g, || None, |_| panic!("the only hook must not be stopped"));
        assert_eq!((hook, fresh), (Some(2), false));
        assert_eq!(ACTIVE_GEN.load(Ordering::SeqCst), 2);
        ACTIVE_GEN.store(0, Ordering::SeqCst);
    }

    #[test]
    fn the_self_test_reinstalls_at_most_once_per_backoff() {
        let _g = with_callback(|| {});
        *LAST_REINSTALL.lock().unwrap() = None;
        REAL_AT_CHECK.store(REAL_EVENTS.load(Ordering::SeqCst), Ordering::SeqCst);
        let reinstalls = std::cell::Cell::new(0);
        let not_seen = || Err(ProbeError::NotSeen);
        let reinstall = || {
            reinstalls.set(reinstalls.get() + 1);
            true
        };
        self_test_with(Trigger::Minute, not_seen, reinstall);
        assert_eq!(reinstalls.get(), 1, "the first failure reinstalls");
        for _ in 0..5 {
            self_test_with(Trigger::Minute, not_seen, reinstall);
        }
        assert_eq!(reinstalls.get(), 1, "within the back-off: no loop");
        assert!(matches!(health(), Some(Err(_))), "and it says so");
        // Ten minutes later, one more try.
        *LAST_REINSTALL.lock().unwrap() = Instant::now().checked_sub(REINSTALL_BACKOFF);
        self_test_with(Trigger::Minute, not_seen, reinstall);
        assert_eq!(reinstalls.get(), 2);
        assert!(may_reinstall_at(None, Instant::now()));
        assert!(!may_reinstall_at(Some(Instant::now()), Instant::now()));
        shared().on_press = None;
        *health_slot() = None;
        *LAST_REINSTALL.lock().unwrap() = None;
    }

    #[test]
    fn re_applying_unchanged_switches_leaves_the_hook_alone() {
        assert_eq!(plan_apply(true, true), Apply::Nothing, "running and wanted: no reinstall, no probe");
        assert_eq!(plan_apply(false, false), Apply::Nothing);
        assert_eq!(plan_apply(false, true), Apply::Start);
        assert_eq!(plan_apply(true, false), Apply::Stop);
    }

    #[test]
    fn only_real_key_events_are_counted_and_nothing_about_them() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let before = REAL_EVENTS.load(Ordering::SeqCst);
        assert!(!on_key(0x41, 0, true, false, false, false), "an ordinary key passes");
        assert!(!on_key(0x41, 0, true, true, false, false), "an injected one too");
        assert_eq!(REAL_EVENTS.load(Ordering::SeqCst), before + 1, "only the real one counts");
    }


    #[test]
    fn a_probe_without_a_hook_fails_and_injects_nothing() {
        // Nothing is installed in unit tests: the probe says so without sending a key.
        if !is_running() {
            assert_eq!(probe(), Err(ProbeError::NotInstalled));
        }
    }

    /// Needs a desktop session: sends a real Win+E and checks the hook takes it.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn hook_takes_a_real_win_e() {
        use std::sync::atomic::AtomicUsize;
        use windows::Win32::UI::Input::KeyboardAndMouse::{KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, keybd_event};
        static HITS: AtomicUsize = AtomicUsize::new(0);
        set(Some(|| {
            HITS.fetch_add(1, Ordering::SeqCst);
        }));
        std::thread::sleep(Duration::from_millis(500));
        // SAFETY: synthetic key presses for the test.
        unsafe {
            keybd_event(0x5B, 0, KEYBD_EVENT_FLAGS(0), 0);
            keybd_event(0x45, 0, KEYBD_EVENT_FLAGS(0), 0);
            keybd_event(0x45, 0, KEYEVENTF_KEYUP, 0);
            keybd_event(0x5B, 0, KEYEVENTF_KEYUP, 0);
        }
        std::thread::sleep(Duration::from_millis(1500));
        set(None::<fn()>);
        assert_eq!(HITS.load(Ordering::SeqCst), 1);
    }

    /// Needs a desktop session: the real self-test sees its probe through a real hook, and no key reaches an app.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn the_real_self_test_passes_with_a_hook() {
        set(Some(|| {}));
        assert_eq!(self_test(Trigger::SelfTest), Some(Ok(())));
        set(None::<fn()>);
        assert_eq!(health(), None);
    }
}
