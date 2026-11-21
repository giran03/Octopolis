//! The before-value record (WE-09): what Octopolis is about to write or has
//! written, and what each value held before, so turning the mode off puts
//! back exactly that. Kept at `%LOCALAPPDATA%\app.octopolis.explorer`.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

pub const VERSION: u32 = 1;
pub const FILE: &str = "explorer-mode.json";
pub const HELP_FILE: &str = "RESTORE-FILE-EXPLORER.txt";
/// The per-user data folder Octopolis already uses (`identifier` in tauri.conf.json).
pub const DIR_NAME: &str = "app.octopolis.explorer";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// The record is written; the values may or may not be.
    Prepared,
    /// Every value is written and was read back.
    Active,
    /// Values are being put back.
    Restoring,
    /// Everything was put back; the record is about to be deleted.
    Restored,
}

/// What a value held before Octopolis wrote it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "lowercase")]
pub enum Previous {
    Absent,
    Value(String),
    /// Written by an older version that kept no record. Restore deletes it.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// Key under `HKEY_CURRENT_USER`.
    pub key: String,
    /// `None` is the key's default value.
    pub name: Option<String>,
    pub previous: Previous,
    /// Exactly what Octopolis wrote. A value is only put back while it still holds this.
    pub wrote: String,
}

impl Entry {
    pub fn is(&self, key: &str, name: Option<&str>) -> bool {
        self.key.eq_ignore_ascii_case(key) && self.name.as_deref().map(str::to_ascii_lowercase) == name.map(str::to_ascii_lowercase)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub version: u32,
    pub phase: Phase,
    /// The Octopolis.exe that wrote this record.
    pub install: String,
    pub nonce: String,
    pub entries: Vec<Entry>,
}

impl Record {
    pub fn new(install: &Path, entries: Vec<Entry>) -> Self {
        Self { version: VERSION, phase: Phase::Prepared, install: install.display().to_string(), nonce: nonce(), entries }
    }

    pub fn entry(&self, key: &str, name: Option<&str>) -> Option<&Entry> {
        self.entries.iter().find(|e| e.is(key, name))
    }

    pub fn is_from(&self, exe: &Path) -> bool {
        self.install.eq_ignore_ascii_case(&exe.display().to_string())
    }
}

/// A random hex string; tells one record apart from the next.
fn nonce() -> String {
    use std::hash::{BuildHasher, Hasher};
    let time = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    (0..2)
        .map(|i: u8| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u128(time);
            h.write_u32(std::process::id());
            h.write_u8(i);
            format!("{:016x}", h.finish())
        })
        .collect()
}

/// Why a record can't be used. The file is kept either way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unusable {
    Unreadable(String),
    OtherInstall(String),
}

impl Unusable {
    pub fn message(&self, store: &Store) -> String {
        let help = store.dir.join(HELP_FILE);
        match self {
            Self::Unreadable(why) => format!(
                "Octopolis's record of the File Explorer settings it changed can't be read ({why}), so nothing was changed. The record was kept at {}. {} lists what to undo by hand",
                store.file().display(),
                help.display()
            ),
            Self::OtherInstall(path) => format!(
                "The File Explorer settings were changed by another copy of Octopolis ({path}), so nothing was changed. Turn the setting off in that copy, or run it with --restore-explorer. {} lists what to undo by hand",
                help.display()
            ),
        }
    }
}

/// Where the record lives.
#[derive(Debug, Clone)]
pub struct Store {
    pub dir: PathBuf,
}

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// `%LOCALAPPDATA%\app.octopolis.explorer`.
    pub fn user() -> Option<Self> {
        Some(Self::new(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join(DIR_NAME)))
    }

    pub fn file(&self) -> PathBuf {
        self.dir.join(FILE)
    }

    /// `Ok(None)` when there is no record.
    pub fn load(&self) -> std::result::Result<Option<Record>, Unusable> {
        let text = match std::fs::read_to_string(self.file()) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Unusable::Unreadable(e.to_string())),
        };
        let record: Record = serde_json::from_str(&text).map_err(|e| Unusable::Unreadable(e.to_string()))?;
        if record.version != VERSION {
            return Err(Unusable::Unreadable(format!("version {} is not one this copy knows", record.version)));
        }
        Ok(Some(record))
    }

    /// Writes the record atomically: a temp file, flushed to disk, then renamed over the old one.
    pub fn save(&self, record: &Record) -> Result<()> {
        std::fs::create_dir_all(&self.dir).map_err(|e| Error::io(&self.dir, e))?;
        let json = serde_json::to_string_pretty(record).map_err(|e| Error::io(self.file(), std::io::Error::other(e)))?;
        // The help file goes first, so it exists whenever a record does (WE-10).
        atomic_write(&self.dir.join(HELP_FILE), help_text(record).as_bytes())?;
        atomic_write(&self.file(), json.as_bytes())
    }

    /// Deletes the record, then its help file.
    pub fn delete(&self) -> Result<()> {
        for path in [self.file(), self.dir.join(HELP_FILE)] {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(Error::io(path, e)),
            }
        }
        Ok(())
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    let write = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        #[cfg(test)]
        if tests::FAIL_BEFORE_RENAME.with(std::cell::Cell::get) && path.file_name().is_some_and(|n| n == FILE) {
            return Err(std::io::Error::other("test: stopped before the rename"));
        }
        std::fs::rename(&tmp, path)
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        Error::io(path, e)
    })
}

/// `RESTORE-FILE-EXPLORER.txt`: how to undo the mode by hand (WE-10).
pub fn help_text(record: &Record) -> String {
    let mut out = String::new();
    out.push_str("Octopolis changed these settings for your Windows account so folders and Win+E open in Octopolis.\r\n\r\n");
    out.push_str(&format!("To undo this without opening a window, run:\r\n  \"{}\" --restore-explorer\r\n\r\n", record.install));
    out.push_str("To undo it by hand, open Registry Editor (regedit) and, under HKEY_CURRENT_USER, change each value below.\r\n");
    out.push_str("Only change a value that still holds what Octopolis set. If it holds anything else, another tool wrote it: leave it as it is.\r\n\r\n");
    for e in &record.entries {
        out.push_str(&format!("HKEY_CURRENT_USER\\{}\r\n", e.key));
        out.push_str(&format!("  Value: {}\r\n", e.name.as_deref().unwrap_or("(Default)")));
        out.push_str(&format!("  Octopolis set it to: \"{}\"\r\n", e.wrote));
        out.push_str(match &e.previous {
            Previous::Absent | Previous::Unknown => "  To undo: delete the value\r\n",
            Previous::Value(_) => "",
        });
        if let Previous::Value(v) = &e.previous {
            out.push_str(&format!("  To undo: set it back to \"{v}\"\r\n"));
        }
        out.push_str("\r\n");
    }
    out.push_str("Then delete these keys if they are empty:\r\n");
    for key in super::owned_keys() {
        out.push_str(&format!("  HKEY_CURRENT_USER\\{}\\{key}\r\n", super::CLASSES));
    }
    out.push_str(&format!("\r\nFinally delete {FILE} and this file from this folder.\r\n"));
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    thread_local! {
        /// Test seam: makes writing the record fail after its temp file is written, before the rename.
        pub(crate) static FAIL_BEFORE_RENAME: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }

    #[test]
    fn the_record_is_never_written_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let mut r = Record::new(Path::new("C:\\o\\Octopolis.exe"), vec![Entry { key: "K".into(), name: None, previous: Previous::Absent, wrote: "a".into() }]);
        store.save(&r).unwrap();
        let old = std::fs::read(store.file()).unwrap();
        r.phase = Phase::Active;
        r.entries[0].wrote = "b".repeat(4096);
        FAIL_BEFORE_RENAME.with(|f| f.set(true));
        let saved = store.save(&r);
        FAIL_BEFORE_RENAME.with(|f| f.set(false));
        assert!(saved.is_err());
        assert_eq!(std::fs::read(store.file()).unwrap(), old, "the old record is intact");
        assert_eq!(store.load().unwrap().unwrap().phase, Phase::Prepared);
        assert!(!dir.path().join("explorer-mode.tmp").exists(), "the temp file is cleaned up");
    }

    #[test]
    fn the_help_file_exists_whenever_the_record_does() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let mut r = Record::new(Path::new("C:\\o\\Octopolis.exe"), vec![Entry { key: "K".into(), name: None, previous: Previous::Unknown, wrote: "a".into() }]);
        r.phase = Phase::Active;
        store.save(&r).unwrap();
        let help = std::fs::read_to_string(dir.path().join(HELP_FILE)).unwrap();
        assert!(help.contains("HKEY_CURRENT_USER\\K") && help.contains("delete the value") && help.contains("leave it"), "{help}");
        store.delete().unwrap();
        assert!(!dir.path().join(HELP_FILE).exists());
    }

    #[test]
    fn round_trips_and_replaces_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        assert_eq!(store.load(), Ok(None));
        let mut r = Record::new(Path::new("C:\\o\\Octopolis.exe"), vec![Entry { key: "K".into(), name: None, previous: Previous::Value("foo".into()), wrote: "bar".into() }]);
        store.save(&r).unwrap();
        assert_eq!(store.load(), Ok(Some(r.clone())));
        assert!(dir.path().join(HELP_FILE).exists(), "the help file is written with the record");
        r.phase = Phase::Active;
        store.save(&r).unwrap();
        assert_eq!(store.load().unwrap().unwrap().phase, Phase::Active);
        assert!(!dir.path().join("explorer-mode.tmp").exists());
        store.delete().unwrap();
        assert_eq!(store.load(), Ok(None));
        assert!(!dir.path().join(HELP_FILE).exists());
    }

    #[test]
    fn a_damaged_record_is_reported_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        std::fs::write(store.file(), "{ not json").unwrap();
        assert!(matches!(store.load(), Err(Unusable::Unreadable(_))));
        assert!(store.file().exists());
    }

    #[test]
    fn nonces_differ() {
        assert_ne!(nonce(), nonce());
        assert_eq!(nonce().len(), 32);
    }
}
