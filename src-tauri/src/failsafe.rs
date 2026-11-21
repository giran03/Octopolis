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
    let exe = std::env::current_exe().unwrap_or_default();
    // Finish a turn-on or turn-off that was cut short, before anything reads the state (WE-09).
    match octo_core::explorer_mode::recover(&exe) {
        Ok(Some(r)) => crate::diag::write("info", &format!("restore: finished an unfinished change; {} value(s) another tool changed were left", r.left.len())),
        Ok(None) => {}
        Err(e) => crate::diag::write("warn", &format!("restore: {e}")),
    }
    if !acts_here(&octo_core::explorer_mode::status_for(&exe)) {
        octo_core::failsafe::finished(&dir);
        return;
    }
    COUNTING.store(true, Ordering::Relaxed);
    if !octo_core::failsafe::begin(&dir) {
        return;
    }
    // The same restore path as turning the switch off.
    if let Err(e) = octo_core::explorer_mode::disable(&exe) {
        // Nothing was handed back, so say nothing; the next start tries again.
        crate::diag::write("warn", &format!("failsafe: restore: {e}"));
        return;
    }
    TRIPPED.store(true, Ordering::Relaxed);
    // Win+E goes back to File Explorer now, not when the helper next looks (WE-15).
    crate::system::stop_helper();
    // Whatever was being opened still opens, in File Explorer.
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    for target in crate::launch::launch_targets(&args, &cwd) {
        if let Some(arg) = explorer_arg(&target, std::path::Path::new(&target).is_dir()) {
            let _ = std::process::Command::new(octo_core::shell::explorer_exe()).arg(arg).spawn();
        }
    }
}

/// The failsafe counts starts and turns the mode off only in the copy the
/// entries point at: another copy that keeps failing to start never turns off
/// an existing copy's mode (WE-15).
fn acts_here(s: &octo_core::explorer_mode::Status) -> bool {
    s.is_on() && s.target == Some(octo_core::explorer_mode::Target::ThisCopy)
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

/// Two Win+E fallbacks in a row: counts as one failed start (WE-04).
pub fn win_e_failed_start() {
    if let Some(dir) = dir() {
        octo_core::failsafe::failed_start(&dir);
    }
}

/// Whether this start handed folders back to File Explorer. True once, so the UI says it once.
#[tauri::command]
pub fn explorer_failsafe_tripped() -> bool {
    TRIPPED.swap(false, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use octo_core::explorer_mode::{FoldersState, RecordState, Status, Target, WinEState};

    use super::{acts_here, explorer_arg};

    fn on(target: Option<Target>) -> Status {
        Status { folders: FoldersState::Ours, win_e: WinEState::Ours, target, record: RecordState::Active, catches_here: false }
    }

    /// WE-15/WE-09: the failsafe's turn-off stops the helper at once, right after the restore.
    #[test]
    fn the_failsafe_turn_off_stops_the_helper_at_once() {
        let src = include_str!("failsafe.rs");
        let check = &src[src.find("pub fn check()").unwrap()..src.find("fn acts_here").unwrap()];
        let disable = check.find("explorer_mode::disable(&exe)").expect("turns off through the normal restore");
        let stop = check.find("crate::system::stop_helper()").expect("stops the helper");
        let reopen = check.find("launch_targets").unwrap();
        assert!(disable < stop && stop < reopen, "stopped right after the restore, before anything else");
    }

    #[test]
    fn the_failsafe_acts_only_in_the_target_copy() {
        assert!(acts_here(&on(Some(Target::ThisCopy))));
        assert!(!acts_here(&on(Some(Target::OtherCopy("C:/Program Files/Octopolis/Octopolis.exe".into())))), "a non-target copy does nothing");
        assert!(!acts_here(&on(Some(Target::Missing("D:/gone/Octopolis.exe".into())))));
        assert!(!acts_here(&Status::default()), "nothing to do while off");
    }

    #[test]
    fn files_are_shown_not_opened() {
        assert_eq!(explorer_arg("C:\\x\\setup.exe", false).as_deref(), Some("/select,C:\\x\\setup.exe"));
        assert_eq!(explorer_arg("C:\\x", true).as_deref(), Some("C:\\x"));
        assert_eq!(explorer_arg("shell:Downloads", false).as_deref(), Some("shell:Downloads"));
        assert_eq!(explorer_arg("", false), None);
    }
}
