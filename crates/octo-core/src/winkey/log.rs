//! `winkey.log` (WE-13): one line per Win+E stage, with `reason=` and
//! `elapsed_ms=`. Nothing about keys is written beyond "Win+E caught". The
//! file is capped; when full it is renamed to `winkey.old.log` and a new one starts.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub const FILE: &str = "winkey.log";
pub const OLD_FILE: &str = "winkey.old.log";
/// The size at which the log is rotated.
pub const MAX_BYTES: u64 = 256 * 1024;
const MAX_REASON: usize = 200;

/// The stages a line can be about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Install,
    Probe,
    Catch,
    Handoff,
    Shown,
    Fallback,
    Cancel,
    Reinstall,
    Restore,
}

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Install => "install",
            Self::Probe => "probe",
            Self::Catch => "catch",
            Self::Handoff => "handoff",
            Self::Shown => "shown",
            Self::Fallback => "fallback",
            Self::Cancel => "cancel",
            Self::Reinstall => "reinstall",
            Self::Restore => "restore",
        }
    }
}

/// The reason code for a probe that couldn't be run (WE-05).
pub const CANT_TEST_NOW: &str = "cant_test_now";

/// A field value on one line, short, quoted unless it is a single word.
fn field(text: &str) -> String {
    let mut text: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if text.chars().count() > MAX_REASON {
        text = text.chars().take(MAX_REASON).collect::<String>() + "…";
    }
    let text = text.replace('"', "'");
    if !text.is_empty() && !text.contains(' ') { text } else { format!("\"{text}\"") }
}

/// One line, without the time stamp.
pub fn format_line(stage: Stage, reason: &str, elapsed_ms: Option<u128>) -> String {
    format_line_with(stage, reason, None, elapsed_ms)
}

/// One line with an extra `detail=` field.
pub fn format_line_with(stage: Stage, reason: &str, detail: Option<&str>, elapsed_ms: Option<u128>) -> String {
    let elapsed = elapsed_ms.map_or_else(|| "-".to_string(), |ms| ms.to_string());
    let detail = detail.map(|d| format!(" detail={}", field(d))).unwrap_or_default();
    format!("stage={} reason={}{detail} elapsed_ms={elapsed}", stage.as_str(), field(reason))
}

/// A `winkey.log` in a folder.
#[derive(Debug, Clone)]
pub struct Log {
    pub dir: PathBuf,
    pub max_bytes: u64,
}

impl Log {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into(), max_bytes: MAX_BYTES }
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(FILE)
    }

    /// Appends one line, rotating first when the file is full. Errors are ignored:
    /// the log must never stop Win+E.
    pub fn write(&self, stage: Stage, reason: &str, elapsed_ms: Option<u128>) {
        self.write_line(format_line(stage, reason, elapsed_ms));
    }

    fn write_line(&self, line: String) {
        static WRITE: Mutex<()> = Mutex::new(());
        let stamp = jiff::Zoned::now().strftime("%Y-%m-%d %H:%M:%S%.3f").to_string();
        let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
        let _ = std::fs::create_dir_all(&self.dir);
        let path = self.path();
        if std::fs::metadata(&path).is_ok_and(|m| m.len() + line.len() as u64 + 32 > self.max_bytes) {
            let _ = std::fs::rename(&path, self.dir.join(OLD_FILE));
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{stamp} {line}");
        }
    }
}

static LOG: OnceLock<Log> = OnceLock::new();

/// Sets the log folder (Octopolis's log folder). Later calls are ignored.
pub fn init(dir: &Path) {
    let _ = LOG.set(Log::new(dir));
}

/// Writes a line to the log set by [`init`]; does nothing before that.
pub fn write(stage: Stage, reason: &str, elapsed_ms: Option<u128>) {
    if let Some(log) = LOG.get() {
        log.write(stage, reason, elapsed_ms);
    }
}

/// [`write`] with a `detail=` field.
pub fn write_with(stage: Stage, reason: &str, detail: Option<&str>, elapsed_ms: Option<u128>) {
    if let Some(log) = LOG.get() {
        log.write_line(format_line_with(stage, reason, detail, elapsed_ms));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_has_the_stage_reason_and_elapsed_time() {
        assert_eq!(format_line(Stage::Catch, "Win+E caught", None), "stage=catch reason=\"Win+E caught\" elapsed_ms=-");
        assert_eq!(format_line(Stage::Shown, "request 3", Some(87)), "stage=shown reason=\"request 3\" elapsed_ms=87");
        assert_eq!(format_line_with(Stage::Probe, CANT_TEST_NOW, Some("every minute: the app in front runs at a higher integrity level"), None), "stage=probe reason=cant_test_now detail=\"every minute: the app in front runs at a higher integrity level\" elapsed_ms=-");
        let odd = format_line(Stage::Fallback, "a\r\nb \"c\"", Some(3000));
        assert_eq!(odd, "stage=fallback reason=\"a  b 'c'\" elapsed_ms=3000", "one line, no breaking quotes");
        assert!(format_line(Stage::Cancel, &"x".repeat(1000), None).len() < 300);
    }

    #[test]
    fn every_stage_has_its_name() {
        let names: Vec<&str> = [Stage::Install, Stage::Probe, Stage::Catch, Stage::Handoff, Stage::Shown, Stage::Fallback, Stage::Cancel, Stage::Reinstall, Stage::Restore].iter().map(|s| s.as_str()).collect();
        assert_eq!(names, ["install", "probe", "catch", "handoff", "shown", "fallback", "cancel", "reinstall", "restore"]);
    }

    #[test]
    fn the_log_is_capped_and_rotated() {
        let dir = tempfile::tempdir().unwrap();
        let log = Log { dir: dir.path().into(), max_bytes: 400 };
        for i in 0..40 {
            log.write(Stage::Handoff, &format!("request {i}"), Some(i));
        }
        let now = std::fs::metadata(log.path()).unwrap().len();
        let old = std::fs::metadata(dir.path().join(OLD_FILE)).unwrap().len();
        assert!(now <= 400 && old <= 400, "{now} {old}");
        let text = std::fs::read_to_string(log.path()).unwrap();
        assert!(text.trim_end().ends_with("stage=handoff reason=\"request 39\" elapsed_ms=39"), "{text}");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2, "only the log and one old log");
    }
}
