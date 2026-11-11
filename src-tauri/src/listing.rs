//! Directory listing over a raw binary channel, plus path-bar resolution.

use std::path::{Path, PathBuf};
use std::time::Instant;

use octo_core::codec::BatchEncoder;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};

/// The first batch is small so the list paints almost immediately; the rest
/// are large so per-message IPC overhead stays negligible.
const FIRST_BATCH: u32 = 256;
const NEXT_BATCH: u32 = 8192;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSummary {
    count: u32,
    elapsed_ms: f64,
}

#[tauri::command]
pub async fn list_dir(path: String, on_batch: Channel<InvokeResponseBody>) -> Result<ListSummary, String> {
    tauri::async_runtime::spawn_blocking(move || stream_listing(Path::new(&path), &on_batch))
        .await
        .map_err(|e| e.to_string())?
}

fn stream_listing(dir: &Path, channel: &Channel<InvokeResponseBody>) -> Result<ListSummary, String> {
    let started = Instant::now();
    let mut enc = BatchEncoder::with_capacity(64 * 1024);
    let mut limit = FIRST_BATCH;
    let mut total = 0u32;
    let mut send_error = None;

    octo_core::enumerate_dir(dir, |entry| {
        enc.push(&entry);
        total += 1;
        if enc.len() >= limit && send_error.is_none() {
            limit = NEXT_BATCH;
            if let Err(e) = channel.send(InvokeResponseBody::Raw(enc.finish(false))) {
                send_error = Some(e.to_string());
            }
        }
    })
    .map_err(|e| e.to_string())?;

    if let Some(e) = send_error {
        return Err(e);
    }
    channel.send(InvokeResponseBody::Raw(enc.finish(true))).map_err(|e| e.to_string())?;
    Ok(ListSummary { count: total, elapsed_ms: started.elapsed().as_secs_f64() * 1000.0 })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    /// Folder to show.
    dir: String,
    /// Item to select inside it, when the user typed a file path.
    select: Option<String>,
}

/// Turns what the user typed in the path bar into a folder to open:
/// expands `~` and `%VARS%`, accepts `/`, `C:` and file paths.
#[tauri::command]
pub async fn resolve_path(input: String) -> Result<Resolved, String> {
    crate::off_main(move || resolve(input)).await
}

fn resolve(input: String) -> Result<Resolved, String> {
    let expanded = expand(input.trim().trim_matches('"'));
    if expanded.is_empty() {
        return Err("Type a folder path".into());
    }
    let mut path = PathBuf::from(expanded.replace('/', "\\"));
    if path.as_os_str().len() == 2 && expanded.ends_with(':') {
        path.push("\\"); // `C:` alone means the drive root, not its current dir
    }
    let path = std::path::absolute(&path).map_err(|e| e.to_string())?;
    let meta = std::fs::metadata(&path).map_err(|_| format!("Can't find \"{}\"", path.display()))?;
    if meta.is_dir() {
        return Ok(Resolved { dir: display(&path), select: None });
    }
    let parent = path.parent().ok_or("That path has no folder")?;
    Ok(Resolved {
        dir: display(parent),
        select: path.file_name().map(|n| n.to_string_lossy().into_owned()),
    })
}

fn display(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Expands a leading `~` and any `%NAME%` environment variables.
fn expand(input: &str) -> String {
    let home = || dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default();
    let with_home = match input.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => format!("{}{rest}", home()),
        _ => input.to_string(),
    };
    let mut out = String::with_capacity(with_home.len());
    let mut rest = with_home.as_str();
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(value) => out.push_str(&value),
                    Err(_) => out.push_str(&rest[start..start + end + 2]),
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_env_vars_and_keeps_unknown_ones() {
        // SAFETY: tests in this module do not read this variable concurrently.
        unsafe { std::env::set_var("OCTO_TEST_DIR", r"C:\x") };
        assert_eq!(expand(r"%OCTO_TEST_DIR%\y"), r"C:\x\y");
        assert_eq!(expand("%NOPE_NOT_SET%"), "%NOPE_NOT_SET%");
        assert_eq!(expand("100% sure"), "100% sure");
    }

    #[test]
    fn expands_home() {
        let home = dirs::home_dir().unwrap().to_string_lossy().into_owned();
        assert_eq!(expand("~"), home);
        assert_eq!(expand(r"~\Docs"), format!(r"{home}\Docs"));
        assert_eq!(expand("~user"), "~user");
    }

    #[test]
    fn resolves_files_to_their_folder() {
        let tmp = std::env::temp_dir().join("octo-resolve-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("pick.txt");
        std::fs::write(&file, b"").unwrap();
        let r = resolve(file.to_string_lossy().into_owned()).unwrap();
        assert_eq!(PathBuf::from(r.dir), tmp);
        assert_eq!(r.select.as_deref(), Some("pick.txt"));
        assert!(resolve(tmp.join("missing").to_string_lossy().into_owned()).is_err());
    }
}
