//! File name validation and collision-free name generation.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

const FORBIDDEN: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Checks a single path component against Windows naming rules.
pub fn validate_name(name: &str) -> Result<()> {
    let bad = |why: &str| Err(Error::InvalidName(format!("\"{name}\" {why}")));
    if name.trim().is_empty() {
        return bad("is empty");
    }
    if name == "." || name == ".." {
        return bad("is reserved");
    }
    if let Some(c) = name.chars().find(|c| FORBIDDEN.contains(c) || (*c as u32) < 32) {
        return bad(&format!("contains the character {c:?}"));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return bad("cannot end with a dot or a space");
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        return bad("is a reserved device name");
    }
    if name.encode_utf16().count() > 255 {
        return bad("is longer than 255 characters");
    }
    Ok(())
}

/// Splits `name.ext` into (`name`, `.ext`). Folders and dotfiles keep the
/// whole name as the stem.
fn split_ext(name: &str, is_dir: bool) -> (&str, &str) {
    if is_dir {
        return (name, "");
    }
    match name.rfind('.') {
        Some(i) if i > 0 => name.split_at(i),
        _ => (name, ""),
    }
}

/// Returns `dir/name`, or the first free `dir/name (N).ext` if it is taken.
pub fn unique_path(dir: &Path, name: &str, is_dir: bool) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = split_ext(name, is_dir);
    (2u32..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .expect("an unbounded counter always finds a free name")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ordinary_names() {
        for ok in ["a.txt", "My Folder", ".gitignore", "日本語", "icon.png", "CONSOLE"] {
            assert!(validate_name(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn rejects_invalid_names() {
        for bad in ["", "  ", "a/b", "a:b", "what?", "end.", "end ", "CON", "nul.txt", "con.txt.bak", "..", "tab\there"] {
            assert!(validate_name(bad).is_err(), "{bad:?}");
        }
        assert!(validate_name(&"x".repeat(256)).is_err());
    }

    #[test]
    fn unique_path_counts_up_and_keeps_extension() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(unique_path(tmp.path(), "a.txt", false), tmp.path().join("a.txt"));
        std::fs::write(tmp.path().join("a.txt"), b"").unwrap();
        assert_eq!(unique_path(tmp.path(), "a.txt", false), tmp.path().join("a (2).txt"));
        std::fs::write(tmp.path().join("a (2).txt"), b"").unwrap();
        assert_eq!(unique_path(tmp.path(), "a.txt", false), tmp.path().join("a (3).txt"));
    }

    #[test]
    fn unique_path_for_dirs_and_dotfiles_ignores_extension() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("v1.2")).unwrap();
        assert_eq!(unique_path(tmp.path(), "v1.2", true), tmp.path().join("v1.2 (2)"));
        std::fs::write(tmp.path().join(".env"), b"").unwrap();
        assert_eq!(unique_path(tmp.path(), ".env", false), tmp.path().join(".env (2)"));
    }
}
