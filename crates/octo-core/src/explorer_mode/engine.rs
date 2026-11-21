//! Ownership (WE-08), the before-value record and safe restore (WE-09), and
//! per-part status (WE-11), written against a small registry interface so the
//! rules can be tested without touching the real registry.

use std::path::{Path, PathBuf};

use super::record::{Entry, Phase, Previous, Record, Store, Unusable};
use super::{CLASSES, DEFAULT_VERB_KEYS, RegValue, VERB, WIN_E_CLSID, exe_in_command, owned_keys, plan};
use crate::error::{Error, Result};

/// What a registry value holds right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Current {
    Absent,
    Text(String),
    /// A value of another type (a number, binary data). Never Octopolis's.
    Other,
}

/// The few registry operations the mode needs. Keys are under `HKEY_CURRENT_USER`.
pub trait Registry {
    fn get(&self, key: &str, name: Option<&str>) -> Current;
    fn set(&mut self, key: &str, name: Option<&str>, value: &str) -> Result<()>;
    /// Deletes a value. Fine when it isn't there.
    fn remove(&mut self, key: &str, name: Option<&str>) -> Result<()>;
    /// Deletes a key that has no values and no subkeys; leaves any other key alone.
    fn remove_key_if_empty(&mut self, key: &str) -> Result<()>;
    /// Tells Explorer associations changed.
    fn notify(&mut self) {}
}

/// Places a test can stop the work, as if the process died there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Point {
    Prepared,
    FirstWrite,
    Written,
    Restoring,
    FirstRestore,
    Restored,
}

pub type Crash<'a> = &'a dyn Fn(Point) -> bool;
pub const NO_CRASH: Crash<'static> = &|_| false;

fn crashed() -> Error {
    Error::Cancelled
}

fn problem(message: impl Into<String>) -> Error {
    Error::Io { path: "File Explorer settings".into(), source: std::io::Error::other(message.into()) }
}

/// Which part of the mode a group of values sets up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Folders(usize),
    WinE,
}

/// Values that are taken over, or left, together. The first is the anchor:
/// a folder default verb or the Win+E command.
#[derive(Debug, Clone)]
struct Group {
    part: Part,
    values: Vec<RegValue>,
}

fn full(key: &str) -> String {
    format!("{CLASSES}\\{key}")
}

fn groups(exe: &Path) -> Vec<Group> {
    let values = plan(exe);
    let mut out: Vec<Group> = DEFAULT_VERB_KEYS.iter().enumerate().map(|(i, _)| Group { part: Part::Folders(i), values: Vec::new() }).collect();
    out.push(Group { part: Part::WinE, values: Vec::new() });
    for v in values {
        let i = DEFAULT_VERB_KEYS.iter().position(|base| v.key == *base || v.key.starts_with(&format!("{base}\\"))).unwrap_or(DEFAULT_VERB_KEYS.len());
        out[i].values.push(v);
    }
    out
}

/// Who a group belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Owner {
    /// Nothing is set; Octopolis may take it.
    Free,
    /// The record lists the anchor with what is there now.
    Ours,
    /// Set by an older Octopolis that kept no record (WE-08 migration).
    Legacy,
    /// Like `Legacy`, but the Octopolis.exe it points at no longer exists.
    /// Taken over only through Repair, after the user confirms.
    Stale(String),
    /// Set by something else: kept by this exe or value.
    Foreign(String),
}

/// The exe a shell command runs: the quoted part, or up to `.exe`, or the first word.
pub fn exe_of(command: &str) -> String {
    if let Some(exe) = exe_in_command(command) {
        return exe.to_string();
    }
    let lower = command.to_ascii_lowercase();
    if let Some(i) = lower.find(".exe") {
        return command[..i + 4].trim().to_string();
    }
    command.split_whitespace().next().unwrap_or(command).to_string()
}

fn is_named_octopolis(path: &str) -> bool {
    Path::new(path).file_name().is_some_and(|n| n.eq_ignore_ascii_case("Octopolis.exe"))
}

/// Windows' own folder default verbs, which Octopolis may replace (WE-08).
pub const REPLACEABLE_VERBS: [&str; 3] = ["open", "explore", "none"];

fn is_replaceable_verb(value: &str) -> bool {
    value.is_empty() || REPLACEABLE_VERBS.iter().any(|v| value.eq_ignore_ascii_case(v))
}

fn text(c: &Current) -> Option<&str> {
    match c {
        Current::Text(s) => Some(s),
        _ => None,
    }
}

/// The command the anchor leads to: the verb's command for a folder default verb, the anchor itself for Win+E.
fn anchor_command<R: Registry>(reg: &R, g: &Group, anchor: &str) -> Option<String> {
    match g.part {
        Part::Folders(i) => text(&reg.get(&full(&format!("{}\\{anchor}\\command", DEFAULT_VERB_KEYS[i])), None)).map(str::to_string),
        Part::WinE => Some(anchor.to_string()),
    }
}

fn classify_anchor<R: Registry>(reg: &R, record: Option<&Record>, g: &Group) -> Owner {
    let anchor = &g.values[0];
    let key = full(&anchor.key);
    let value = match reg.get(&key, anchor.name) {
        Current::Absent => return Owner::Free,
        Current::Text(s) => s,
        Current::Other => return Owner::Foreign(format!("a non-text value in {key}")),
    };
    let listed = record.and_then(|r| r.entry(&key, anchor.name));
    if listed.is_some_and(|e| e.wrote == value) {
        return Owner::Ours;
    }
    // A folder default may be replaced when empty or one of Windows' own verbs;
    // the Win+E command only when absent.
    match g.part {
        Part::Folders(_) if is_replaceable_verb(&value) => return Owner::Free,
        Part::WinE if value.is_empty() => return Owner::Foreign("an empty value".into()),
        _ => {}
    }
    let command = anchor_command(reg, g, &value);
    let looks_ours = match g.part {
        Part::Folders(_) => value.eq_ignore_ascii_case(VERB),
        Part::WinE => true,
    };
    if listed.is_none()
        && looks_ours
        && let Some(exe) = command.as_deref().map(exe_of)
        && is_named_octopolis(&exe)
    {
        return if Path::new(&exe).is_file() { Owner::Legacy } else { Owner::Stale(exe) };
    }
    Owner::Foreign(command.map_or(value, |c| exe_of(&c)))
}

/// Who a group belongs to, checking every value it holds (WE-08). The anchor
/// decides first; then, for a group Octopolis may write, any other value that
/// isn't absent and isn't listed in the record with that exact content belongs
/// to another tool, and so does the whole group. An older Octopolis's entry
/// (legacy or stale, no record) is checked the same way: each other value must
/// be absent or exactly what that older copy writes there, so a value another
/// tool added (a `DelegateExecute`, say) keeps the whole group.
fn classify<R: Registry>(reg: &R, record: Option<&Record>, g: &Group) -> Owner {
    let owner = classify_anchor(reg, record, g);
    let older: Option<Vec<RegValue>> = match owner {
        Owner::Free | Owner::Ours => None,
        Owner::Legacy | Owner::Stale(_) => older_exe(reg, g).map(|exe| plan(Path::new(&exe))),
        Owner::Foreign(_) => return owner,
    };
    if matches!(owner, Owner::Legacy | Owner::Stale(_)) && older.is_none() {
        return Owner::Foreign("an older entry Octopolis can't read".into());
    }
    for v in &g.values[1..] {
        let key = full(&v.key);
        let written_by_older = |s: &str| older.as_ref().is_some_and(|p| p.iter().any(|o| o.key.eq_ignore_ascii_case(&v.key) && o.name == v.name && o.value == s));
        match reg.get(&key, v.name) {
            Current::Absent => {}
            Current::Text(s) if record.and_then(|r| r.entry(&key, v.name)).is_some_and(|e| e.wrote == s) => {}
            Current::Text(s) if written_by_older(&s) || octopolis_writes(&v.key, v.name, &s) => {}
            Current::Text(s) => return Owner::Foreign(foreign_value(&key, v.name, &s)),
            Current::Other => return Owner::Foreign(format!("a non-text value in {key}")),
        }
    }
    owner
}

/// Whether `value` is exactly what an Octopolis version writes at this key and
/// name whatever copy it is for (the verb's display name, the empty
/// `DelegateExecute`). Such a value counts as ours on every path (WE-08).
fn octopolis_writes(key: &str, name: Option<&str>, value: &str) -> bool {
    let (a, b) = (plan(Path::new("A:/a.exe")), plan(Path::new("B:/b.exe")));
    a.iter().zip(&b).any(|(x, y)| x.value == y.value && x.key.eq_ignore_ascii_case(key) && x.name == name && x.value == value)
}

/// The Octopolis.exe an older, record-less entry's command names.
fn older_exe<R: Registry>(reg: &R, g: &Group) -> Option<String> {
    let a = &g.values[0];
    text(&reg.get(&full(&a.key), a.name)).and_then(|v| anchor_command(reg, g, v)).map(|c| exe_of(&c))
}

/// Who wrote a value another tool owns: the exe for a command, else where it is.
fn foreign_value(key: &str, name: Option<&str>, value: &str) -> String {
    if key.to_ascii_lowercase().ends_with("\\command") && name.is_none() && !value.is_empty() {
        return exe_of(value);
    }
    format!("a value another tool wrote ({} in HKEY_CURRENT_USER\\{key})", name.unwrap_or("(Default)"))
}

/// A record from another copy of Octopolis that still exists is that copy's
/// record, and usable (WE-15). One whose copy is gone, or whose commands name
/// a different copy than its install path, is from another install (WE-08).
fn usable(r: &Record, exe: &Path) -> bool {
    let present = r.is_from(exe) || Path::new(&r.install).is_file();
    let matches = r.entries.iter().filter(|e| e.key.to_ascii_lowercase().ends_with("\\command") && e.name.is_none()).all(|e| exe_of(&e.wrote).eq_ignore_ascii_case(&r.install));
    present && matches
}

/// Loads the record, requiring it to come from `exe` or another existing copy.
fn load(store: &Store, exe: &Path) -> Result<Option<Record>> {
    match store.load() {
        Ok(Some(r)) if !usable(&r, exe) => Err(problem(Unusable::OtherInstall(r.install).message(store))),
        Ok(r) => Ok(r),
        Err(u) => Err(problem(u.message(store))),
    }
}

/// The existing Octopolis.exe that record-less entries from an older version point at.
fn legacy_exe<R: Registry>(reg: &R, exe: &Path) -> Option<String> {
    groups(exe).iter().filter(|g| classify(reg, None, g) == Owner::Legacy).find_map(|g| older_exe(reg, g))
}

/// The copy of Octopolis the entries point at (WE-15): the record's copy, else
/// the copy older record-less entries name, else `this` (nothing is set up).
pub fn target<R: Registry>(reg: &R, store: &Store, this: &Path) -> Result<PathBuf> {
    if let Some(r) = load(store, this)? {
        return Ok(PathBuf::from(r.install));
    }
    Ok(legacy_exe(reg, this).map_or_else(|| this.to_path_buf(), PathBuf::from))
}

/// Turning on and Repair, as started from `this` copy: always for the copy the
/// entries point at, never re-pointing them at `this` (WE-15).
pub fn enable_for_target<R: Registry>(reg: &mut R, store: &Store, this: &Path, take_over: bool, crash: Crash) -> Result<EnableReport> {
    let exe = target(reg, store, this)?;
    enable(reg, store, &exe, take_over, crash)
}

/// "Use this copy instead" (WE-15), after the user confirmed: re-points every
/// Octopolis-owned entry at `this` and makes the record this copy's.
pub fn use_this_copy<R: Registry>(reg: &mut R, store: &Store, this: &Path) -> Result<EnableReport> {
    enable(reg, store, this, false, NO_CRASH)
}

/// What turning the mode on did, part by part.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EnableReport {
    /// Parts left alone, with who keeps them.
    pub kept: Vec<(Part, String)>,
    /// Parts left alone because they point at a missing Octopolis.exe (that path).
    pub stale: Vec<(Part, String)>,
    /// Anything put back first from an unfinished earlier turn-off.
    pub recovered: Option<RestoreReport>,
}

/// Turns the mode on for `exe` (also Repair). See WE-08 and WE-09.
/// `take_over` is Repair after the user confirmed taking over entries that point
/// at a missing Octopolis.exe; they are then migrated to `exe`.
pub fn enable<R: Registry>(reg: &mut R, store: &Store, exe: &Path, take_over: bool, crash: Crash) -> Result<EnableReport> {
    let mut report = EnableReport::default();
    let mut record = match load(store, exe)? {
        Some(r) if matches!(r.phase, Phase::Prepared | Phase::Restoring | Phase::Restored) => {
            report.recovered = Some(restore(reg, store, r, crash)?);
            None
        }
        r => r,
    };
    let mut entries: Vec<Entry> = record.as_ref().map(|r| r.entries.clone()).unwrap_or_default();
    let mut to_write: Vec<RegValue> = Vec::new();
    for g in groups(exe) {
        let owner = match classify(reg, record.as_ref(), &g) {
            Owner::Stale(_) if take_over => Owner::Legacy,
            o => o,
        };
        match owner {
            Owner::Foreign(by) => {
                report.kept.push((g.part, by));
                continue;
            }
            Owner::Stale(path) => {
                report.stale.push((g.part, path));
                continue;
            }
            _ => {}
        }
        if g.values.iter().any(|v| reg.get(&full(&v.key), v.name) == Current::Other) {
            report.kept.push((g.part, "a non-text value".into()));
            continue;
        }
        for v in g.values {
            let key = full(&v.key);
            let current = reg.get(&key, v.name);
            let old = entries.iter().position(|e| e.is(&key, v.name));
            let previous = match (old.map(|i| &entries[i]), &current) {
                // Still what we wrote last time: keep the original before-value.
                (Some(e), Current::Text(s)) if *s == e.wrote => e.previous.clone(),
                (_, Current::Text(_)) if owner == Owner::Legacy => Previous::Unknown,
                // Left by an older Octopolis (its display name, say): deleted on turn-off.
                (None, Current::Text(s)) if octopolis_writes(&v.key, v.name, s) => Previous::Unknown,
                (_, Current::Text(s)) => Previous::Value(s.clone()),
                _ => Previous::Absent,
            };
            if let Some(i) = old {
                entries.remove(i);
            }
            entries.push(Entry { key, name: v.name.map(str::to_string), previous, wrote: v.value.clone() });
            to_write.push(v);
        }
    }
    if to_write.is_empty() && entries.is_empty() {
        return Ok(report);
    }
    let mut rec = record.take().unwrap_or_else(|| Record::new(exe, Vec::new()));
    // The record belongs to the copy the entries now point at.
    rec.install = exe.display().to_string();
    rec.entries = entries;
    rec.phase = Phase::Prepared;
    store.save(&rec)?;
    if crash(Point::Prepared) {
        return Err(crashed());
    }
    let written = write_all(reg, &to_write, crash);
    match written {
        Err(e) if matches!(e, Error::Cancelled) => return Err(e),
        Err(e) => {
            let _ = restore(reg, store, rec, NO_CRASH);
            reg.notify();
            return Err(e);
        }
        Ok(()) => {}
    }
    reg.notify();
    if crash(Point::Written) {
        return Err(crashed());
    }
    rec.phase = Phase::Active;
    store.save(&rec)?;
    Ok(report)
}

fn write_all<R: Registry>(reg: &mut R, values: &[RegValue], crash: Crash) -> Result<()> {
    for (i, v) in values.iter().enumerate() {
        reg.set(&full(&v.key), v.name, &v.value)?;
        if i == 0 && crash(Point::FirstWrite) {
            return Err(crashed());
        }
    }
    for v in values {
        if reg.get(&full(&v.key), v.name) != Current::Text(v.value.clone()) {
            return Err(problem(format!("the setting changed after writing ({})", full(&v.key))));
        }
    }
    Ok(())
}

/// A value restore did not put back because something else changed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Left {
    pub key: String,
    pub name: Option<String>,
    /// What it holds now.
    pub now: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RestoreReport {
    pub left: Vec<Left>,
}

impl RestoreReport {
    pub fn is_clean(&self) -> bool {
        self.left.is_empty()
    }
}

/// Puts back every value the record lists, where it still holds what Octopolis wrote.
fn restore<R: Registry>(reg: &mut R, store: &Store, mut rec: Record, crash: Crash) -> Result<RestoreReport> {
    let mut report = RestoreReport::default();
    if rec.phase != Phase::Restored {
        rec.phase = Phase::Restoring;
        store.save(&rec)?;
        if crash(Point::Restoring) {
            return Err(crashed());
        }
        let mut first = true;
        for e in rec.entries.iter().rev() {
            let current = reg.get(&e.key, e.name.as_deref());
            let put_back = match (&current, &e.previous) {
                (Current::Text(s), _) if *s == e.wrote => true,
                (Current::Absent, Previous::Absent | Previous::Unknown) => false,
                (Current::Text(s), Previous::Value(p)) if s == p => false,
                (now, _) => {
                    let now = match now {
                        Current::Text(s) => s.clone(),
                        Current::Absent => "nothing".into(),
                        Current::Other => "a non-text value".into(),
                    };
                    report.left.push(Left { key: e.key.clone(), name: e.name.clone(), now });
                    false
                }
            };
            if !put_back {
                continue;
            }
            match &e.previous {
                Previous::Value(p) => reg.set(&e.key, e.name.as_deref(), p)?,
                Previous::Absent | Previous::Unknown => reg.remove(&e.key, e.name.as_deref())?,
            }
            if first && crash(Point::FirstRestore) {
                return Err(crashed());
            }
            first = false;
        }
        prune(reg, &rec)?;
        reg.notify();
        rec.phase = Phase::Restored;
        store.save(&rec)?;
        if crash(Point::Restored) {
            return Err(crashed());
        }
    }
    store.delete()?;
    Ok(report)
}

/// Removes keys under Octopolis's own keys that are now empty, deepest first.
fn prune<R: Registry>(reg: &mut R, rec: &Record) -> Result<()> {
    prune_keys(reg, rec.entries.iter().map(|e| e.key.as_str()))
}

/// Removes empty keys under Octopolis's own keys, from each of `written` up, deepest first.
fn prune_keys<'a, R: Registry>(reg: &mut R, written: impl Iterator<Item = &'a str>) -> Result<()> {
    let roots: Vec<String> = owned_keys().iter().map(|k| full(k).to_ascii_lowercase()).collect();
    let mut keys: Vec<String> = Vec::new();
    for start in written {
        let mut k = start;
        loop {
            let lower = k.to_ascii_lowercase();
            let inside = roots.iter().any(|r| lower == *r || lower.starts_with(&format!("{r}\\")));
            if !inside {
                break;
            }
            if !keys.iter().any(|x| x.eq_ignore_ascii_case(k)) {
                keys.push(k.to_string());
            }
            match k.rsplit_once('\\') {
                Some((parent, _)) => k = parent,
                None => break,
            }
        }
    }
    keys.sort_by_key(|k| std::cmp::Reverse(k.matches('\\').count()));
    keys.iter().try_for_each(|k| reg.remove_key_if_empty(k))
}

/// A record for values an older Octopolis wrote without one (WE-08 migration).
fn adopt<R: Registry>(reg: &R, exe: &Path) -> Option<Record> {
    let mut entries = Vec::new();
    for g in groups(exe) {
        if classify(reg, None, &g) != Owner::Legacy {
            continue;
        }
        // An older copy may sit elsewhere; its own command text is what it wrote.
        for v in &g.values {
            let key = full(&v.key);
            if let Current::Text(s) = reg.get(&key, v.name) {
                entries.push(Entry { key, name: v.name.map(str::to_string), previous: Previous::Unknown, wrote: s });
            }
        }
    }
    (!entries.is_empty()).then(|| {
        // The record belongs to the copy the older entries point at.
        let owner = legacy_exe(reg, exe).map_or_else(|| exe.to_path_buf(), PathBuf::from);
        let mut r = Record::new(&owner, entries);
        r.phase = Phase::Active;
        r
    })
}

/// Turns the mode off, putting back what was there before (WE-09). The failsafe uses this too.
pub fn disable<R: Registry>(reg: &mut R, store: &Store, exe: &Path, crash: Crash) -> Result<RestoreReport> {
    let rec = match load(store, exe)? {
        Some(r) => r,
        None => match adopt(reg, exe) {
            Some(r) => r,
            None => return Ok(RestoreReport::default()),
        },
    };
    restore(reg, store, rec, crash)
}

/// At start-up: finishes a turn-on or turn-off that was cut short, and writes
/// a record for entries an older version left without one.
pub fn recover<R: Registry>(reg: &mut R, store: &Store, exe: &Path) -> Result<Option<RestoreReport>> {
    match load(store, exe)? {
        Some(r) if r.phase == Phase::Active => Ok(None),
        Some(r) => restore(reg, store, r, NO_CRASH).map(Some),
        None => {
            if let Some(r) = adopt(reg, exe) {
                store.save(&r)?;
            }
            Ok(None)
        }
    }
}

/// `--restore-explorer` (WE-10): 0 when everything was put back, 1 when something was left.
/// Run from a copy the entries don't point at, while that copy still exists,
/// it changes nothing and exits 0, so uninstalling one copy never removes
/// another existing copy's entries.
pub fn restore_cli<R: Registry>(reg: &mut R, store: &Store, exe: &Path) -> (i32, String) {
    if let Ok(owner) = target(reg, store, exe)
        && !owner.as_os_str().eq_ignore_ascii_case(exe.as_os_str())
        && owner.is_file()
    {
        return (0, format!("restore: the File Explorer settings belong to another copy of Octopolis ({}); nothing was changed", owner.display()));
    }
    let restored = match disable(reg, store, exe, NO_CRASH) {
        Ok(r) if r.is_clean() => "restore: File Explorer settings put back".to_string(),
        Ok(r) => {
            let list: Vec<String> = r.left.iter().map(|l| format!("{}\\{} now holds \"{}\"", l.key, l.name.as_deref().unwrap_or("(Default)"), l.now)).collect();
            return (1, format!("restore: left values another tool changed: {}", list.join("; ")));
        }
        Err(e) => return (1, format!("restore: {e}")),
    };
    match remove_stale(reg, exe) {
        Ok(s) if s.kept.is_empty() && s.removed => (0, format!("{restored}; removed entries that pointed at a missing Octopolis")),
        Ok(s) if s.kept.is_empty() => (0, restored),
        Ok(s) => (1, format!("{restored}; left entries that point at a missing Octopolis but hold another tool's value: {}", s.kept.join("; "))),
        Err(e) => (1, format!("{restored}; entries that point at a missing Octopolis: {e}")),
    }
}

/// What [`remove_stale`] did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StaleRemoval {
    pub removed: bool,
    /// Groups left because they hold another tool's value, with who.
    pub kept: Vec<String>,
}

/// The HKCU Run key that starts the Win+E helper at sign-in (WE-01).
pub const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
/// The Run value Octopolis owns.
pub const RUN_VALUE: &str = "OctopolisKeys";

/// What the Run value holds for `helper`.
pub fn helper_command(helper: &Path) -> String {
    format!("\"{}\"", helper.display())
}

/// Whether `value` is a Run command for an `octopolis-keys.exe` (any copy).
fn is_helper_command(value: &str) -> bool {
    Path::new(&exe_of(value)).file_name().is_some_and(|n| n.eq_ignore_ascii_case(super::super::winkey::pipe::HELPER_EXE))
}

/// The helper's Run value (WE-01, WE-08).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelperRun {
    /// Set by Octopolis, recorded.
    Ours,
    /// Another tool's value: left alone.
    Kept(String),
    Absent,
}

/// Registers (`Some(helper)`) or unregisters (`None`) the helper's Run value
/// for the copy `exe`, through the record (WE-08, WE-09): it is replaced only
/// when absent or Octopolis's, recorded before it is written, read back, and
/// on removal put back only while it still holds what Octopolis wrote.
pub fn set_helper<R: Registry>(reg: &mut R, store: &Store, exe: &Path, helper: Option<&Path>) -> Result<HelperRun> {
    let current = reg.get(RUN_KEY, Some(RUN_VALUE));
    let record = load(store, exe)?;
    let listed = record.as_ref().and_then(|r| r.entry(RUN_KEY, Some(RUN_VALUE)).cloned());
    let Some(helper) = helper else {
        let Some(mut rec) = record else {
            // No record: only a value that runs a helper which no longer exists is Octopolis's leftover.
            if let Current::Text(s) = &current
                && is_helper_command(s)
                && !Path::new(&exe_of(s)).exists()
            {
                reg.remove(RUN_KEY, Some(RUN_VALUE))?;
            }
            return Ok(HelperRun::Absent);
        };
        let Some(entry) = listed else { return Ok(HelperRun::Absent) };
        if current == Current::Text(entry.wrote.clone()) {
            match &entry.previous {
                Previous::Value(p) => reg.set(RUN_KEY, Some(RUN_VALUE), p)?,
                Previous::Absent | Previous::Unknown => reg.remove(RUN_KEY, Some(RUN_VALUE))?,
            }
        }
        rec.entries.retain(|e| !e.is(RUN_KEY, Some(RUN_VALUE)));
        if rec.entries.is_empty() {
            store.delete()?;
        } else {
            store.save(&rec)?;
        }
        return Ok(HelperRun::Absent);
    };
    let Some(mut rec) = record else {
        return Err(problem("the Win+E helper is only registered while \"Use Octopolis instead of File Explorer\" is on"));
    };
    let wrote = helper_command(helper);
    let previous = match (&current, &listed) {
        (Current::Absent, Some(e)) => e.previous.clone(),
        (Current::Absent, None) => Previous::Absent,
        (Current::Text(s), Some(e)) if *s == e.wrote => e.previous.clone(),
        // Left by Octopolis without a record (exactly a helper Run command): ours, and deleted on removal.
        (Current::Text(s), None) if is_helper_command(s) && (*s == wrote || !Path::new(&exe_of(s)).exists()) => Previous::Unknown,
        (Current::Text(s), _) => return Ok(HelperRun::Kept(exe_of(s))),
        (Current::Other, _) => return Ok(HelperRun::Kept("a non-text value".into())),
    };
    if current == Current::Text(wrote.clone()) && listed.as_ref().is_some_and(|e| e.wrote == wrote) {
        return Ok(HelperRun::Ours);
    }
    rec.entries.retain(|e| !e.is(RUN_KEY, Some(RUN_VALUE)));
    rec.entries.push(Entry { key: RUN_KEY.into(), name: Some(RUN_VALUE.into()), previous, wrote: wrote.clone() });
    rec.phase = Phase::Prepared;
    store.save(&rec)?;
    reg.set(RUN_KEY, Some(RUN_VALUE), &wrote)?;
    if reg.get(RUN_KEY, Some(RUN_VALUE)) != Current::Text(wrote) {
        let _ = restore(reg, store, rec, NO_CRASH);
        return Err(problem(format!("the setting changed after writing ({RUN_KEY}\\{RUN_VALUE})")));
    }
    rec.phase = Phase::Active;
    store.save(&rec)?;
    Ok(HelperRun::Ours)
}

/// Whether the record lists `helper`'s Run value and it still holds exactly that (WE-01).
pub fn helper_registered<R: Registry>(reg: &R, store: &Store, helper: &Path) -> bool {
    let wrote = helper_command(helper);
    let listed = matches!(store.load(), Ok(Some(r)) if r.entry(RUN_KEY, Some(RUN_VALUE)).is_some_and(|e| e.wrote == wrote));
    listed && reg.get(RUN_KEY, Some(RUN_VALUE)) == Current::Text(wrote)
}

/// `--restore-explorer` (WE-10): removes record-less entries that point at an
/// Octopolis.exe that no longer exists, value by value under the WE-08 rules.
/// A group holding another tool's value is left alone and reported.
pub fn remove_stale<R: Registry>(reg: &mut R, exe: &Path) -> Result<StaleRemoval> {
    let mut out = StaleRemoval::default();
    let mut removed_keys: Vec<String> = Vec::new();
    for g in groups(exe) {
        let Owner::Stale(path) = classify_anchor(reg, None, &g) else { continue };
        match classify(reg, None, &g) {
            Owner::Stale(_) => {
                let older = plan(Path::new(&path));
                for v in &g.values {
                    let key = full(&v.key);
                    let Current::Text(now) = reg.get(&key, v.name) else { continue };
                    let ours = older.iter().any(|o| o.key.eq_ignore_ascii_case(&v.key) && o.name == v.name && o.value == now) || octopolis_writes(&v.key, v.name, &now);
                    if ours {
                        reg.remove(&key, v.name)?;
                        removed_keys.push(key);
                    }
                }
                out.removed = true;
            }
            Owner::Foreign(by) => out.kept.push(by),
            _ => {}
        }
    }
    if out.removed {
        prune_keys(reg, removed_keys.iter().map(String::as_str))?;
        reg.notify();
    }
    Ok(out)
}

/// Folder opens (WE-11).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum FoldersState {
    Ours,
    Kept(String),
    /// An entry with no record points at this missing Octopolis.exe.
    Stale(String),
    #[default]
    Off,
}

/// The Win+E registry entry (WE-11).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum WinEState {
    Ours,
    Other(String),
    /// An entry with no record points at this missing Octopolis.exe.
    Stale(String),
    #[default]
    Absent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    ThisCopy,
    OtherCopy(String),
    Missing(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum RecordState {
    #[default]
    None,
    Active,
    Unfinished,
    /// Unreadable or from another install; the message says what to do.
    Unusable(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Status {
    pub folders: FoldersState,
    pub win_e: WinEState,
    pub target: Option<Target>,
    pub record: RecordState,
    /// The Win+E entry is Octopolis's and names this copy, so this copy, and no
    /// other, runs the Win+E catcher (WE-15).
    pub catches_here: bool,
}

impl Status {
    /// The mode is on in some part.
    pub fn is_on(&self) -> bool {
        self.folders == FoldersState::Ours || self.win_e == WinEState::Ours
    }
}

pub fn status<R: Registry>(reg: &R, store: &Store, exe: &Path) -> Status {
    let (record, record_state) = match store.load() {
        Ok(None) => (None, RecordState::None),
        Ok(Some(r)) if !usable(&r, exe) => {
            let msg = Unusable::OtherInstall(r.install.clone()).message(store);
            (None, RecordState::Unusable(msg))
        }
        Ok(Some(r)) => {
            let state = if r.phase == Phase::Active { RecordState::Active } else { RecordState::Unfinished };
            (Some(r), state)
        }
        Err(u) => (None, RecordState::Unusable(u.message(store))),
    };
    let mut st = Status { record: record_state, ..Status::default() };
    let gs = groups(exe);
    let owners: Vec<Owner> = gs.iter().map(|g| classify(reg, record.as_ref(), g)).collect();
    let ours = |o: &Owner| matches!(o, Owner::Ours | Owner::Legacy);
    for (g, o) in gs.iter().zip(&owners) {
        match (g.part, o) {
            (Part::Folders(_), Owner::Foreign(by)) if st.folders == FoldersState::Off || st.folders == FoldersState::Ours => st.folders = FoldersState::Kept(by.clone()),
            (Part::Folders(_), Owner::Stale(path)) if st.folders == FoldersState::Off => st.folders = FoldersState::Stale(path.clone()),
            (Part::WinE, Owner::Stale(path)) => st.win_e = WinEState::Stale(path.clone()),
            (Part::Folders(0), o) if ours(o) && st.folders == FoldersState::Off => st.folders = FoldersState::Ours,
            (Part::WinE, Owner::Foreign(by)) => st.win_e = WinEState::Other(by.clone()),
            (Part::WinE, o) if ours(o) => st.win_e = WinEState::Ours,
            _ => {}
        }
    }
    // The copy the entries open: the folder verb's command, else the Win+E command.
    let folder_cmd = || text(&reg.get(&full(&format!("{}\\{VERB}\\command", DEFAULT_VERB_KEYS[0])), None)).map(str::to_string);
    let win_e_cmd = || text(&reg.get(&full(&format!("CLSID\\{WIN_E_CLSID}\\shell\\opennewwindow\\command")), None)).map(str::to_string);
    let this = exe.display().to_string();
    st.catches_here = st.win_e == WinEState::Ours && win_e_cmd().is_some_and(|c| exe_of(&c).eq_ignore_ascii_case(&this));
    let command = if st.folders == FoldersState::Ours { folder_cmd() } else { None }.or_else(|| if st.win_e == WinEState::Ours { win_e_cmd() } else { None });
    let named = command.map(|c| exe_of(&c)).or_else(|| match &st.record {
        RecordState::Unusable(_) => store.load().ok().flatten().map(|r| r.install),
        _ => None,
    });
    st.target = named.map(|path| {
        if path.eq_ignore_ascii_case(&exe.display().to_string()) {
            Target::ThisCopy
        } else if Path::new(&path).exists() {
            Target::OtherCopy(path)
        } else {
            Target::Missing(path)
        }
    });
    st
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::PathBuf;

    use super::*;

    /// An in-memory HKCU. Keys are compared case-insensitively, like the real one.
    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    struct Fake {
        values: BTreeMap<(String, String), Current>,
        keys: BTreeSet<String>,
        /// Another program that rewrites this key's default value right after Octopolis writes it.
        tamper: Option<(String, String)>,
    }

    fn norm(key: &str) -> String {
        key.to_ascii_lowercase()
    }

    fn vname(name: Option<&str>) -> String {
        name.unwrap_or("").to_ascii_lowercase()
    }

    impl Fake {
        fn put(&mut self, key: &str, name: Option<&str>, value: &str) {
            self.set(&full(key), name, value).unwrap();
        }
        fn at(&self, key: &str, name: Option<&str>) -> Current {
            self.get(&full(key), name)
        }
    }

    impl Registry for Fake {
        fn get(&self, key: &str, name: Option<&str>) -> Current {
            self.values.get(&(norm(key), vname(name))).cloned().unwrap_or(Current::Absent)
        }
        fn set(&mut self, key: &str, name: Option<&str>, value: &str) -> Result<()> {
            let mut k = key;
            loop {
                self.keys.insert(norm(k));
                match k.rsplit_once('\\') {
                    Some((p, _)) => k = p,
                    None => break,
                }
            }
            self.values.insert((norm(key), vname(name)), Current::Text(value.into()));
            if let Some((k, v)) = self.tamper.clone()
                && name.is_none()
                && norm(&k) == norm(key)
            {
                self.values.insert((norm(key), String::new()), Current::Text(v));
            }
            Ok(())
        }
        fn remove(&mut self, key: &str, name: Option<&str>) -> Result<()> {
            self.values.remove(&(norm(key), vname(name)));
            Ok(())
        }
        fn remove_key_if_empty(&mut self, key: &str) -> Result<()> {
            let k = norm(key);
            let prefix = format!("{k}\\");
            let has_values = self.values.keys().any(|(vk, _)| *vk == k);
            let has_children = self.keys.iter().any(|x| x.starts_with(&prefix));
            if !has_values && !has_children {
                self.keys.remove(&k);
            }
            Ok(())
        }
    }

    /// The registry with the keys Windows itself has (`Software\Classes\...`) but no values.
    fn base() -> Fake {
        let mut f = Fake::default();
        for k in ["Software", "Software\\Classes", "Software\\Classes\\Directory", "Software\\Classes\\Drive"] {
            f.keys.insert(norm(k));
        }
        for k in ["Directory\\shell", "Drive\\shell", "CLSID"] {
            f.keys.insert(norm(&full(k)));
        }
        // The Run key Windows always has.
        let mut k = RUN_KEY;
        loop {
            f.keys.insert(norm(k));
            match k.rsplit_once('\\') {
                Some((p, _)) => k = p,
                None => break,
            }
        }
        f
    }

    fn setup() -> (tempfile::TempDir, Store, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("record"));
        let exe_dir = dir.path().join("app");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let exe = exe_dir.join("Octopolis.exe");
        std::fs::write(&exe, b"").unwrap();
        (dir, store, exe)
    }

    fn win_e_key() -> String {
        format!("CLSID\\{WIN_E_CLSID}\\shell\\opennewwindow\\command")
    }

    #[test]
    fn record_round_trip_on_then_off_puts_everything_back() {
        let (_d, store, exe) = setup();
        let mut reg = base();
        // WE-09 example: the default was `explore`; it comes back exactly.
        reg.put("Directory\\shell", None, "explore");
        reg.put("Drive\\shell", None, "");
        let before = reg.clone();

        let report = enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap();
        assert!(report.kept.is_empty());
        let rec = store.load().unwrap().unwrap();
        assert_eq!(rec.phase, Phase::Active);
        assert_eq!(rec.entry(&full("Drive\\shell"), None).unwrap().previous, Previous::Value(String::new()));
        assert_eq!(rec.entry(&full("Directory\\shell"), None).unwrap().previous, Previous::Value("explore".into()));
        assert_eq!(rec.entry(&full("Directory\\shell\\openinoctopolis"), None).unwrap().previous, Previous::Absent);
        let st = status(&reg, &store, &exe);
        assert_eq!((st.folders.clone(), st.win_e.clone(), st.target.clone(), st.record.clone()), (FoldersState::Ours, WinEState::Ours, Some(Target::ThisCopy), RecordState::Active));

        // Turning on again (Repair) keeps the original before-values.
        enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap();
        assert_eq!(store.load().unwrap().unwrap().entry(&full("Drive\\shell"), None).unwrap().previous, Previous::Value(String::new()));

        let r = disable(&mut reg, &store, &exe, NO_CRASH).unwrap();
        assert!(r.is_clean());
        assert_eq!(reg, before);
        assert_eq!(store.load(), Ok(None), "the record is deleted once restored");
        assert!(!store.dir.join(super::super::record::HELP_FILE).exists());
        assert_eq!(status(&reg, &store, &exe), Status::default());
    }

    #[test]
    fn a_foreign_sub_value_keeps_its_whole_group_on_turn_on_and_repair() {
        let (_d, store, exe) = setup();
        let mut reg = base();
        // Another tool's DelegateExecute under the Win+E entry, and its own command under Octopolis's verb key.
        reg.put(&win_e_key(), Some("DelegateExecute"), "{11111111-2222-3333-4444-555555555555}");
        reg.put("Directory\\shell\\openinoctopolis\\command", None, "\"C:\\Tools\\Other.exe\" \"%1\"");
        // A display name someone else left under the Drive verb key.
        reg.put("Drive\\shell\\openinoctopolis", None, "Old label");
        let before = reg.clone();
        for take_over in [false, true] {
            let report = enable(&mut reg, &store, &exe, take_over, NO_CRASH).unwrap();
            let parts: Vec<Part> = report.kept.iter().map(|(p, _)| *p).collect();
            assert_eq!(parts, vec![Part::Folders(0), Part::Folders(1), Part::WinE], "{report:?}");
            assert_eq!(report.kept[0].1, "C:\\Tools\\Other.exe");
            assert_eq!(reg, before, "nothing in a kept group is written (take_over: {take_over})");
            assert_eq!(store.load(), Ok(None));
        }
        let st = status(&reg, &store, &exe);
        assert_eq!(st.folders, FoldersState::Kept("C:\\Tools\\Other.exe".into()));
        assert!(matches!(st.win_e, WinEState::Other(ref by) if by.contains("DelegateExecute")), "{:?}", st.win_e);
        assert!(!st.is_on());
    }

    #[test]
    fn one_kept_group_does_not_stop_the_others() {
        let (_d, store, exe) = setup();
        let mut reg = base();
        reg.put(&win_e_key(), Some("DelegateExecute"), "{11111111-2222-3333-4444-555555555555}");
        let before = reg.clone();
        let report = enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap();
        assert_eq!(report.kept.len(), 1);
        assert_eq!(reg.at("Directory\\shell", None), Current::Text(VERB.into()));
        assert_eq!(reg.at(&win_e_key(), None), Current::Absent, "the Win+E command isn't written next to a foreign DelegateExecute");
        disable(&mut reg, &store, &exe, NO_CRASH).unwrap();
        assert_eq!(reg, before);
    }

    #[test]
    fn a_folder_default_another_program_owns_is_left_alone_and_reported() {
        let (_d, store, exe) = setup();
        let mut reg = base();
        reg.put("Directory\\shell", None, "foo");
        reg.put("Directory\\shell\\foo\\command", None, "\"C:\\Tools\\Other.exe\" \"%1\"");
        let before = reg.clone();
        let report = enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap();
        assert_eq!(report.kept, vec![(Part::Folders(0), "C:\\Tools\\Other.exe".to_string())]);
        assert_eq!(reg.at("Directory\\shell", None), Current::Text("foo".into()));
        assert_eq!(reg.at("Directory\\shell\\openinoctopolis\\command", None), Current::Absent, "no verb is added under a default someone else owns");
        let st = status(&reg, &store, &exe);
        assert_eq!(st.folders, FoldersState::Kept("C:\\Tools\\Other.exe".into()));
        assert_eq!(st.win_e, WinEState::Ours);
        disable(&mut reg, &store, &exe, NO_CRASH).unwrap();
        assert_eq!(reg, before, "on then off: the default is still foo");
    }

    #[test]
    fn a_win_e_entry_another_tool_wrote_is_kept_even_if_it_mentions_octopolis() {
        let (_d, store, exe) = setup();
        let mut reg = base();
        // Matching "octopolis" in the path is not enough (WE-08).
        reg.put(&win_e_key(), None, "\"C:\\octopolis-fan\\launcher.exe\" \"%1\"");
        let report = enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap();
        assert_eq!(report.kept, vec![(Part::WinE, "C:\\octopolis-fan\\launcher.exe".to_string())]);
        assert_eq!(reg.at(&win_e_key(), None), Current::Text("\"C:\\octopolis-fan\\launcher.exe\" \"%1\"".into()));
        assert_eq!(reg.at(&win_e_key(), Some("DelegateExecute")), Current::Absent);
        assert_eq!(status(&reg, &store, &exe).win_e, WinEState::Other("C:\\octopolis-fan\\launcher.exe".into()));
    }

    #[test]
    fn a_value_changed_by_someone_else_while_on_is_left_and_reported() {
        let (_d, store, exe) = setup();
        let mut reg = base();
        enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap();
        reg.put(&win_e_key(), None, "\"C:\\Other\\x.exe\"");
        let r = disable(&mut reg, &store, &exe, NO_CRASH).unwrap();
        assert_eq!(r.left, vec![Left { key: full(&win_e_key()), name: None, now: "\"C:\\Other\\x.exe\"".into() }]);
        assert_eq!(reg.at(&win_e_key(), None), Current::Text("\"C:\\Other\\x.exe\"".into()));
        assert_eq!(reg.at("Directory\\shell", None), Current::Absent, "everything else is put back");
        assert_eq!(store.load(), Ok(None));
    }

    #[test]
    fn a_crash_at_each_phase_is_finished_by_the_next_start() {
        for point in [Point::Prepared, Point::FirstWrite, Point::Written, Point::Restoring, Point::FirstRestore, Point::Restored] {
            let (_d, store, exe) = setup();
            let mut reg = base();
            reg.put("Directory\\shell", None, "explore");
            let before = reg.clone();
            let crash = move |p: Point| p == point;
            let turning_on = matches!(point, Point::Prepared | Point::FirstWrite | Point::Written);
            if turning_on {
                assert!(enable(&mut reg, &store, &exe, false, &crash).is_err(), "{point:?}");
            } else {
                enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap();
                assert!(disable(&mut reg, &store, &exe, &crash).is_err(), "{point:?}");
            }
            let left = store.load().unwrap().expect("the record survives the crash");
            assert_ne!(left.phase, Phase::Active, "{point:?}");
            assert_ne!(status(&reg, &store, &exe).record, RecordState::Active);
            recover(&mut reg, &store, &exe).unwrap();
            assert_eq!(reg, before, "{point:?}: the next start restores");
            assert_eq!(store.load(), Ok(None), "{point:?}");
        }
    }

    #[test]
    fn restore_cli_finishes_an_unfinished_record_too() {
        let (_d, store, exe) = setup();
        let mut reg = base();
        let before = reg.clone();
        let _ = enable(&mut reg, &store, &exe, false, &|p| p == Point::FirstWrite);
        assert_eq!(restore_cli(&mut reg, &store, &exe).0, 0);
        assert_eq!(reg, before);
    }

    #[test]
    fn a_record_less_older_install_is_adopted_then_removed() {
        let (_d, store, exe) = setup();
        let mut reg = base();
        let before = reg.clone();
        // What an older version wrote, pointing at an Octopolis.exe that exists.
        for v in plan(&exe) {
            reg.put(&v.key, v.name, &v.value);
        }
        assert_eq!(status(&reg, &store, &exe).folders, FoldersState::Ours);
        recover(&mut reg, &store, &exe).unwrap();
        let rec = store.load().unwrap().expect("a record is written");
        assert_eq!(rec.phase, Phase::Active);
        assert!(store.dir.join(super::super::record::HELP_FILE).exists(), "the help file is written with a migrated record");
        assert!(rec.entries.iter().all(|e| e.previous == Previous::Unknown));
        assert_eq!(rec.entries.len(), plan(&exe).len());
        disable(&mut reg, &store, &exe, NO_CRASH).unwrap();
        assert_eq!(reg, before, "values with an unknown before-value are deleted");
    }

    #[test]
    fn a_stale_entry_is_taken_over_only_after_repair_is_confirmed() {
        let (_d, store, exe) = setup();
        let mut reg = base();
        let before = reg.clone();
        let gone = Path::new("C:\\Nowhere\\Octopolis.exe");
        for v in plan(gone) {
            reg.put(&v.key, v.name, &v.value);
        }
        let stale = reg.clone();
        recover(&mut reg, &store, &exe).unwrap();
        assert_eq!(store.load(), Ok(None), "not migrated at start-up");
        let st = status(&reg, &store, &exe);
        assert_eq!(st.folders, FoldersState::Stale("C:\\Nowhere\\Octopolis.exe".into()));
        assert_eq!(st.win_e, WinEState::Stale("C:\\Nowhere\\Octopolis.exe".into()));
        assert!(!st.is_on());

        // Turning on (or Repair without the confirmation) doesn't touch it.
        let report = enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap();
        assert_eq!(report.stale.len(), 3, "{report:?}");
        assert_eq!(reg, stale);
        assert_eq!(store.load(), Ok(None));

        // Repair, confirmed: migrated to this copy.
        enable(&mut reg, &store, &exe, true, NO_CRASH).unwrap();
        for v in plan(&exe) {
            assert_eq!(reg.at(&v.key, v.name), Current::Text(v.value.clone()), "{}", v.key);
        }
        let rec = store.load().unwrap().unwrap();
        assert_eq!(rec.phase, Phase::Active);
        assert!(rec.entries.iter().all(|e| e.previous == Previous::Unknown));
        assert!(store.dir.join(super::super::record::HELP_FILE).exists());
        let st = status(&reg, &store, &exe);
        assert_eq!((st.folders, st.win_e, st.target), (FoldersState::Ours, WinEState::Ours, Some(Target::ThisCopy)));
        disable(&mut reg, &store, &exe, NO_CRASH).unwrap();
        assert_eq!(reg, before, "values with an unknown before-value are deleted");
    }

    #[test]
    fn replaceable_folder_defaults_are_taken_over_and_restored() {
        for previous in [None, Some(""), Some("explore"), Some("Explore"), Some("open"), Some("none")] {
            let (_d, store, exe) = setup();
            let mut reg = base();
            for key in DEFAULT_VERB_KEYS {
                if let Some(p) = previous {
                    reg.put(key, None, p);
                }
            }
            let before = reg.clone();
            let report = enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap();
            assert!(report.kept.is_empty(), "{previous:?}: {report:?}");
            assert_eq!(reg.at("Directory\\shell", None), Current::Text(VERB.into()), "{previous:?}");
            assert_eq!(reg.at("Drive\\shell", None), Current::Text(VERB.into()), "{previous:?}");
            assert_eq!(status(&reg, &store, &exe).folders, FoldersState::Ours, "{previous:?}");
            assert!(disable(&mut reg, &store, &exe, NO_CRASH).unwrap().is_clean());
            assert_eq!(reg, before, "{previous:?}: on then off puts it back");
        }
    }

    #[test]
    fn an_empty_win_e_command_is_not_replaceable() {
        let (_d, store, exe) = setup();
        let mut reg = base();
        reg.put(&win_e_key(), None, "");
        let report = enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap();
        assert_eq!(report.kept, vec![(Part::WinE, "an empty value".to_string())]);
        assert_eq!(reg.at(&win_e_key(), None), Current::Text(String::new()));
    }

    #[test]
    fn a_value_changed_between_write_and_read_back_never_becomes_active() {
        let (_d, store, exe) = setup();
        let mut reg = base();
        reg.put("Directory\\shell", None, "explore");
        let before = reg.clone();
        let other = "\"C:\\Other\\x.exe\" \"%1\"".to_string();
        reg.tamper = Some((full("Directory\\shell\\openinoctopolis\\command"), other.clone()));
        let err = enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap_err().to_string();
        assert!(err.contains("the setting changed after writing"), "{err}");
        assert_eq!(store.load(), Ok(None), "no record is left behind");
        assert!(!store.dir.join(super::super::record::HELP_FILE).exists());
        reg.tamper = None;
        // Everything Octopolis wrote is put back; the other program's value is its own.
        let mut expected = before.clone();
        expected.put("Directory\\shell\\openinoctopolis\\command", None, &other);
        assert_eq!(reg, expected);
    }

    #[test]
    fn an_unreadable_or_foreign_record_stops_and_is_kept() {
        let (_d, store, exe) = setup();
        let mut reg = base();
        std::fs::create_dir_all(&store.dir).unwrap();
        std::fs::write(store.file(), "garbage").unwrap();
        assert!(enable(&mut reg, &store, &exe, false, NO_CRASH).is_err());
        assert!(disable(&mut reg, &store, &exe, NO_CRASH).is_err());
        assert_eq!(restore_cli(&mut reg, &store, &exe).0, 1);
        assert!(store.file().exists());
        assert!(matches!(status(&reg, &store, &exe).record, RecordState::Unusable(_)));
        assert_eq!(reg, base(), "nothing was written");

        let other = Record::new(Path::new("D:\\Elsewhere\\Octopolis.exe"), Vec::new());
        store.save(&other).unwrap();
        let err = enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap_err().to_string();
        assert!(err.contains("another copy"), "{err}");
        assert_eq!(store.load().unwrap(), Some(other));
        assert_eq!(status(&reg, &store, &exe).target, Some(Target::Missing("D:\\Elsewhere\\Octopolis.exe".into())));
    }

    #[test]
    fn restore_cli_exit_codes() {
        let (_d, store, exe) = setup();
        let mut reg = base();
        assert_eq!(restore_cli(&mut reg, &store, &exe).0, 0, "nothing to do");
        enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap();
        assert_eq!(restore_cli(&mut reg, &store, &exe).0, 0, "restored");
        enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap();
        reg.put("Directory\\shell", None, "someoneelse");
        let (code, msg) = restore_cli(&mut reg, &store, &exe);
        assert_eq!(code, 1, "a value was left");
        assert!(msg.contains("someoneelse"), "{msg}");
    }

    /// A second existing copy, as when a development build is open beside the installed one.
    fn second_copy(dir: &tempfile::TempDir) -> PathBuf {
        let d = dir.path().join("dev");
        std::fs::create_dir_all(&d).unwrap();
        let exe = d.join("Octopolis.exe");
        std::fs::write(&exe, b"").unwrap();
        exe
    }

    fn points_at(reg: &Fake, exe: &Path) -> bool {
        plan(exe).iter().all(|v| reg.at(&v.key, v.name) == Current::Text(v.value.clone()))
    }

    #[test]
    fn another_existing_copy_is_information_and_repair_never_re_points() {
        let (d, store, installed) = setup();
        let dev = second_copy(&d);
        let mut reg = base();
        let before = reg.clone();
        enable_for_target(&mut reg, &store, &installed, false, NO_CRASH).unwrap();

        // Seen from the dev build: not a problem, and it doesn't catch Win+E.
        let st = status(&reg, &store, &dev);
        assert_eq!(st.target, Some(Target::OtherCopy(installed.display().to_string())));
        assert_eq!(st.record, RecordState::Active, "the other copy's record is usable, not unusable");
        assert_eq!((st.folders.clone(), st.win_e.clone()), (FoldersState::Ours, WinEState::Ours));
        assert!(!st.catches_here, "only the target copy runs the catcher");
        assert!(status(&reg, &store, &installed).catches_here);

        // Repair (and turning on) from the dev build keeps the entries on the installed copy.
        enable_for_target(&mut reg, &store, &dev, false, NO_CRASH).unwrap();
        enable_for_target(&mut reg, &store, &dev, true, NO_CRASH).unwrap();
        assert!(points_at(&reg, &installed));
        assert!(store.load().unwrap().unwrap().is_from(&installed));

        // Turning off from the dev build is the normal restore.
        assert!(disable(&mut reg, &store, &dev, NO_CRASH).unwrap().is_clean());
        assert_eq!(reg, before);
        assert_eq!(store.load(), Ok(None));
    }

    #[test]
    fn use_this_copy_re_points_every_entry_and_the_record() {
        let (d, store, installed) = setup();
        let dev = second_copy(&d);
        let mut reg = base();
        reg.put("Directory\\shell", None, "explore");
        let before = reg.clone();
        enable_for_target(&mut reg, &store, &installed, false, NO_CRASH).unwrap();

        use_this_copy(&mut reg, &store, &dev).unwrap();
        assert!(points_at(&reg, &dev));
        let rec = store.load().unwrap().unwrap();
        assert_eq!(rec.phase, Phase::Active);
        assert!(rec.is_from(&dev));
        assert_eq!(rec.entry(&full("Directory\\shell"), None).unwrap().previous, Previous::Value("explore".into()), "the before-values are kept");
        let st = status(&reg, &store, &dev);
        assert_eq!(st.target, Some(Target::ThisCopy));
        assert!(st.catches_here);
        assert!(!status(&reg, &store, &installed).catches_here, "the installed copy stops catching");

        disable(&mut reg, &store, &installed, NO_CRASH).unwrap();
        assert_eq!(reg, before);
    }

    #[test]
    fn older_entries_for_another_existing_copy_stay_that_copys() {
        let (d, store, installed) = setup();
        let dev = second_copy(&d);
        let mut reg = base();
        for v in plan(&installed) {
            reg.put(&v.key, v.name, &v.value);
        }
        recover(&mut reg, &store, &dev).unwrap();
        let rec = store.load().unwrap().expect("migrated");
        assert!(rec.is_from(&installed), "the migrated record belongs to the copy the entries name");
        assert!(store.dir.join(super::super::record::HELP_FILE).exists());
        assert_eq!(target(&reg, &store, &dev).unwrap(), PathBuf::from(installed.display().to_string()));
        enable_for_target(&mut reg, &store, &dev, false, NO_CRASH).unwrap();
        assert!(points_at(&reg, &installed));
        assert!(!status(&reg, &store, &dev).catches_here);
    }

    #[test]
    fn restore_cli_from_a_copy_that_is_not_the_target_changes_nothing() {
        let (d, store, installed) = setup();
        let second = second_copy(&d);
        let mut reg = base();
        reg.put("Directory\\shell", None, "explore");
        enable_for_target(&mut reg, &store, &installed, false, NO_CRASH).unwrap();
        let on = reg.clone();
        let record = store.load().unwrap();
        let (code, msg) = restore_cli(&mut reg, &store, &second);
        assert_eq!(code, 0, "{msg}");
        assert!(msg.contains("another copy"), "{msg}");
        assert_eq!(reg, on, "every entry stays");
        assert_eq!(store.load().unwrap(), record, "the record stays");
        // The target itself still restores.
        assert_eq!(restore_cli(&mut reg, &store, &installed).0, 0);
        assert_eq!(reg.at("Directory\\shell", None), Current::Text("explore".into()));
    }

    #[test]
    fn a_record_whose_commands_name_another_copy_is_from_another_install() {
        let (d, store, exe) = setup();
        let other = second_copy(&d);
        let mut reg = base();
        enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap();
        // The record says it is this copy's, but its commands name another copy.
        let mut rec = store.load().unwrap().unwrap();
        for e in &mut rec.entries {
            if e.key.to_ascii_lowercase().ends_with("\\command") {
                e.wrote = e.wrote.replace(&exe.display().to_string(), &other.display().to_string());
            }
        }
        store.save(&rec).unwrap();
        assert!(matches!(status(&reg, &store, &exe).record, RecordState::Unusable(_)));
        assert!(enable(&mut reg, &store, &exe, false, NO_CRASH).is_err());
        assert_eq!(store.load().unwrap(), Some(rec), "the record is kept");
    }

    /// An older Octopolis's entries for `exe` (no record), plus another tool's `DelegateExecute`
    /// under the Win+E entry.
    fn older_entries_with_a_foreign_delegate(exe: &Path) -> Fake {
        let mut reg = base();
        for v in plan(exe) {
            if v.name != Some("DelegateExecute") {
                reg.put(&v.key, v.name, &v.value);
            }
        }
        reg.put(&win_e_key(), Some("DelegateExecute"), FOREIGN_DELEGATE);
        reg
    }

    const FOREIGN_DELEGATE: &str = "{11111111-2222-3333-4444-555555555555}";

    fn win_e_kept(reg: &Fake, store: &Store, exe: &Path, older: &Path) {
        assert_eq!(reg.at(&win_e_key(), Some("DelegateExecute")), Current::Text(FOREIGN_DELEGATE.into()), "another tool's DelegateExecute is never overwritten");
        let win_e = format!("\"{}\" \"{}\"", older.display(), super::super::THIS_PC);
        assert_eq!(reg.at(&win_e_key(), None), Current::Text(win_e), "nothing in the kept Win+E group is written");
        if let Ok(Some(rec)) = store.load() {
            assert!(rec.entries.iter().all(|e| !e.key.to_ascii_lowercase().contains("opennewwindow")), "the Win+E group isn't recorded as ours");
        }
        assert!(matches!(status(reg, store, exe).win_e, WinEState::Other(ref by) if by.contains("DelegateExecute")));
    }

    #[test]
    fn turning_on_over_an_older_entry_keeps_a_group_with_a_foreign_value() {
        let (_d, store, exe) = setup();
        let mut reg = older_entries_with_a_foreign_delegate(&exe);
        let report = enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap();
        assert_eq!(report.kept.iter().map(|(p, _)| *p).collect::<Vec<_>>(), vec![Part::WinE], "{report:?}");
        win_e_kept(&reg, &store, &exe, &exe);
        assert!(points_at_folders(&reg, &exe), "the folder groups are still migrated");
        disable(&mut reg, &store, &exe, NO_CRASH).unwrap();
        assert_eq!(reg.at(&win_e_key(), Some("DelegateExecute")), Current::Text(FOREIGN_DELEGATE.into()), "turning off doesn't delete it");
    }

    #[test]
    fn start_up_migration_keeps_a_group_with_a_foreign_value() {
        let (_d, store, exe) = setup();
        let mut reg = older_entries_with_a_foreign_delegate(&exe);
        recover(&mut reg, &store, &exe).unwrap();
        let rec = store.load().unwrap().expect("the folder groups are migrated");
        assert!(rec.entries.iter().all(|e| !e.key.to_ascii_lowercase().contains("opennewwindow")));
        win_e_kept(&reg, &store, &exe, &exe);
        disable(&mut reg, &store, &exe, NO_CRASH).unwrap();
        assert_eq!(reg.at(&win_e_key(), Some("DelegateExecute")), Current::Text(FOREIGN_DELEGATE.into()));
    }

    #[test]
    fn a_confirmed_repair_take_over_keeps_a_group_with_a_foreign_value() {
        let (_d, store, exe) = setup();
        let gone = Path::new("C:\\Nowhere\\Octopolis.exe");
        let mut reg = older_entries_with_a_foreign_delegate(gone);
        let report = enable(&mut reg, &store, &exe, true, NO_CRASH).unwrap();
        assert_eq!(report.kept.iter().map(|(p, _)| *p).collect::<Vec<_>>(), vec![Part::WinE], "{report:?}");
        win_e_kept(&reg, &store, &exe, gone);
        assert!(points_at_folders(&reg, &exe), "the stale folder groups are taken over");
    }

    #[test]
    fn an_older_entry_with_its_own_values_only_is_still_taken_whole() {
        let (_d, store, exe) = setup();
        let mut reg = base();
        let before = reg.clone();
        for v in plan(&exe) {
            reg.put(&v.key, v.name, &v.value);
        }
        recover(&mut reg, &store, &exe).unwrap();
        assert_eq!(store.load().unwrap().unwrap().entries.len(), plan(&exe).len());
        disable(&mut reg, &store, &exe, NO_CRASH).unwrap();
        assert_eq!(reg, before);
    }

    fn points_at_folders(reg: &Fake, exe: &Path) -> bool {
        plan(exe).iter().filter(|v| !v.key.starts_with("CLSID")).all(|v| reg.at(&v.key, v.name) == Current::Text(v.value.clone()))
    }

    #[test]
    fn an_old_octopolis_display_name_does_not_keep_a_group() {
        let (_d, store, exe) = setup();
        let mut reg = base();
        let before = reg.clone();
        // Left by an older Octopolis under its own verb key, with no record.
        reg.put("Directory\\shell\\openinoctopolis", None, "Open in Octopolis");
        reg.put(&win_e_key(), Some("DelegateExecute"), "");
        let report = enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap();
        assert!(report.kept.is_empty(), "{report:?}");
        assert!(points_at(&reg, &exe));
        disable(&mut reg, &store, &exe, NO_CRASH).unwrap();
        assert_eq!(reg, before, "the leftovers are removed with the rest");
        // Another tool's label still keeps the group.
        reg.put("Directory\\shell\\openinoctopolis", None, "Something else");
        assert_eq!(enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap().kept.len(), 1);
    }

    #[test]
    fn restore_cli_removes_stale_entries_value_by_value() {
        let (_d, store, exe) = setup();
        let mut reg = base();
        let before = reg.clone();
        for v in plan(Path::new("C:\\Nowhere\\Octopolis.exe")) {
            reg.put(&v.key, v.name, &v.value);
        }
        let (code, msg) = restore_cli(&mut reg, &store, &exe);
        assert_eq!(code, 0, "{msg}");
        assert!(msg.contains("missing Octopolis"), "{msg}");
        assert_eq!(reg, before, "every stale value and its empty keys are gone");
    }

    #[test]
    fn restore_cli_leaves_a_stale_group_holding_another_tools_value() {
        let (_d, store, exe) = setup();
        let gone = Path::new("C:\\Nowhere\\Octopolis.exe");
        let mut reg = older_entries_with_a_foreign_delegate(gone);
        let (code, msg) = restore_cli(&mut reg, &store, &exe);
        assert_eq!(code, 1, "{msg}");
        assert!(msg.contains("DelegateExecute"), "{msg}");
        assert_eq!(reg.at(&win_e_key(), Some("DelegateExecute")), Current::Text(FOREIGN_DELEGATE.into()));
        assert!(matches!(reg.at(&win_e_key(), None), Current::Text(_)), "the kept Win+E group is untouched");
        assert_eq!(reg.at("Directory\\shell", None), Current::Absent, "the other stale groups are removed");
    }

    fn helper_of(exe: &Path) -> PathBuf {
        let h = exe.with_file_name("octopolis-keys.exe");
        std::fs::write(&h, b"").unwrap();
        h
    }

    #[test]
    fn the_helper_run_value_goes_through_the_record() {
        let (_d, store, exe) = setup();
        let helper = helper_of(&exe);
        let mut reg = base();
        let before = reg.clone();
        assert!(set_helper(&mut reg, &store, &exe, Some(&helper)).is_err(), "not without the mode");
        enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap();
        assert!(!helper_registered(&reg, &store, &helper));
        assert_eq!(set_helper(&mut reg, &store, &exe, Some(&helper)).unwrap(), HelperRun::Ours);
        assert_eq!(reg.get(RUN_KEY, Some(RUN_VALUE)), Current::Text(helper_command(&helper)));
        assert!(helper_registered(&reg, &store, &helper));
        let rec = store.load().unwrap().unwrap();
        assert_eq!(rec.phase, Phase::Active);
        assert_eq!(rec.entry(RUN_KEY, Some(RUN_VALUE)).unwrap().previous, Previous::Absent);
        assert!(std::fs::read_to_string(store.dir.join(super::super::record::HELP_FILE)).unwrap().contains(RUN_VALUE), "the help file lists it");
        // Again: nothing changes.
        assert_eq!(set_helper(&mut reg, &store, &exe, Some(&helper)).unwrap(), HelperRun::Ours);
        // "Win+E opens Octopolis" off: only the Run value goes.
        assert_eq!(set_helper(&mut reg, &store, &exe, None).unwrap(), HelperRun::Absent);
        assert_eq!(reg.get(RUN_KEY, Some(RUN_VALUE)), Current::Absent);
        assert!(!helper_registered(&reg, &store, &helper), "switched off: the helper may not run");
        assert!(store.load().unwrap().unwrap().entry(RUN_KEY, Some(RUN_VALUE)).is_none());
        assert_eq!(status(&reg, &store, &exe).folders, FoldersState::Ours, "the mode stays on");
        // Back on, then the mode off: the Run value goes with everything else.
        set_helper(&mut reg, &store, &exe, Some(&helper)).unwrap();
        assert!(disable(&mut reg, &store, &exe, NO_CRASH).unwrap().is_clean());
        assert_eq!(reg, before);
    }

    #[test]
    fn another_tools_run_value_is_kept() {
        let (_d, store, exe) = setup();
        let helper = helper_of(&exe);
        let mut reg = base();
        enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap();
        reg.set(RUN_KEY, Some(RUN_VALUE), "\"C:\\Tools\\Other.exe\" /tray").unwrap();
        assert_eq!(set_helper(&mut reg, &store, &exe, Some(&helper)).unwrap(), HelperRun::Kept("C:\\Tools\\Other.exe".into()));
        assert_eq!(reg.get(RUN_KEY, Some(RUN_VALUE)), Current::Text("\"C:\\Tools\\Other.exe\" /tray".into()));
        disable(&mut reg, &store, &exe, NO_CRASH).unwrap();
        assert_eq!(reg.get(RUN_KEY, Some(RUN_VALUE)), Current::Text("\"C:\\Tools\\Other.exe\" /tray".into()), "never removed");
    }

    #[test]
    fn a_run_value_changed_by_someone_else_is_left_on_turn_off() {
        let (_d, store, exe) = setup();
        let helper = helper_of(&exe);
        let mut reg = base();
        enable(&mut reg, &store, &exe, false, NO_CRASH).unwrap();
        set_helper(&mut reg, &store, &exe, Some(&helper)).unwrap();
        reg.set(RUN_KEY, Some(RUN_VALUE), "\"C:\\Tools\\Other.exe\"").unwrap();
        set_helper(&mut reg, &store, &exe, None).unwrap();
        assert_eq!(reg.get(RUN_KEY, Some(RUN_VALUE)), Current::Text("\"C:\\Tools\\Other.exe\"".into()));
    }

    #[test]
    fn a_leftover_run_value_for_a_missing_helper_is_removed() {
        let (_d, store, exe) = setup();
        let mut reg = base();
        reg.set(RUN_KEY, Some(RUN_VALUE), "\"C:\\Gone\\octopolis-keys.exe\"").unwrap();
        set_helper(&mut reg, &store, &exe, None).unwrap();
        assert_eq!(reg.get(RUN_KEY, Some(RUN_VALUE)), Current::Absent);
        // One for a helper that exists, with no record, is not touched without the record.
        let helper = helper_of(&exe);
        reg.set(RUN_KEY, Some(RUN_VALUE), &helper_command(&helper)).unwrap();
        set_helper(&mut reg, &store, &exe, None).unwrap();
        assert_eq!(reg.get(RUN_KEY, Some(RUN_VALUE)), Current::Text(helper_command(&helper)));
    }

    #[test]
    fn exe_of_reads_quoted_and_bare_commands() {
        assert_eq!(exe_of("\"C:\\a b\\x.exe\" \"%1\""), "C:\\a b\\x.exe");
        assert_eq!(exe_of("C:\\Tools\\x.exe /open %1"), "C:\\Tools\\x.exe");
        assert_eq!(exe_of("explorer"), "explorer");
    }
}
