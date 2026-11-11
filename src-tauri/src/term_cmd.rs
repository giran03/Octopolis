//! Embedded terminal: a PowerShell session on a Windows pseudo-console.
//!
//! The prompt emits the working directory as an OSC 9;9 sequence so the file
//! list can follow `cd` in the terminal.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::sync::mpsc::{self, Sender};
use std::sync::atomic::{AtomicU64, Ordering};

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};

const PROMPT: &str = r#"function prompt { $e=[char]27; "$e]9;9;$($PWD.ProviderPath)$e\PS $($PWD.ProviderPath)> " }"#;
const READ_BUFFER: usize = 16 * 1024;

struct Term {
    master: Box<dyn MasterPty + Send>,
    /// Input for the writer thread, so a busy shell never blocks the UI.
    input: Sender<Vec<u8>>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct TermState {
    next: AtomicU64,
    terms: Mutex<HashMap<u64, Term>>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 }
}

/// Builds the shell command: "pwsh", "cmd", or PowerShell for anything else.
fn shell_command(shell: Option<&str>) -> CommandBuilder {
    match shell.map(str::to_ascii_lowercase).as_deref() {
        Some("cmd") => {
            let mut cmd = CommandBuilder::new("cmd.exe");
            // Same OSC 9;9 cwd report as the PowerShell prompt, via PROMPT.
            cmd.env("PROMPT", "$E]9;9;$P$E\\$P$G");
            cmd
        }
        Some("pwsh") => {
            let mut cmd = CommandBuilder::new("pwsh.exe");
            cmd.args(["-NoLogo", "-NoExit", "-Command", PROMPT]);
            cmd
        }
        _ => {
            let mut cmd = CommandBuilder::new("powershell.exe");
            cmd.args(["-NoLogo", "-NoExit", "-Command", PROMPT]);
            cmd
        }
    }
}

#[tauri::command]
pub fn term_start(state: State<'_, TermState>, cwd: String, cols: u16, rows: u16, shell: Option<String>, on_data: Channel<InvokeResponseBody>) -> Result<u64, String> {
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
    let mut cmd = shell_command(shell.as_deref());
    if std::path::Path::new(&cwd).is_dir() {
        cmd.cwd(&cwd);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let (input, queue) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(bytes) = queue.recv() {
            if writer.write_all(&bytes).and_then(|()| writer.flush()).is_err() {
                break;
            }
        }
    });
    std::thread::spawn(move || {
        let mut buf = vec![0u8; READ_BUFFER];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                break;
            }
        }
    });
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    state.terms.lock().map_err(|e| e.to_string())?.insert(id, Term { master: pair.master, input, child });
    Ok(id)
}

#[tauri::command]
pub fn term_write(state: State<'_, TermState>, id: u64, data: String) -> Result<(), String> {
    let terms = state.terms.lock().map_err(|e| e.to_string())?;
    let term = terms.get(&id).ok_or("That terminal has closed")?;
    term.input.send(data.into_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_resize(state: State<'_, TermState>, id: u64, cols: u16, rows: u16) -> Result<(), String> {
    let terms = state.terms.lock().map_err(|e| e.to_string())?;
    let term = terms.get(&id).ok_or("That terminal has closed")?;
    term.master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_close(state: State<'_, TermState>, id: u64) -> Result<(), String> {
    let removed = state.terms.lock().map_err(|e| e.to_string())?.remove(&id);
    if let Some(mut term) = removed {
        // Closing a pseudo-console can take a moment; keep it off the UI thread.
        std::thread::spawn(move || {
            let _ = term.child.kill();
            drop(term);
        });
    }
    Ok(())
}
