//! Local diagnostics log: startup timings, panics and uncaught UI errors, so
//! bug reports are actionable. File and folder paths are replaced with
//! `<path>`, and the log never leaves this PC.

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

const FILE: &str = "octopolis.log";
const OLD_FILE: &str = "octopolis.old.log";
/// The log is rotated once it reaches this size; one old file is kept.
const MAX_BYTES: u64 = 1024 * 1024;
const MAX_LINE: usize = 2000;

static DIR: OnceLock<PathBuf> = OnceLock::new();
static START: OnceLock<Instant> = OnceLock::new();
static WRITE: Mutex<()> = Mutex::new(());

/// Call first thing in `run()`, so startup times count from process start.
pub fn mark_start() {
    START.get_or_init(Instant::now);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write("panic", &info.to_string());
        previous(info);
    }));
}

pub fn init(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = DIR.set(dir);
    }
    write("info", &format!("Octopolis {} started", app.package_info().version));
}

fn ms_since_start() -> u128 {
    START.get().map_or(0, |s| s.elapsed().as_millis())
}

/// Replaces anything that looks like a Windows path (`C:\…`, `\\server\…`)
/// with `<path>`. A path ends at a quote, bracket, line break or ": ".
pub fn scrub(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let starts_path = |i: usize| {
        (i + 2 < b.len() && b[i].is_ascii_alphabetic() && b[i + 1] == b':' && (b[i + 2] == b'\\' || b[i + 2] == b'/') && (i == 0 || !b[i - 1].is_ascii_alphanumeric()))
            || (i + 2 < b.len() && b[i] == b'\\' && b[i + 1] == b'\\' && b[i + 2] != b'\\')
    };
    while i < b.len() {
        if starts_path(i) {
            out.push_str("<path>");
            i += 2;
            while i < b.len() {
                let c = b[i];
                if matches!(c, b'"' | b'\'' | b'\n' | b'\r' | b'\t' | b'<' | b'>' | b'|' | b'(' | b')' | b'`') || (c == b':' && b.get(i + 1) == Some(&b' ')) {
                    break;
                }
                i += 1;
            }
        } else {
            let ch = text[i..].chars().next().unwrap_or(' ');
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// Appends one line to the log. Never fails loudly.
pub fn write(level: &str, message: &str) {
    let Some(dir) = DIR.get() else { return };
    let mut line = scrub(message).replace(['\r', '\n'], " ");
    if line.len() > MAX_LINE {
        let cut = (0..=MAX_LINE).rev().find(|&i| line.is_char_boundary(i)).unwrap_or(0);
        line.truncate(cut);
        line.push('…');
    }
    let stamp = jiff::Zoned::now().strftime("%Y-%m-%d %H:%M:%S%.3f").to_string();
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let path = dir.join(FILE);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(&path, dir.join(OLD_FILE));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{stamp} {level:<5} {line}");
    }
}

/// A line from the UI (uncaught errors and similar).
#[tauri::command]
pub fn diag_log(level: String, message: String) {
    let level = if matches!(level.as_str(), "info" | "warn" | "error") { level } else { "info".into() };
    write(&level, &message);
}

/// Records how long after process start a startup stage was reached.
/// `page_ms` is the webview's own clock (time since the page began loading).
#[tauri::command]
pub fn startup_mark(stage: String, page_ms: f64) -> u128 {
    static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let ms = ms_since_start();
    let stage: String = stage.chars().filter(|c| c.is_alphanumeric() || *c == ' ').take(40).collect();
    // Once per stage per run: reloads of the page don't log it again.
    let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
    if !seen.contains(&stage) {
        write("info", &format!("startup: {stage} at {ms} ms ({page_ms:.0} ms after page load began)"));
        seen.push(stage);
    }
    ms
}

/// Opens the folder holding the log in File Explorer.
#[tauri::command]
pub async fn open_log_folder() -> Result<(), String> {
    let dir = DIR.get().cloned().ok_or("The log folder isn't available")?;
    crate::off_main(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        octo_core::shell::open_path(&dir).map_err(|e| e.to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::scrub;

    #[test]
    fn hides_paths_but_keeps_the_message() {
        assert_eq!(scrub(r"couldn't copy C:\Users\ann\My Files\a.txt: access denied"), "couldn't copy <path>: access denied");
        assert_eq!(scrub(r#"open "\\nas\share\x" failed"#), r#"open "<path>" failed"#);
        assert_eq!(scrub("at App (http://localhost:1420/src/App.tsx:12:3)"), "at App (http://localhost:1420/src/App.tsx:12:3)");
        assert_eq!(scrub("ratio 16:9 and C:/tmp/x"), "ratio 16:9 and <path>");
        assert_eq!(scrub("naïve ünïcode"), "naïve ünïcode");
    }
}
