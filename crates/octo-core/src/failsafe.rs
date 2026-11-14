//! Start-up failsafe for "Use Octopolis instead of File Explorer". While that
//! is on, a copy of Octopolis that cannot start would leave folders unopenable.
//! Each start is counted until the window reports it is working; once
//! [`LIMIT`] starts in a row never got that far, the caller gives folders back
//! to File Explorer.

use std::path::Path;

/// Unfinished starts in a row that trip the failsafe.
pub const LIMIT: u32 = 2;
const FILE: &str = "startup-attempts.txt";

pub fn should_trip(unfinished: u32) -> bool {
    unfinished >= LIMIT
}

fn read(dir: &Path) -> u32 {
    std::fs::read_to_string(dir.join(FILE)).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

/// Records that a start has begun. Returns `true` when the last [`LIMIT`]
/// starts never finished; the count is reset so the failsafe trips once.
pub fn begin(dir: &Path) -> bool {
    let unfinished = read(dir);
    let trip = should_trip(unfinished);
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(dir.join(FILE), if trip { "0".to_string() } else { (unfinished + 1).to_string() });
    trip
}

/// The window is up and working: forget earlier unfinished starts.
pub fn finished(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(FILE));
}

/// Whether no other copy of Octopolis is running. Later launches only hand
/// their paths to the first one, so they must not count as starts. The first
/// caller keeps the marker until the process ends.
pub fn is_first_instance() -> bool {
    imp::is_first_instance()
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError};
    use windows::Win32::System::Threading::CreateMutexW;
    use windows::core::w;

    pub fn is_first_instance() -> bool {
        // SAFETY: creates a named marker; the handle is kept open on purpose for the life of the process.
        unsafe {
            match CreateMutexW(None, false, w!("Local\\Octopolis.StartupFailsafe")) {
                Ok(_) => GetLastError() != ERROR_ALREADY_EXISTS,
                Err(_) => false,
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn is_first_instance() -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trips_after_two_unfinished_starts_and_only_once() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!begin(dir.path()), "first start");
        assert!(!begin(dir.path()), "second start after one unfinished");
        assert!(begin(dir.path()), "two unfinished starts in a row");
        assert!(!begin(dir.path()), "the count starts over after tripping");
    }

    #[test]
    fn a_finished_start_clears_the_count() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!begin(dir.path()));
        assert!(!begin(dir.path()));
        finished(dir.path());
        assert!(!begin(dir.path()));
        finished(dir.path());
        finished(dir.path());
    }

    #[test]
    fn a_damaged_count_reads_as_zero() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE), "not a number").unwrap();
        assert!(!begin(dir.path()));
    }
}
