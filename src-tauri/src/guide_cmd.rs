//! The offline user guide.
//!
//! The guide is one self-contained HTML page, embedded in the app. Opening it writes the page into
//! `<app data>/guide/` next to `guide-theme.js` (the colors, font and motion setting the app is using) and opens
//! the page in the default browser. The page reads `guide-theme.js` when it opens and again whenever its tab is
//! focused, so it follows the app's theme without any server.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use octo_core::shell;
use tauri::{AppHandle, Manager};

/// Built by `scripts/build-guide.mjs` (a stub is written by build.rs when it has not been built yet).
static GUIDE_HTML: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../public/octopolis-guide.html"));

const GUIDE_DIR: &str = "guide";
const GUIDE_FILE: &str = "octopolis-guide.html";
const THEME_FILE: &str = "guide-theme.js";
/// The theme payload is a few KB; anything bigger is not ours.
const MAX_PAYLOAD_BYTES: usize = 256 * 1024;

fn guide_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(GUIDE_DIR))
}

/// The theme file's text: `window.__OCTOPOLIS__ = { … };`. The payload is re-serialized, and `<` and the line
/// separators are written as escapes, so nothing in it (a theme called `</script>`, say) can break out of a script.
pub fn theme_script(json: &str) -> Result<String, String> {
    if json.len() > MAX_PAYLOAD_BYTES {
        return Err("The theme data is too large".into());
    }
    let value: serde_json::Value = serde_json::from_str(json).map_err(|_| "The theme data is not valid".to_string())?;
    if !value.is_object() {
        return Err("The theme data is not valid".into());
    }
    let text = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    let safe = text.replace('<', "\\u003c").replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029");
    Ok(format!("window.__OCTOPOLIS__ = {safe};\n"))
}

/// Writes `bytes` to `path` unless it already holds exactly them; true when it wrote.
pub fn write_if_changed(path: &Path, bytes: &[u8]) -> io::Result<bool> {
    if fs::read(path).map(|old| old == bytes).unwrap_or(false) {
        return Ok(false);
    }
    fs::write(path, bytes)?;
    Ok(true)
}

fn write_guide(dir: &Path, html: &[u8], theme: &str) -> Result<PathBuf, String> {
    let script = theme_script(theme)?;
    fs::create_dir_all(dir).map_err(|e| format!("Couldn't prepare the guide: {e}"))?;
    let page = dir.join(GUIDE_FILE);
    write_if_changed(&page, html).map_err(|e| format!("Couldn't write the guide: {e}"))?;
    fs::write(dir.join(THEME_FILE), script).map_err(|e| format!("Couldn't write the guide's theme: {e}"))?;
    Ok(page)
}

/// Writes the guide next to its theme file and opens it in the default browser.
#[tauri::command]
pub async fn open_guide(app: AppHandle, theme: String) -> Result<(), String> {
    let dir = guide_dir(&app)?;
    crate::off_main(move || {
        let page = write_guide(&dir, GUIDE_HTML, &theme)?;
        shell::open_path(&page).map_err(|e| format!("Couldn't open the guide: {e}"))
    })
    .await
}

/// Refreshes the theme the guide follows (after the app's theme changed), if the guide has been written before.
#[tauri::command]
pub async fn update_guide_theme(app: AppHandle, theme: String) -> Result<(), String> {
    let dir = guide_dir(&app)?;
    crate::off_main(move || {
        if !dir.join(GUIDE_FILE).exists() {
            return Ok(());
        }
        fs::write(dir.join(THEME_FILE), theme_script(&theme)?).map_err(|e| e.to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("octopolis-guide-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn theme_script_is_a_safe_assignment() {
        let s = theme_script(r#"{"name":"</script><script>alert(1)</script>","v":1}"#).unwrap();
        assert!(s.starts_with("window.__OCTOPOLIS__ = {"));
        assert!(!s.contains('<'), "a < could end the script: {s}");
        assert!(s.contains("\\u003c/script"));
        // It is still the same data.
        let json = s.trim_start_matches("window.__OCTOPOLIS__ = ").trim_end().trim_end_matches(';');
        let back: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(back["name"], "</script><script>alert(1)</script>");
    }

    #[test]
    fn theme_script_escapes_line_separators() {
        let s = theme_script("{\"name\":\"a\u{2028}b\u{2029}c\"}").unwrap();
        assert!(!s.contains('\u{2028}') && !s.contains('\u{2029}'));
        assert!(s.contains("\\u2028") && s.contains("\\u2029"));
    }

    #[test]
    fn theme_script_rejects_anything_that_is_not_a_json_object() {
        assert!(theme_script("alert(1)").is_err());
        assert!(theme_script("[1,2]").is_err());
        assert!(theme_script("\"text\"").is_err());
        assert!(theme_script("").is_err());
        assert!(theme_script(&format!("{{\"a\":\"{}\"}}", "x".repeat(MAX_PAYLOAD_BYTES))).is_err());
    }

    #[test]
    fn writes_the_page_once_and_the_theme_every_time() {
        let dir = temp("write");
        let page = write_guide(&dir, b"<html>one</html>", r#"{"name":"A"}"#).unwrap();
        assert_eq!(fs::read(&page).unwrap(), b"<html>one</html>");
        assert!(fs::read_to_string(dir.join(THEME_FILE)).unwrap().contains("\"A\""));
        // The same page is not rewritten; a new theme is.
        assert!(!write_if_changed(&page, b"<html>one</html>").unwrap());
        write_guide(&dir, b"<html>one</html>", r#"{"name":"B"}"#).unwrap();
        assert!(fs::read_to_string(dir.join(THEME_FILE)).unwrap().contains("\"B\""));
        // A new page replaces the old one.
        write_guide(&dir, b"<html>two</html>", r#"{"name":"B"}"#).unwrap();
        assert_eq!(fs::read(&page).unwrap(), b"<html>two</html>");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_bad_theme_writes_nothing() {
        let dir = temp("bad");
        assert!(write_guide(&dir, b"<html></html>", "not json").is_err());
        assert!(!dir.exists());
    }

    #[test]
    fn the_embedded_guide_is_a_page() {
        let text = String::from_utf8_lossy(GUIDE_HTML);
        assert!(text.contains("<html"), "the guide is not built into the app");
    }
}
