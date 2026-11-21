//! The link between the Win+E helper (`octopolis-keys.exe`, WE-01) and the
//! running Octopolis (WE-03).
//!
//! Octopolis (the copy the entries point at) hosts a named pipe in this
//! session, with a current-user-only ACL, rejecting remote clients. For each
//! caught Win+E the helper connects and sends one fixed 9-byte message:
//! `OPEN(id)` ("open This PC, request id"), or `WAIT(id)` for an Octopolis it
//! just started for that request. Octopolis answers `SHOWN(id)` once the
//! window is visible and painted. Closing the connection before that cancels
//! the request: it is then never opened. Nothing else is accepted, and no path
//! or argument is ever read from the pipe.
//!
//! The helper's other controls are session-local named objects: a mutex (one
//! helper per session), a quit event and a repair event. Its probe result is
//! written to a small status file in Octopolis's data folder.

use std::path::{Path, PathBuf};

use super::Health;

/// The helper's file name, beside `Octopolis.exe`.
pub const HELPER_EXE: &str = "octopolis-keys.exe";
/// Held by the running helper: one per session.
pub const HELPER_MUTEX: &str = "Local\\OctopolisKeys";
/// Set to make the running helper stop.
pub const QUIT_EVENT: &str = "Local\\OctopolisKeys-Quit";
/// Set to make the running helper reinstall its hook and test it (Repair).
pub const REPAIR_EVENT: &str = "Local\\OctopolisKeys-Repair";
/// The helper's last probe result, in `%LOCALAPPDATA%\app.octopolis.explorer`.
pub const STATUS_FILE: &str = "keys-status.txt";
/// "Win+E opens Octopolis" (WE-14), kept current by Octopolis for the helper:
/// `on` or `off`, in `%LOCALAPPDATA%pp.octopolis.explorer`.
pub const SWITCH_FILE: &str = "win-e-switch.txt";

/// The switch as last saved; on when it was never saved (its default).
pub fn read_switch(dir: &Path) -> bool {
    std::fs::read_to_string(dir.join(SWITCH_FILE)).map_or(true, |t| t.trim() != "off")
}

/// Saves the switch.
pub fn write_switch(dir: &Path, on: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(SWITCH_FILE), if on { "on" } else { "off" })
}

/// Passed to an Octopolis the helper starts for request `id`.
pub const REQUEST_ARG: &str = "--win-e-request";

/// The helper beside `octopolis_exe`.
pub fn helper_beside(octopolis_exe: &Path) -> PathBuf {
    octopolis_exe.with_file_name(HELPER_EXE)
}

/// The pipe for a session.
pub fn pipe_name(session: u32) -> String {
    format!("\\\\.\\pipe\\octopolis-win-e-{session}")
}

pub const MESSAGE_LEN: usize = 9;

/// The other side closed the connection, or sent something that isn't a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HungUp;

/// The whole message set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Message {
    /// Helper → Octopolis: open This PC for this request.
    Open(u64),
    /// Helper → Octopolis: you were started for this request; open This PC for it.
    Wait(u64),
    /// Octopolis → helper: the window for this request is visible and painted.
    Shown(u64),
}

impl Message {
    pub fn encode(self) -> [u8; MESSAGE_LEN] {
        let (kind, id) = match self {
            Self::Open(id) => (1u8, id),
            Self::Wait(id) => (2, id),
            Self::Shown(id) => (3, id),
        };
        let mut out = [0u8; MESSAGE_LEN];
        out[0] = kind;
        out[1..].copy_from_slice(&id.to_le_bytes());
        out
    }

    /// Exactly one known message, or nothing.
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        let bytes: &[u8; MESSAGE_LEN] = bytes.try_into().ok()?;
        let id = u64::from_le_bytes(bytes[1..].try_into().ok()?);
        match bytes[0] {
            1 => Some(Self::Open(id)),
            2 => Some(Self::Wait(id)),
            3 => Some(Self::Shown(id)),
            _ => None,
        }
    }
}

/// The request id in an Octopolis command line (`--win-e-request <id>`), if any.
pub fn request_arg(args: &[String]) -> Option<u64> {
    let i = args.iter().position(|a| a.eq_ignore_ascii_case(REQUEST_ARG))?;
    args.get(i + 1)?.parse().ok()
}

/// The status file's text for a health.
pub fn format_status(h: &Health) -> String {
    match h {
        Health::Off => "off".into(),
        Health::Checking => "checking".into(),
        Health::Working => "working".into(),
        Health::NotWorking(why) => format!("notWorking\t{}", why.replace(['\r', '\n', '\t'], " ")),
    }
}

/// A health from the status file's text.
pub fn parse_status(text: &str) -> Health {
    let text = text.trim();
    match text.split_once('\t') {
        Some(("notWorking", why)) => Health::NotWorking(why.to_string()),
        _ => match text {
            "working" => Health::Working,
            "checking" => Health::Checking,
            "notWorking" => Health::NotWorking("unknown reason".into()),
            _ => Health::Off,
        },
    }
}

#[cfg(windows)]
pub mod sys {
    //! Windows: the pipe, the named objects and process checks.

    use std::path::PathBuf;
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE, GetLastError, HANDLE, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
    use windows::Win32::Security::{GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_NONE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX, ReadFile, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
        WriteFile,
    };
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId, GetNamedPipeServerProcessId, PIPE_READMODE_MESSAGE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_MESSAGE,
        PIPE_UNLIMITED_INSTANCES, PIPE_WAIT, PeekNamedPipe, SetNamedPipeHandleState,
    };
    use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    use windows::Win32::System::Threading::{
        CreateEventW, CreateMutexW, EVENT_MODIFY_STATE, GetCurrentProcess, GetCurrentProcessId, OpenEventW, OpenMutexW, OpenProcess, OpenProcessToken, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW, SYNCHRONIZATION_SYNCHRONIZE, SetEvent, WaitForMultipleObjects,
    };
    use windows::core::{HSTRING, PWSTR};

    use super::{HungUp, MESSAGE_LEN, Message};

    /// A kernel handle, closed on drop.
    pub struct Owned(HANDLE);

    // SAFETY: a kernel handle can be used and closed from any thread.
    unsafe impl Send for Owned {}
    // SAFETY: see above; the operations used are thread-safe.
    unsafe impl Sync for Owned {}

    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: the handle is owned and closed once.
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    impl Owned {
        pub fn raw(&self) -> HANDLE {
            self.0
        }
    }

    /// This process's session.
    pub fn session() -> u32 {
        let mut session = 0u32;
        // SAFETY: plain query into a local.
        let _ = unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) };
        session
    }

    /// The pipe's access list: only the current user, full access, nothing inherited.
    pub fn user_only_sddl() -> Option<String> {
        // SAFETY: a token query on this process; the SID string is freed.
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;
            let token = Owned(token);
            let mut len = 0u32;
            let _ = GetTokenInformation(token.raw(), TokenUser, None, 0, &mut len);
            let mut buf = vec![0u64; (len as usize).div_ceil(8).max(1)];
            GetTokenInformation(token.raw(), TokenUser, Some(buf.as_mut_ptr().cast()), len, &mut len).ok()?;
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut sid = PWSTR::null();
            ConvertSidToStringSidW(user.User.Sid, &mut sid).ok()?;
            let text = sid.to_string().ok();
            let _ = LocalFree(Some(HLOCAL(sid.0.cast())));
            Some(format!("D:P(A;;GA;;;{})", text?))
        }
    }

    /// [`user_only_sddl`] as a security descriptor (made once, kept for the process).
    fn user_only() -> Option<PSECURITY_DESCRIPTOR> {
        static SD: OnceLock<Option<usize>> = OnceLock::new();
        let sd = *SD.get_or_init(|| {
            let sddl = user_only_sddl()?;
            let mut sd = PSECURITY_DESCRIPTOR::default();
            // SAFETY: converts a valid SDDL string; the descriptor is kept.
            unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(&HSTRING::from(sddl), SDDL_REVISION_1, &mut sd, None) }.ok()?;
            Some(sd.0 as usize)
        });
        sd.map(|p| PSECURITY_DESCRIPTOR(p as *mut _))
    }

    /// One connection, on either side.
    pub struct Conn(Owned);

    impl Conn {
        /// Writes one message.
        pub fn send(&self, m: Message) -> bool {
            let bytes = m.encode();
            let mut written = 0u32;
            // SAFETY: a valid pipe handle and a local buffer.
            unsafe { WriteFile(self.0.raw(), Some(&bytes), Some(&mut written), None) }.is_ok() && written as usize == MESSAGE_LEN
        }

        /// Bytes waiting, or `None` once the other side is gone.
        fn waiting(&self) -> Option<u32> {
            let mut avail = 0u32;
            // SAFETY: a valid pipe handle; only the count is read.
            unsafe { PeekNamedPipe(self.0.raw(), None, 0, None, Some(&mut avail), None) }.ok().map(|()| avail)
        }

        fn read_now(&self) -> Option<Message> {
            let mut buf = [0u8; 64];
            let mut read = 0u32;
            // SAFETY: a valid pipe handle and a local buffer.
            unsafe { ReadFile(self.0.raw(), Some(&mut buf), Some(&mut read), None) }.ok()?;
            Message::decode(&buf[..read as usize])
        }

        /// Waits up to `timeout` for one message.
        pub fn recv(&self, timeout: Duration) -> Result<Option<Message>, HungUp> {
            let started = Instant::now();
            loop {
                match self.waiting() {
                    None => return Err(HungUp),
                    Some(0) => {}
                    Some(_) => return self.read_now().map(Some).ok_or(HungUp),
                }
                if started.elapsed() >= timeout {
                    return Ok(None);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        /// The other side is still connected.
        pub fn alive(&self) -> bool {
            self.waiting().is_some()
        }

        pub fn client_pid(&self) -> Option<u32> {
            let mut pid = 0u32;
            // SAFETY: a valid pipe handle; writes a local.
            unsafe { GetNamedPipeClientProcessId(self.0.raw(), &mut pid) }.ok().map(|()| pid)
        }

        pub fn server_pid(&self) -> Option<u32> {
            let mut pid = 0u32;
            // SAFETY: a valid pipe handle; writes a local.
            unsafe { GetNamedPipeServerProcessId(self.0.raw(), &mut pid) }.ok().map(|()| pid)
        }
    }

    fn create_instance(name: &HSTRING, first: bool) -> Option<Owned> {
        let sd = user_only()?;
        let sa = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd.0, bInheritHandle: false.into() };
        let flags = if first { PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE } else { PIPE_ACCESS_DUPLEX };
        // SAFETY: a valid name and security attributes that outlive the call.
        let h = unsafe {
            CreateNamedPipeW(name, flags, PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, PIPE_UNLIMITED_INSTANCES, 64, 64, 0, Some(&sa))
        };
        (!h.is_invalid()).then_some(Owned(h))
    }

    /// Serves the pipe on this thread until `keep_going` says stop: each client
    /// is handed to `on_client` on a thread of its own. `Err` when the pipe
    /// can't be created (for example, another process already owns the name).
    pub fn serve(name: &str, keep_going: impl Fn() -> bool, on_client: impl Fn(Conn) + Send + Sync + Clone + 'static) -> Result<(), String> {
        let name = HSTRING::from(name);
        let mut first = true;
        while keep_going() {
            let Some(instance) = create_instance(&name, first) else {
                return Err(if first { "the Win+E pipe is already in use".into() } else { "the Win+E pipe couldn't take another client".into() });
            };
            first = false;
            // SAFETY: a valid pipe instance; blocks until a client connects.
            let connected = unsafe { ConnectNamedPipe(instance.raw(), None) }.is_ok() || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
            if !connected {
                continue;
            }
            if !keep_going() {
                // SAFETY: a connected instance being given up.
                let _ = unsafe { DisconnectNamedPipe(instance.raw()) };
                break;
            }
            let handler = on_client.clone();
            std::thread::spawn(move || handler(Conn(instance)));
        }
        Ok(())
    }

    /// Connects to the pipe, or `None` when nobody serves it.
    pub fn connect(name: &str) -> Option<Conn> {
        // SAFETY: opening a pipe by name; the handle is owned.
        let h = unsafe {
            CreateFileW(
                &HSTRING::from(name),
                (GENERIC_READ | GENERIC_WRITE).0,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                FILE_FLAGS_AND_ATTRIBUTES(SECURITY_SQOS_PRESENT.0 | SECURITY_IDENTIFICATION.0),
                None,
            )
        }
        .ok()?;
        let conn = Conn(Owned(h));
        let mode = PIPE_READMODE_MESSAGE;
        // SAFETY: a valid pipe handle; sets message read mode.
        unsafe { SetNamedPipeHandleState(conn.0.raw(), Some(&mode), None, None) }.ok()?;
        Some(conn)
    }

    /// The exe a process runs, or `None` when it can't be read.
    pub fn process_image(pid: u32) -> Option<PathBuf> {
        // SAFETY: a limited query on a process handle that is closed on drop.
        unsafe {
            let process = Owned(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?);
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            QueryFullProcessImageNameW(process.raw(), PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).ok()?;
            Some(PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
        }
    }

    /// Holds a named mutex for this process, or `None` when another process holds it.
    pub fn single_instance(name: &str) -> Option<Owned> {
        // SAFETY: creates (or opens) a named mutex; the handle is owned.
        let h = unsafe { CreateMutexW(None, false, &HSTRING::from(name)) }.ok()?;
        // SAFETY: reads the error left by the call above.
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            drop(Owned(h));
            return None;
        }
        Some(Owned(h))
    }

    /// Whether some process holds the named mutex.
    pub fn exists(name: &str) -> bool {
        // SAFETY: opening a named mutex just to see that it exists; closed on drop.
        unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, &HSTRING::from(name)) }.map(Owned).is_ok()
    }

    /// An auto-reset named event this process waits on.
    pub fn event(name: &str) -> Option<Owned> {
        // SAFETY: creates (or opens) a named event; the handle is owned.
        unsafe { CreateEventW(None, false, false, &HSTRING::from(name)) }.ok().map(Owned)
    }

    /// Sets a named event another process waits on. `false` when nobody created it.
    pub fn signal(name: &str) -> bool {
        // SAFETY: opens and sets a named event; closed on drop.
        unsafe {
            let Ok(h) = OpenEventW(EVENT_MODIFY_STATE, false, &HSTRING::from(name)) else { return false };
            let h = Owned(h);
            SetEvent(h.raw()).is_ok()
        }
    }

    /// Waits for any of `handles`; `Some(index)` of the one set, `None` on timeout.
    pub fn wait_any(handles: &[&Owned], timeout: Duration) -> Option<usize> {
        let raw: Vec<HANDLE> = handles.iter().map(|h| h.raw()).collect();
        // SAFETY: valid handles for the duration of the wait.
        let r = unsafe { WaitForMultipleObjects(&raw, false, timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32) };
        let i = r.0 as usize;
        (i < raw.len()).then_some(i)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_fixed_messages_are_accepted() {
        for m in [Message::Open(1), Message::Wait(u64::MAX), Message::Shown(42)] {
            assert_eq!(Message::decode(&m.encode()), Some(m));
        }
        assert_eq!(Message::decode(&[9, 0, 0, 0, 0, 0, 0, 0, 0]), None, "an unknown kind");
        assert_eq!(Message::decode(&[1, 2, 3]), None, "too short");
        assert_eq!(Message::decode(&[1; 10]), None, "too long");
        assert_eq!(Message::decode(b"C:\\Windows"), None, "no paths");
    }

    #[test]
    fn names_and_arguments() {
        assert_eq!(pipe_name(3), "\\\\.\\pipe\\octopolis-win-e-3");
        assert!(HELPER_MUTEX.starts_with("Local\\") && QUIT_EVENT.starts_with("Local\\") && REPAIR_EVENT.starts_with("Local\\"), "session namespace");
        assert_eq!(helper_beside(Path::new("C:\\Apps\\Octopolis\\Octopolis.exe")), Path::new("C:\\Apps\\Octopolis\\octopolis-keys.exe"));
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(request_arg(&args(&["::{20D04FE0-3AEA-1069-A2D8-08002B30309D}", "--win-e-request", "17"])), Some(17));
        assert_eq!(request_arg(&args(&["--win-e-request", "x"])), None);
        assert_eq!(request_arg(&args(&["C:\\x"])), None);
    }

    #[test]
    fn the_switch_is_kept_for_the_helper_and_defaults_to_on() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_switch(dir.path()), "never saved: the switch's default");
        write_switch(dir.path(), false).unwrap();
        assert!(!read_switch(dir.path()));
        write_switch(dir.path(), true).unwrap();
        assert!(read_switch(dir.path()));
    }

    #[test]
    fn the_status_file_round_trips() {
        for h in [Health::Off, Health::Checking, Health::Working, Health::NotWorking("the keyboard hook isn't installed".into())] {
            assert_eq!(parse_status(&format_status(&h)), h);
        }
        assert_eq!(parse_status("garbage"), Health::Off);
        assert_eq!(parse_status(&format_status(&Health::NotWorking("a\nb".into()))), Health::NotWorking("a b".into()));
    }

    /// The pipe's access list names only the current user.
    #[cfg(windows)]
    #[test]
    fn the_pipe_is_for_the_current_user_only() {
        let sddl = sys::user_only_sddl().expect("the user's SID");
        assert!(sddl.starts_with("D:P(A;;GA;;;S-1-5-"), "{sddl}");
        assert_eq!(sddl.matches("(A;").count(), 1, "one allow entry, protected from inheritance: {sddl}");
    }

    /// A client coming in over the network is refused; the same pipe opened locally works.
    #[cfg(windows)]
    #[test]
    fn remote_clients_are_rejected() {
        use std::time::Duration;
        let leaf = format!("octopolis-remote-test-{}", std::process::id());
        let local = format!("\\\\.\\pipe\\{leaf}");
        let served = local.clone();
        std::thread::spawn(move || {
            let _ = sys::serve(&served, || true, |conn| {
                let _ = conn.recv(Duration::from_millis(500));
            });
        });
        let mut ok = None;
        for _ in 0..100 {
            ok = sys::connect(&local);
            if ok.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ok.is_some(), "a local client connects");
        drop(ok);
        std::thread::sleep(Duration::from_millis(50));
        // \\localhost\pipe\… goes through the network redirector: Windows treats it as a remote client.
        assert!(sys::connect(&format!("\\\\localhost\\pipe\\{leaf}")).is_none(), "a remote client is refused");
    }

    /// A real pipe in this session: messages both ways, and a closed connection seen as gone.
    #[cfg(windows)]
    #[test]
    fn a_real_pipe_carries_the_messages_and_sees_a_hang_up() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::Duration;
        let name = format!("\\\\.\\pipe\\octopolis-test-{}", std::process::id());
        let running = Arc::new(AtomicBool::new(true));
        let keep = running.clone();
        let served = name.clone();
        std::thread::spawn(move || {
            let _ = sys::serve(&served, move || keep.load(Ordering::SeqCst), |conn| {
                if let Ok(Some(Message::Open(id))) = conn.recv(Duration::from_secs(2)) {
                    conn.send(Message::Shown(id));
                }
                // Then wait for the client to hang up.
                let _ = conn.recv(Duration::from_secs(2));
            });
        });
        let mut conn = None;
        for _ in 0..100 {
            conn = sys::connect(&name);
            if conn.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let conn = conn.expect("connected");
        assert_eq!(conn.server_pid(), Some(std::process::id()));
        assert!(conn.send(Message::Open(5)));
        assert_eq!(conn.recv(Duration::from_secs(2)), Ok(Some(Message::Shown(5))));
        // A second server can't take over a name that is already served.
        assert!(sys::serve(&name, || true, |_| {}).is_err(), "the first instance is reserved");
        drop(conn);
        running.store(false, Ordering::SeqCst);
    }
}
