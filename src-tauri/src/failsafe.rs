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
    let _ = octo_core::explorer_mode::disable();
    TRIPPED.store(true, Ordering::Relaxed);
    // Whatever was being opened still opens, in File Explorer.
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    for target in crate::launch::launch_targets(&args, &cwd) {
        let _ = std::process::Command::new("explorer.exe").arg(target).spawn();
    }
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
