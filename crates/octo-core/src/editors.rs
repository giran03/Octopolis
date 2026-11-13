//! Finds the code editors and IDEs installed for the current user.
//!
//! Nothing here assumes where a program lives. Candidate folders come from the
//! environment (`%LOCALAPPDATA%`, `%ProgramFiles%`, `PATH`) and from what Windows
//! records about installed apps (App Paths and Uninstall entries, which also
//! cover installs on other drives). Each folder is then recognised by what is
//! inside it: VS Code-style editors (Code, Cursor, Windsurf, Antigravity, ...)
//! ship `resources/app/product.json`, JetBrains IDEs ship `product-info.json`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// A code editor found on this PC.
#[derive(Debug, Clone)]
pub struct Editor {
    pub name: String,
    pub path: PathBuf,
}

/// Editors without a readable product manifest (native apps, or Electron apps that
/// pack it into an archive), recognised by their program name.
const KNOWN_EXES: &[(&str, &str)] = &[
    ("Antigravity", "Antigravity.exe"),
    ("Kiro", "Kiro.exe"),
    ("Trae", "Trae.exe"),
    ("Void", "Void.exe"),
    ("PearAI", "PearAI.exe"),
    ("Sublime Text", "sublime_text.exe"),
    ("Notepad++", "notepad++.exe"),
    ("Zed", "Zed.exe"),
    ("Neovide", "neovide.exe"),
    ("Lapce", "lapce.exe"),
    ("Kate", "kate.exe"),
    ("Helix", "hx.exe"),
    ("Neovim", "nvim.exe"),
];

/// Installed editors, most likely first. Slow-ish (reads the registry), so call it off the UI thread.
pub fn detect() -> Vec<Editor> {
    let mut found: Vec<Editor> = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();
    for dir in candidate_dirs() {
        if let Some(editor) = classify(&dir)
            && seen_paths.insert(editor.path.to_string_lossy().to_lowercase())
        {
            found.push(editor);
        }
    }
    // Windows' own Notepad is always there and needs no search.
    if let Some(notepad) = std::env::var_os("SystemRoot").map(|r| PathBuf::from(r).join("System32").join("notepad.exe")).filter(|p| p.is_file())
        && seen_paths.insert(notepad.to_string_lossy().to_lowercase())
    {
        found.push(Editor { name: "Notepad".into(), path: notepad });
    }
    found.sort_by_key(|e| e.name.to_lowercase());
    found
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from).filter(|p| p.is_dir())
}

/// Every folder that might hold an editor.
fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    // Per-user and machine-wide install roots: each child folder is a candidate.
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(local) = env_dir("LOCALAPPDATA") {
        roots.push(local.join("Programs"));
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Some(pf) = env_dir(var) {
            roots.push(pf.join("JetBrains"));
            roots.push(pf);
        }
    }
    for root in roots {
        if let Ok(read) = std::fs::read_dir(root) {
            dirs.extend(read.flatten().map(|e| e.path()).filter(|p| p.is_dir()));
        }
    }

    // Folders on PATH, and their parents (`...\Microsoft VS Code\bin` -> `...\Microsoft VS Code`).
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if let Some(parent) = dir.parent() {
                dirs.push(parent.to_path_buf());
            }
            dirs.push(dir);
        }
    }

    // What Windows knows is installed, wherever it was installed to.
    dirs.extend(registry_dirs());

    let mut seen = HashSet::new();
    dirs.retain(|d| seen.insert(d.to_string_lossy().to_lowercase()));
    dirs
}

/// Install folders from the App Paths and Uninstall registry entries.
fn registry_dirs() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        const CURRENT: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion";
        const CURRENT32: &str = r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion";
        let mut queries: Vec<(String, &'static [&'static str])> = Vec::new();
        for hive in ["HKLM", "HKCU"] {
            for base in [CURRENT, CURRENT32] {
                if hive == "HKCU" && base == CURRENT32 {
                    continue;
                }
                queries.push((format!(r"{hive}\{base}\App Paths"), &["/ve"]));
                queries.push((format!(r"{hive}\{base}\Uninstall"), &["/v", "InstallLocation"]));
                queries.push((format!(r"{hive}\{base}\Uninstall"), &["/v", "DisplayIcon"]));
            }
        }
        let lines: Vec<String> = std::thread::scope(|s| {
            let handles: Vec<_> = queries.iter().map(|(key, args)| s.spawn(move || reg_query(key, args))).collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });
        let mut dirs = Vec::new();
        for value in lines {
            let value = expand_env(value.trim().trim_matches('"'));
            // `C:\App\app.exe,0` (an icon index) or `"C:\App\app.exe" --flag`.
            let value = value.split(',').next().unwrap_or("").trim().trim_matches('"').to_string();
            let path = PathBuf::from(&value);
            if path.is_dir() {
                dirs.push(path);
            } else if let Some(parent) = path.parent().filter(|p| p.is_dir()) {
                dirs.push(parent.to_path_buf());
            }
        }
        dirs
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Values printed by `reg query <key> /s <args>`.
#[cfg(windows)]
fn reg_query(key: &str, args: &[&str]) -> Vec<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Ok(out) = std::process::Command::new("reg").arg("query").arg(key).arg("/s").args(args).creation_flags(CREATE_NO_WINDOW).output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let (_, rest) = line.split_once("REG_SZ").or_else(|| line.split_once("REG_EXPAND_SZ"))?;
            let rest = rest.trim();
            (!rest.is_empty()).then(|| rest.to_string())
        })
        .collect()
}

/// Replaces `%NAME%` with its environment value.
#[cfg(windows)]
fn expand_env(text: &str) -> String {
    let mut out = String::new();
    let mut parts = text.split('%');
    out.push_str(parts.next().unwrap_or(""));
    while let Some(name) = parts.next() {
        match (std::env::var(name), parts.next()) {
            (Ok(value), Some(rest)) => {
                out.push_str(&value);
                out.push_str(rest);
            }
            (_, Some(rest)) => {
                out.push('%');
                out.push_str(name);
                out.push('%');
                out.push_str(rest);
            }
            (_, None) => {
                out.push('%');
                out.push_str(name);
            }
        }
    }
    out
}

/// Recognises an editor from what is inside its install folder.
fn classify(dir: &Path) -> Option<Editor> {
    vscode_family(dir).or_else(|| jetbrains(dir)).or_else(|| known_exe(dir))
}

/// VS Code and its forks (Cursor, Windsurf, Antigravity, VSCodium, Kiro, ...).
fn vscode_family(dir: &Path) -> Option<Editor> {
    // Recent builds keep `resources` in a versioned subfolder next to the program.
    let manifest_in = |base: &Path| std::fs::read_to_string(base.join("resources").join("app").join("product.json")).ok();
    // The versioned folder is named after a commit hash, which tells it apart from an app that merely embeds an editor.
    let hashed = |p: &PathBuf| p.file_name().is_some_and(|n| n.len() >= 8 && n.to_string_lossy().chars().all(|c| c.is_ascii_hexdigit()));
    let manifest = manifest_in(dir).or_else(|| std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).filter(|p| p.is_dir() && hashed(p)).find_map(|p| manifest_in(&p)))?;
    let short = json_str(&manifest, "nameShort")?;
    let application = json_str(&manifest, "applicationName").unwrap_or_default();
    let wanted = |stem: &str| stem.eq_ignore_ascii_case(&short) || (!application.is_empty() && stem.eq_ignore_ascii_case(&application));
    let exe = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe"))).find(|p| p.file_stem().is_some_and(|s| wanted(&s.to_string_lossy())))?;
    let name = if short == "Code" { "Visual Studio Code".to_string() } else { short };
    Some(Editor { name, path: exe })
}

/// JetBrains IDEs: `product-info.json` names the IDE and its launcher.
fn jetbrains(dir: &Path) -> Option<Editor> {
    let info = std::fs::read_to_string(dir.join("product-info.json")).ok()?;
    let name = json_str(&info, "name")?;
    let launcher = json_str(&info, "launcherPath")?;
    let path = dir.join(launcher.replace('/', "\\"));
    path.is_file().then_some(Editor { name, path })
}

/// Editors identified only by their program name.
fn known_exe(dir: &Path) -> Option<Editor> {
    KNOWN_EXES.iter().find_map(|(name, exe)| {
        let path = dir.join(exe);
        path.is_file().then(|| Editor { name: (*name).to_string(), path })
    })
}

/// The first string value for `"key"` in JSON text (enough for product manifests).
fn json_str(text: &str, key: &str) -> Option<String> {
    let after = &text[text.find(&format!("\"{key}\""))? + key.len() + 2..];
    let after = after.trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    let mut value = String::new();
    let mut chars = after.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return (!value.is_empty()).then_some(value),
            '\\' => value.push(chars.next()?),
            c => value.push(c),
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run with `cargo test -p octo-core -- --ignored --nocapture` to see what this PC has.
    #[test]
    #[ignore]
    fn lists_installed_editors() {
        for e in detect() {
            println!("{} -> {}", e.name, e.path.display());
        }
    }

    #[test]
    fn reads_manifest_strings() {
        let text = r#"{ "nameLong": "Cursor", "nameShort": "Cursor", "applicationName": "cursor" }"#;
        assert_eq!(json_str(text, "nameShort").as_deref(), Some("Cursor"));
        assert_eq!(json_str(text, "applicationName").as_deref(), Some("cursor"));
        assert_eq!(json_str(text, "missing"), None);
    }
}
