//! "Use Octopolis instead of File Explorer": per-user (HKCU) registry entries
//! that send folder opens and Win+E to Octopolis. No admin rights needed, and
//! turning it off removes only the entries written here.

use std::path::Path;

use crate::error::Result;

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

/// What is set up right now.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Status {
    /// Folder opens go to Octopolis.
    pub folders: bool,
    /// Win+E goes to Octopolis.
    pub win_e: bool,
    /// The exe the entries point at, if they exist.
    pub target: Option<String>,
}

pub fn status() -> Status {
    imp::status()
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

/// Writes every entry for `exe`, then tells Explorer associations changed.
/// Win+E is left alone if another tool already redirects it.
pub fn enable(exe: &Path) -> Result<()> {
    imp::enable(exe)
}

/// Removes every entry Octopolis wrote. Safe to call when nothing is set.
pub fn disable() -> Result<()> {
    imp::disable()
}

/// The exe path inside a command written by [`plan`].
pub fn exe_in_command(command: &str) -> Option<&str> {
    command.strip_prefix('"')?.split('"').next()
}

#[cfg(windows)]
mod imp {
    use std::path::Path;

    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, WIN32_ERROR};
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ, RegCloseKey, RegCreateKeyExW,
        RegDeleteTreeW, RegDeleteValueW, RegGetValueW, RegOpenKeyExW, RegSetValueExW,
    };
    use windows::Win32::UI::Shell::{SHCNE_ASSOCCHANGED, SHCNF_IDLIST, SHChangeNotify};
    use windows::core::PCWSTR;

    use super::{DEFAULT_VERB_KEYS, Status, VERB, WIN_E_CLSID, exe_in_command, menu_keys, menu_plan, owned_keys, plan};
    use crate::error::{Error, Result};

    const CLASSES: &str = "Software\\Classes";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn fail(what: &str, code: WIN32_ERROR) -> Error {
        Error::io(Path::new("registry"), std::io::Error::other(format!("{what} (error {})", code.0)))
    }

    fn read(key: &str, name: Option<&str>) -> Option<String> {
        let path = wide(&format!("{CLASSES}\\{key}"));
        let name_w = name.map(wide);
        let mut buf = vec![0u16; 1024];
        let mut bytes = (buf.len() * 2) as u32;
        // SAFETY: buffers are valid for the sizes passed.
        let code = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(path.as_ptr()),
                name_w.as_ref().map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr())),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut bytes),
            )
        };
        if code.is_err() {
            return None;
        }
        buf.truncate((bytes as usize / 2).saturating_sub(1));
        Some(String::from_utf16_lossy(&buf))
    }

    fn write(key: &str, name: Option<&str>, value: &str) -> Result<()> {
        let path = wide(&format!("{CLASSES}\\{key}"));
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
            let c = RegSetValueExW(hkey, name_w.as_ref().map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr())), None, REG_SZ, Some(bytes));
            let _ = RegCloseKey(hkey);
            c
        };
        if code.is_err() { Err(fail("a registry value could not be written", code)) } else { Ok(()) }
    }

    fn delete_tree(key: &str) -> Result<()> {
        let path = wide(&format!("{CLASSES}\\{key}"));
        // SAFETY: `path` is NUL-terminated. With a null subkey this deletes the key and everything in it.
        let code = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr())) };
        if code.is_err() && code != ERROR_FILE_NOT_FOUND {
            return Err(fail("a registry key could not be removed", code));
        }
        // RegDeleteTreeW empties the key but leaves it; remove the now-empty key itself.
        if let Some((parent, name)) = key.rsplit_once('\\') {
            let parent_w = wide(&format!("{CLASSES}\\{parent}"));
            let name_w = wide(name);
            let mut hkey = HKEY::default();
            // SAFETY: plain registry calls on NUL-terminated strings; the handle is closed.
            unsafe {
                if RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(parent_w.as_ptr()), None, KEY_WRITE, &mut hkey).is_ok() {
                    let _ = windows::Win32::System::Registry::RegDeleteKeyW(hkey, PCWSTR(name_w.as_ptr()));
                    let _ = RegCloseKey(hkey);
                }
            }
        }
        Ok(())
    }

    /// Clears a shell key's default verb, but only if it is ours.
    fn clear_default_verb(key: &str) -> Result<()> {
        if read(key, None).as_deref() != Some(VERB) {
            return Ok(());
        }
        let path = wide(&format!("{CLASSES}\\{key}"));
        let mut hkey = HKEY::default();
        // SAFETY: plain registry calls; the handle is closed.
        unsafe {
            let code = RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr()), None, KEY_SET_VALUE, &mut hkey);
            if code.is_err() {
                return Err(fail("a registry key could not be opened", code));
            }
            let code = RegDeleteValueW(hkey, PCWSTR::null());
            let _ = RegCloseKey(hkey);
            if code.is_err() && code != ERROR_FILE_NOT_FOUND {
                return Err(fail("a registry value could not be removed", code));
            }
        }
        Ok(())
    }

    fn notify() {
        // SAFETY: plain notification with no items.
        unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
    }

    fn is_ours(command: Option<&str>) -> bool {
        command.and_then(exe_in_command).is_some_and(|exe| exe.to_ascii_lowercase().contains("octopolis"))
    }

    fn win_e_command() -> Option<String> {
        read(&format!("CLSID\\{WIN_E_CLSID}\\shell\\opennewwindow\\command"), None)
    }

    pub fn status() -> Status {
        let folder_cmd = read(&format!("Directory\\shell\\{VERB}\\command"), None);
        let folders = read("Directory\\shell", None).as_deref() == Some(VERB) && folder_cmd.is_some();
        let win_e_cmd = win_e_command();
        let win_e = is_ours(win_e_cmd.as_deref());
        let target = folder_cmd.or(win_e_cmd.filter(|_| win_e)).as_deref().and_then(exe_in_command).map(str::to_string);
        Status { folders, win_e, target }
    }

    pub fn enable(exe: &Path) -> Result<()> {
        let existing = win_e_command();
        let foreign = existing.is_some() && !is_ours(existing.as_deref());
        let result = plan(exe)
            .into_iter()
            .filter(|v| !(foreign && v.key.starts_with("CLSID\\")))
            .try_for_each(|v| write(&v.key, v.name, &v.value));
        if result.is_err() {
            let _ = disable();
        }
        notify();
        result
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

    pub fn disable() -> Result<()> {
        let mut first_err = None;
        for key in DEFAULT_VERB_KEYS {
            if let Err(e) = clear_default_verb(key) {
                first_err.get_or_insert(e);
            }
        }
        let win_e_ours = is_ours(win_e_command().as_deref());
        for key in owned_keys() {
            // Never remove a Win+E override another tool wrote.
            if key.starts_with("CLSID\\") && !win_e_ours {
                continue;
            }
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

    use super::Status;
    use crate::error::Result;

    pub fn status() -> Status {
        Status::default()
    }
    pub fn enable(_: &Path) -> Result<()> {
        Ok(())
    }
    pub fn disable() -> Result<()> {
        Ok(())
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
