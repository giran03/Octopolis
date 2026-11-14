//! Gives folders back to File Explorer when Octopolis is the default file
//! manager but failed to start twice in a row. See `octo_core::failsafe`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

/// Matches `identifier` in tauri.conf.json; the folder is removed with the app's data on uninstall.
const APP_ID: &str = "app.octopolis.explorer";

static TRIPPED: AtomicBool = AtomicBool::new(false);
static COUNTING: AtomicBool = AtomicBool::new(false);

fn dir() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join(APP_ID))
}

/// Call at the very start of `run()`, before anything that could fail.
pub fn check() {
    let Some(dir) = dir() else { return };
    if !octo_core::failsafe::is_first_instance() {
        return;
    }
    let status = octo_core::explorer_mode::status();
    if !(status.folders || status.win_e) {
        octo_core::failsafe::finished(&dir);
        return;
    }
    COUNTING.store(true, Ordering::Relaxed);
    if !octo_core::failsafe::begin(&dir) {
        return;
    }
    if octo_core::explorer_mode::disable().is_err() {
        // Nothing was handed back, so say nothing; the next start tries again.
        return;
    }
    TRIPPED.store(true, Ordering::Relaxed);
    // Whatever was being opened still opens, in File Explorer.
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    for target in crate::launch::launch_targets(&args, &cwd) {
        if let Some(arg) = explorer_arg(&target, std::path::Path::new(&target).is_dir()) {
            let _ = std::process::Command::new(octo_core::shell::explorer_exe()).arg(arg).spawn();
        }
    }
}

/// What to pass File Explorer so it shows `target`. A file is shown selected in its
/// folder, never opened: handing File Explorer a file path would run it.
fn explorer_arg(target: &str, is_dir: bool) -> Option<String> {
    let lower = target.to_ascii_lowercase();
    if lower.starts_with("shell:") || target.starts_with("::{") {
        return Some(target.to_string());
    }
    if target.is_empty() {
        return None;
    }
    Some(if is_dir { target.to_string() } else { format!("/select,{target}") })
}

/// The window is running: this start counts as a good one.
pub fn started() {
    if COUNTING.swap(false, Ordering::Relaxed)
        && let Some(dir) = dir()
    {
        octo_core::failsafe::finished(&dir);
    }
}

/// Whether this start handed folders back to File Explorer. True once, so the UI says it once.
#[tauri::command]
pub fn explorer_failsafe_tripped() -> bool {
    TRIPPED.swap(false, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::explorer_arg;

    #[test]
    fn files_are_shown_not_opened() {
        assert_eq!(explorer_arg("C:\\x\\setup.exe", false).as_deref(), Some("/select,C:\\x\\setup.exe"));
        assert_eq!(explorer_arg("C:\\x", true).as_deref(), Some("C:\\x"));
        assert_eq!(explorer_arg("shell:Downloads", false).as_deref(), Some("shell:Downloads"));
        assert_eq!(explorer_arg("", false), None);
    }
}
