//! "Use Octopolis instead of File Explorer": per-user (HKCU) registry entries
//! that send folder opens and Win+E to Octopolis. No admin rights needed.
//! Before writing, Octopolis records what each value held and leaves values
//! another tool owns alone; turning it off puts back exactly what was there
//! (see `engine` and `record`).

use std::path::Path;

use crate::error::{Error, Result};

mod engine;
pub mod record;

pub use engine::{HelperRun, RUN_KEY, RUN_VALUE, helper_command, EnableReport, FoldersState, Left, Part, RecordState, RestoreReport, Status, Target, WinEState};

/// Where every key below lives, under `HKEY_CURRENT_USER`.
pub const CLASSES: &str = "Software\\Classes";

/// Verb name under `Directory\shell` and `Drive\shell`.
pub const VERB: &str = "openinoctopolis";
/// The "File Explorer" object whose `opennewwindow` command Win+E runs.
pub const WIN_E_CLSID: &str = "{52205fd8-5dfb-447d-801a-d0b52f2e83e1}";
/// "This PC", passed so Octopolis opens its start folder for Win+E.
pub const THIS_PC: &str = "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}";

/// One registry value under `HKCU\Software\Classes`. `name: None` is the key's default value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegValue {
    pub key: String,
    pub name: Option<&'static str>,
    pub value: String,
}

/// Keys (under `HKCU\Software\Classes`) that belong entirely to Octopolis.
pub fn owned_keys() -> Vec<String> {
    vec![format!("Directory\\shell\\{VERB}"), format!("Drive\\shell\\{VERB}"), format!("CLSID\\{WIN_E_CLSID}")]
}

/// The shell keys whose default value names the default verb.
pub const DEFAULT_VERB_KEYS: [&str; 2] = ["Directory\\shell", "Drive\\shell"];

fn command_for(exe: &Path, arg: &str) -> String {
    format!("\"{}\" \"{arg}\"", exe.display())
}

/// Every value to write so folders and Win+E open in `exe`.
pub fn plan(exe: &Path) -> Vec<RegValue> {
    let mut out = Vec::new();
    for base in DEFAULT_VERB_KEYS {
        out.push(RegValue { key: base.into(), name: None, value: VERB.into() });
        out.push(RegValue { key: format!("{base}\\{VERB}"), name: None, value: "Open in Octopolis".into() });
        out.push(RegValue { key: format!("{base}\\{VERB}\\command"), name: None, value: command_for(exe, "%1") });
    }
    let win_e = format!("CLSID\\{WIN_E_CLSID}\\shell\\opennewwindow\\command");
    out.push(RegValue { key: win_e.clone(), name: None, value: command_for(exe, THIS_PC) });
    // An empty DelegateExecute makes Windows run the command instead of Explorer's handler.
    out.push(RegValue { key: win_e, name: Some("DelegateExecute"), value: String::new() });
    out
}

fn store() -> Result<record::Store> {
    record::Store::user().ok_or_else(|| Error::io(Path::new("%LOCALAPPDATA%"), std::io::Error::other("LOCALAPPDATA is not set")))
}

/// What is set up right now, part by part, as seen from this copy.
pub fn status() -> Status {
    status_for(&std::env::current_exe().unwrap_or_default())
}

pub fn status_for(exe: &Path) -> Status {
    store().map(|s| engine::status(&imp::Reg, &s, exe)).unwrap_or_default()
}

/// Verb for the opt-in "Open in Octopolis" menu entry, kept apart from [`VERB`]
/// so it doesn't change what opening a folder does.
pub const MENU_VERB: &str = "octopolis.open";
/// Keys (under `HKCU\Software\Classes`) the menu entry owns.
pub fn menu_keys() -> Vec<String> {
    ["Directory\\shell", "Drive\\shell", "Directory\\Background\\shell"].iter().map(|b| format!("{b}\\{MENU_VERB}")).collect()
}

/// Values for the "Open in Octopolis" right-click entry on folders, drives and
/// folder backgrounds. Explorer stays the default.
pub fn menu_plan(exe: &Path) -> Vec<RegValue> {
    let mut out = Vec::new();
    for (key, arg) in menu_keys().into_iter().zip(["%1", "%1", "%V"]) {
        out.push(RegValue { key: key.clone(), name: None, value: "Open in Octopolis".into() });
        out.push(RegValue { key: key.clone(), name: Some("Icon"), value: format!("\"{}\",0", exe.display()) });
        out.push(RegValue { key: format!("{key}\\command"), name: None, value: command_for(exe, arg) });
    }
    out
}

/// The exe the menu entry points at, if it is set up.
pub fn menu_status() -> Option<String> {
    imp::menu_target()
}

/// Adds (or re-points) the right-click entry.
pub fn enable_menu(exe: &Path) -> Result<()> {
    imp::enable_menu(exe)
}

/// Removes the right-click entry. Safe to call when it isn't there.
pub fn disable_menu() -> Result<()> {
    imp::disable_menu()
}

/// Records the before-values, then writes every entry for `exe` that no other
/// tool owns. Also Repair. Finishes an unfinished turn-off first.
/// `exe` is the running copy; when the entries point at another copy that
/// exists, they are set up for that copy, never re-pointed (WE-15).
pub fn enable(exe: &Path) -> Result<EnableReport> {
    engine::enable_for_target(&mut imp::Reg, &store()?, exe, false, engine::NO_CRASH)
}

/// Repair: [`enable`] again, for the copy the entries point at. With
/// `take_over` (the user confirmed it), entries with no record that point at a
/// missing Octopolis.exe are migrated to `exe`.
pub fn repair(exe: &Path, take_over: bool) -> Result<EnableReport> {
    engine::enable_for_target(&mut imp::Reg, &store()?, exe, take_over, engine::NO_CRASH)
}

/// Registers (`Some`) or unregisters (`None`) the Win+E helper's Run value, through the record (WE-01).
pub fn set_helper(exe: &Path, helper: Option<&Path>) -> Result<HelperRun> {
    engine::set_helper(&mut imp::Reg, &store()?, exe, helper)
}

/// Whether the record lists this helper's Run value and it still holds it (WE-01).
pub fn helper_registered(helper: &Path) -> bool {
    store().is_ok_and(|s| engine::helper_registered(&imp::Reg, &s, helper))
}

/// "Use this copy instead", once the user confirmed: points every
/// Octopolis-owned entry, and the record, at `exe` (WE-15).
pub fn use_this_copy(exe: &Path) -> Result<EnableReport> {
    engine::use_this_copy(&mut imp::Reg, &store()?, exe)
}

/// Puts back what each value held before, where it still holds what Octopolis
/// wrote. Safe to call when nothing is set. The failsafe uses this too.
pub fn disable(exe: &Path) -> Result<RestoreReport> {
    engine::disable(&mut imp::Reg, &store()?, exe, engine::NO_CRASH)
}

/// At start-up: finishes a turn-on or turn-off that was cut short. `Some`
/// when something was restored.
pub fn recover(exe: &Path) -> Result<Option<RestoreReport>> {
    engine::recover(&mut imp::Reg, &store()?, exe)
}

/// `--restore-explorer`: exit code (0 restored, 1 something left) and a line for the log.
pub fn restore_cli(exe: &Path) -> (i32, String) {
    match store() {
        Ok(s) => engine::restore_cli(&mut imp::Reg, &s, exe),
        Err(e) => (1, format!("restore: {e}")),
    }
}

/// Whether the "Open in Octopolis" menu entry opens another copy that still
/// exists; `--restore-explorer` then leaves it alone (WE-10).
pub fn menu_belongs_elsewhere(menu: Option<&str>, this: &Path) -> bool {
    menu.is_some_and(|m| !Path::new(m).as_os_str().eq_ignore_ascii_case(this.as_os_str()) && Path::new(m).is_file())
}

/// The exe path inside a command written by [`plan`].
pub fn exe_in_command(command: &str) -> Option<&str> {
    command.strip_prefix('"')?.split('"').next()
}

#[cfg(windows)]
mod imp {
    use std::path::Path;

    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, WIN32_ERROR};
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ, REG_VALUE_TYPE, RRF_RT_ANY, RRF_RT_REG_SZ, RegCloseKey,
        RegCreateKeyExW, RegDeleteKeyW, RegDeleteTreeW, RegDeleteValueW, RegGetValueW, RegOpenKeyExW, RegQueryInfoKeyW, RegSetValueExW,
    };
    use windows::Win32::UI::Shell::{SHCNE_ASSOCCHANGED, SHCNF_IDLIST, SHChangeNotify};
    use windows::core::PCWSTR;

    use super::engine::{Current, Registry};
    use super::{CLASSES, exe_in_command, menu_keys, menu_plan};
    use crate::error::{Error, Result};

    /// The real `HKEY_CURRENT_USER`. Keys given to it are full paths under HKCU.
    pub struct Reg;

    impl Registry for Reg {
        fn get(&self, key: &str, name: Option<&str>) -> Current {
            get_any(key, name)
        }
        fn set(&mut self, key: &str, name: Option<&str>, value: &str) -> Result<()> {
            write_full(key, name, value)
        }
        fn remove(&mut self, key: &str, name: Option<&str>) -> Result<()> {
            remove_value(key, name)
        }
        fn remove_key_if_empty(&mut self, key: &str) -> Result<()> {
            remove_if_empty(key)
        }
        fn notify(&mut self) {
            notify();
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn name_ptr(name: Option<&Vec<u16>>) -> PCWSTR {
        name.map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr()))
    }

    fn fail(what: &str, code: WIN32_ERROR) -> Error {
        Error::io(Path::new("registry"), std::io::Error::other(format!("{what} (error {})", code.0)))
    }

    /// Reads any value, telling text apart from values of other types.
    fn get_any(key: &str, name: Option<&str>) -> Current {
        let path = wide(key);
        let name_w = name.map(wide);
        let mut kind = REG_VALUE_TYPE::default();
        let mut bytes = 0u32;
        // SAFETY: asks for the type and size only; the pointers are valid for the call.
        let code = unsafe { RegGetValueW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr()), name_ptr(name_w.as_ref()), RRF_RT_ANY, Some(&mut kind), None, Some(&mut bytes)) };
        if code.is_err() && code != ERROR_MORE_DATA {
            return Current::Absent;
        }
        if kind != REG_SZ {
            return Current::Other;
        }
        let mut buf = vec![0u16; (bytes as usize).div_ceil(2) + 1];
        let mut size = (buf.len() * 2) as u32;
        // SAFETY: the buffer is valid for `size` bytes.
        let code = unsafe {
            RegGetValueW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr()), name_ptr(name_w.as_ref()), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut size))
        };
        if code.is_err() {
            return Current::Other;
        }
        buf.truncate((size as usize / 2).saturating_sub(1));
        Current::Text(String::from_utf16_lossy(&buf))
    }

    fn read(key: &str, name: Option<&str>) -> Option<String> {
        match get_any(&format!("{CLASSES}\\{key}"), name) {
            Current::Text(s) => Some(s),
            _ => None,
        }
    }

    fn write_full(key: &str, name: Option<&str>, value: &str) -> Result<()> {
        let path = wide(key);
        let mut hkey = HKEY::default();
        // SAFETY: `path` is NUL-terminated; `hkey` is closed below.
        let code = unsafe { RegCreateKeyExW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr()), None, None, REG_OPTION_NON_VOLATILE, KEY_WRITE, None, &mut hkey, None) };
        if code.is_err() {
            return Err(fail("a registry key could not be created", code));
        }
        let data = wide(value);
        let name_w = name.map(wide);
        // SAFETY: `data` is NUL-terminated UTF-16; viewing it as bytes is sound. The key is closed.
        let code = unsafe {
            let bytes = std::slice::from_raw_parts(data.as_ptr().cast::<u8>(), data.len() * 2);
            let c = RegSetValueExW(hkey, name_ptr(name_w.as_ref()), None, REG_SZ, Some(bytes));
            let _ = RegCloseKey(hkey);
            c
        };
        if code.is_err() { Err(fail("a registry value could not be written", code)) } else { Ok(()) }
    }

    fn write(key: &str, name: Option<&str>, value: &str) -> Result<()> {
        write_full(&format!("{CLASSES}\\{key}"), name, value)
    }

    fn remove_value(key: &str, name: Option<&str>) -> Result<()> {
        let path = wide(key);
        let name_w = name.map(wide);
        let mut hkey = HKEY::default();
        // SAFETY: plain registry calls on NUL-terminated strings; the handle is closed.
        unsafe {
            let code = RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr()), None, KEY_SET_VALUE, &mut hkey);
            if code == ERROR_FILE_NOT_FOUND {
                return Ok(());
            }
            if code.is_err() {
                return Err(fail("a registry key could not be opened", code));
            }
            let code = RegDeleteValueW(hkey, name_ptr(name_w.as_ref()));
            let _ = RegCloseKey(hkey);
            if code.is_err() && code != ERROR_FILE_NOT_FOUND {
                return Err(fail("a registry value could not be removed", code));
            }
        }
        Ok(())
    }

    fn remove_if_empty(key: &str) -> Result<()> {
        let path = wide(key);
        let mut hkey = HKEY::default();
        let (mut subkeys, mut values) = (0u32, 0u32);
        // SAFETY: plain registry calls on NUL-terminated strings; the handle is closed.
        unsafe {
            if RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr()), None, KEY_READ, &mut hkey).is_err() {
                return Ok(());
            }
            let code = RegQueryInfoKeyW(hkey, None, None, None, Some(&mut subkeys), None, None, Some(&mut values), None, None, None, None);
            let _ = RegCloseKey(hkey);
            if code.is_err() || subkeys > 0 || values > 0 {
                return Ok(());
            }
            let code = RegDeleteKeyW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr()));
            if code.is_err() && code != ERROR_FILE_NOT_FOUND {
                return Err(fail("a registry key could not be removed", code));
            }
        }
        Ok(())
    }

    fn delete_tree(key: &str) -> Result<()> {
        let path = wide(&format!("{CLASSES}\\{key}"));
        // SAFETY: `path` is NUL-terminated. With a null subkey this deletes the key and everything in it.
        let code = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr())) };
        if code.is_err() && code != ERROR_FILE_NOT_FOUND {
            return Err(fail("a registry key could not be removed", code));
        }
        // RegDeleteTreeW empties the key but leaves it; remove the now-empty key itself.
        remove_if_empty(&format!("{CLASSES}\\{key}"))
    }

    fn notify() {
        // SAFETY: plain notification with no items.
        unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
    }

    pub fn menu_target() -> Option<String> {
        let key = menu_keys().into_iter().next()?;
        read(&format!("{key}\\command"), None).as_deref().and_then(exe_in_command).map(str::to_string)
    }

    pub fn enable_menu(exe: &Path) -> Result<()> {
        let result = menu_plan(exe).into_iter().try_for_each(|v| write(&v.key, v.name, &v.value));
        if result.is_err() {
            let _ = disable_menu();
        }
        notify();
        result
    }

    pub fn disable_menu() -> Result<()> {
        let mut first_err = None;
        for key in menu_keys() {
            if let Err(e) = delete_tree(&key) {
                first_err.get_or_insert(e);
            }
        }
        notify();
        first_err.map_or(Ok(()), Err)
    }
}

#[cfg(not(windows))]
mod imp {
    use std::path::Path;

    use super::engine::{Current, Registry};
    use crate::error::Result;

    /// No registry off Windows: nothing is ever set.
    pub struct Reg;

    impl Registry for Reg {
        fn get(&self, _: &str, _: Option<&str>) -> Current {
            Current::Absent
        }
        fn set(&mut self, _: &str, _: Option<&str>, _: &str) -> Result<()> {
            Ok(())
        }
        fn remove(&mut self, _: &str, _: Option<&str>) -> Result<()> {
            Ok(())
        }
        fn remove_key_if_empty(&mut self, _: &str) -> Result<()> {
            Ok(())
        }
    }

    pub fn menu_target() -> Option<String> {
        None
    }
    pub fn enable_menu(_: &Path) -> Result<()> {
        Ok(())
    }
    pub fn disable_menu() -> Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// WE-10: the uninstaller runs `--restore-explorer` first, and its direct
    /// deletes only when Octopolis.exe is missing or the restore did not exit 0.
    #[test]
    fn the_uninstaller_skips_the_direct_deletes_after_a_clean_restore() {
        let nsh = include_str!("../../../src-tauri/windows/hooks.nsh");
        let start = nsh.find("!macro NSIS_HOOK_PREUNINSTALL").expect("the pre-uninstall hook");
        let hook = &nsh[start..];
        let lines: Vec<&str> = hook.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with(';')).collect();
        let at = |pred: &dyn Fn(&str) -> bool| lines.iter().position(|l| pred(l));
        let preset = at(&|l| l == "StrCpy $0 1").expect("$0 starts as 1");
        let exec = at(&|l| l.starts_with("ExecWait") && l.contains("--restore-explorer") && l.ends_with("$0")).expect("runs --restore-explorer into $0");
        let guarded = at(&|l| l == "${AndIf} $0 <> 0").expect("the deletes are guarded by the exit code");
        assert!(preset < exec && exec < guarded, "{preset} {exec} {guarded}");
        // A start failure is read from the error flag, not from $0 (undefined then): it forces the fallback.
        assert_eq!(lines[exec - 1], "ClearErrors", "the error flag is cleared right before ExecWait");
        assert_eq!(&lines[exec + 1..exec + 4], ["${If} ${Errors}", "StrCpy $0 1", "${EndIf}"], "a failed start sets $0 to 1");
        assert_eq!(lines[guarded - 1], "${If} $UpdateMode <> 1", "the guard is one If block");
        let end = guarded + lines[guarded..].iter().position(|l| *l == "${EndIf}").expect("the guarded block ends");
        let deletes: Vec<usize> = (0..lines.len()).filter(|&i| lines[i].starts_with("DeleteReg")).collect();
        assert!(!deletes.is_empty(), "the fallback deletes are there");
        assert!(deletes.iter().all(|&i| guarded < i && i < end), "every registry delete sits inside the guarded block");
        assert!(lines[guarded + 1..end].iter().all(|l| !l.contains("$0") || l.starts_with("ReadRegStr $0") || l.starts_with("StrCmp $0")), "nothing inside resets the exit code before the deletes");
    }

    /// WE-01/WE-10: the installer puts the helper beside Octopolis.exe; the uninstaller stops it
    /// before restoring, and removes the Run value only when it starts this install's helper.
    #[test]
    fn the_installer_ships_the_helper_and_the_uninstaller_stops_it_first() {
        let nsh = include_str!("../../../src-tauri/windows/hooks.nsh");
        let lines: Vec<&str> = nsh.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with(';')).collect();
        let at = |pred: &dyn Fn(&str) -> bool| lines.iter().position(|l| pred(l)).unwrap_or(usize::MAX);
        let post = at(&|l| l == "!macro NSIS_HOOK_POSTINSTALL");
        let file = at(&|l| l.starts_with("File ") && l.contains("/oname=octopolis-keys.exe"));
        assert!(post < file && file != usize::MAX, "the helper is installed after the app files");
        assert!(nsh.contains("target\\release\\octopolis-keys.exe"), "from the release build");
        let pre_un = at(&|l| l == "!macro NSIS_HOOK_PREUNINSTALL");
        let stop = pre_un + lines[pre_un..].iter().position(|l| l.contains("octopolis-keys.exe\" --stop")).expect("the helper is stopped");
        let restore = pre_un + lines[pre_un..].iter().position(|l| l.contains("--restore-explorer")).unwrap();
        assert!(stop < restore, "the helper stops before the restore");
        let run_delete = at(&|l| l.starts_with("DeleteRegValue") && l.contains("OctopolisKeys"));
        assert!(run_delete != usize::MAX && lines[run_delete - 1].starts_with("StrCmp $0 '\"$INSTDIR\\octopolis-keys.exe\"'"), "only this install's helper Run value");
        // The installer starts the helper only when its Run value names it ("Win+E opens Octopolis" on, this copy the target).
        let exec = post + lines[post..].iter().position(|l| l.starts_with("Exec ") && l.contains("octopolis-keys.exe")).expect("started after install");
        assert_eq!(lines[exec - 1], "${If} $0 == '\"$INSTDIR\\octopolis-keys.exe\"'", "the start is guarded");
        assert!(lines[exec - 2].starts_with("ReadRegStr $0 HKCU \"Software\\Microsoft\\Windows\\CurrentVersion\\Run\" \"OctopolisKeys\""));
        let pre_in = at(&|l| l == "!macro NSIS_HOOK_PREINSTALL");
        assert!(lines[pre_in..post].iter().any(|l| l.contains("--stop")), "an update stops the running helper first");
    }

    #[test]
    fn the_menu_entry_of_another_existing_copy_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let other = dir.path().join("Octopolis.exe");
        std::fs::write(&other, b"").unwrap();
        let this = Path::new("C:\\Program Files\\Octopolis\\Octopolis.exe");
        assert!(menu_belongs_elsewhere(Some(&other.display().to_string()), this));
        assert!(!menu_belongs_elsewhere(Some(&this.display().to_string()), this), "this copy's own entry goes");
        assert!(!menu_belongs_elsewhere(Some("C:\\Gone\\Octopolis.exe"), this), "a missing copy's entry goes");
        assert!(!menu_belongs_elsewhere(None, this));
    }

    #[test]
    fn plan_points_folders_and_win_e_at_the_exe() {
        let exe = Path::new("C:\\Program Files\\Octopolis\\Octopolis.exe");
        let p = plan(exe);
        let cmd = |key: &str| p.iter().find(|v| v.key == key && v.name.is_none()).map(|v| v.value.clone());
        assert_eq!(cmd("Directory\\shell").as_deref(), Some(VERB));
        assert_eq!(cmd("Drive\\shell").as_deref(), Some(VERB));
        assert_eq!(cmd("Directory\\shell\\openinoctopolis\\command").as_deref(), Some("\"C:\\Program Files\\Octopolis\\Octopolis.exe\" \"%1\""));
        let win_e = format!("CLSID\\{WIN_E_CLSID}\\shell\\opennewwindow\\command");
        assert_eq!(cmd(&win_e), Some(format!("\"{}\" \"{THIS_PC}\"", exe.display())));
        assert!(p.iter().any(|v| v.key == win_e && v.name == Some("DelegateExecute") && v.value.is_empty()));
    }

    #[test]
    fn every_written_key_is_removed_on_disable() {
        let owned = owned_keys();
        for v in plan(Path::new("C:\\o.exe")) {
            let covered = owned.iter().any(|k| v.key.starts_with(k.as_str())) || DEFAULT_VERB_KEYS.contains(&v.key.as_str());
            assert!(covered, "{} would be left behind", v.key);
        }
    }

    #[test]
    fn menu_entry_covers_folders_drives_and_backgrounds_without_changing_the_default() {
        let p = menu_plan(Path::new("C:\\o.exe"));
        assert!(p.iter().all(|v| menu_keys().iter().any(|k| v.key.starts_with(k.as_str()))), "every value lives under a key disable_menu removes");
        assert!(!p.iter().any(|v| DEFAULT_VERB_KEYS.contains(&v.key.as_str())), "Explorer stays the default");
        let bg = p.iter().find(|v| v.key == format!("Directory\\Background\\shell\\{MENU_VERB}\\command")).unwrap();
        assert_eq!(bg.value, "\"C:\\o.exe\" \"%V\"");
    }

    #[test]
    fn reads_the_exe_back_from_a_command() {
        assert_eq!(exe_in_command("\"C:\\a b\\Octopolis.exe\" \"%1\""), Some("C:\\a b\\Octopolis.exe"));
        assert_eq!(exe_in_command("explorer.exe"), None);
    }
}
