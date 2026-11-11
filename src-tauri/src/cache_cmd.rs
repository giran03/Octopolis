//! Cache directory management, inspection, relocation and clearing.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use octo_core::shell;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::search_cmd::SearchState;
use crate::size_cmd::{SAVE_FILE, SizesState};

const POINTER_FILE: &str = "cache-location.txt";
const UPDATES_DIR: &str = "updates";

#[derive(Default)]
pub struct CacheState {
    /// Cached resolved path (None = not loaded yet).
    dir: Mutex<Option<PathBuf>>,
}

fn pointer_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(POINTER_FILE))
}

pub fn default_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// Resolves the active cache folder (custom path from `cache-location.txt`, or `app_data_dir`).
pub fn resolve_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let state: State<'_, CacheState> = app.state();
    let mut guard = state.dir.lock().map_err(|e| e.to_string())?;
    if let Some(ref p) = *guard {
        return Ok(p.clone());
    }
    let ptr = pointer_file(app)?;
    let custom = fs::read_to_string(&ptr)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let resolved = match custom {
        Some(p) => p,
        None => default_cache_dir(app)?,
    };
    *guard = Some(resolved.clone());
    Ok(resolved)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheItemDto {
    id: &'static str,
    label: &'static str,
    detail: String,
    bytes: u64,
    count: usize,
    kind: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfoDto {
    dir: String,
    default_dir: String,
    is_custom: bool,
    total_disk_bytes: u64,
    items: Vec<CacheItemDto>,
}

fn dir_size_and_files(dir: &Path) -> (u64, usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return (0, 0);
    };
    let mut bytes = 0u64;
    let mut files = 0usize;
    for entry in entries.flatten() {
        let p = entry.path();
        if let Ok(meta) = entry.metadata() {
            if meta.is_dir() {
                let (b, f) = dir_size_and_files(&p);
                bytes += b;
                files += f;
            } else {
                bytes += meta.len();
                files += 1;
            }
        }
    }
    (bytes, files)
}

fn build_info(app: &AppHandle) -> Result<CacheInfoDto, String> {
    let dir = resolve_cache_dir(app)?;
    let default_dir = default_cache_dir(app)?;
    let is_custom = !dir.to_string_lossy().eq_ignore_ascii_case(&default_dir.to_string_lossy());

    let sizes_state: State<'_, SizesState> = app.state();
    let (live_dirs, saved_dirs, size_bytes) = sizes_state.stats(app);

    let (upd_bytes, upd_files) = dir_size_and_files(&dir.join(UPDATES_DIR));
    let search_roots = app.state::<SearchState>().cached_count();

    let items = vec![
        CacheItemDto {
            id: "sizes",
            label: "Folder size index",
            detail: format!("{} saved · {} live in memory", saved_dirs, live_dirs),
            bytes: size_bytes,
            count: saved_dirs + live_dirs,
            kind: "disk",
        },
        CacheItemDto {
            id: "updates",
            label: "Downloaded updates",
            detail: if upd_files == 0 {
                "No staged update installers".into()
            } else {
                format!("{upd_files} installer file{}", if upd_files == 1 { "" } else { "s" })
            },
            bytes: upd_bytes,
            count: upd_files,
            kind: "disk",
        },
        CacheItemDto {
            id: "search",
            label: "Search index",
            detail: if search_roots == 0 {
                "No folders indexed in memory yet".into()
            } else {
                format!("{search_roots} folder tree{} cached in memory", if search_roots == 1 { "" } else { "s" })
            },
            bytes: 0,
            count: search_roots,
            kind: "memory",
        },
    ];

    Ok(CacheInfoDto {
        dir: dir.to_string_lossy().into_owned(),
        default_dir: default_dir.to_string_lossy().into_owned(),
        is_custom,
        total_disk_bytes: size_bytes + upd_bytes,
        items,
    })
}

fn move_file_or_copy(from: &Path, to: &Path) -> Result<(), String> {
    if !from.exists() || from == to {
        return Ok(());
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    fs::copy(from, to).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(from);
    Ok(())
}

fn move_dir_contents(from: &Path, to: &Path) -> Result<(), String> {
    if !from.is_dir() || from == to {
        return Ok(());
    }
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            move_dir_contents(&src, &dst)?;
        } else {
            move_file_or_copy(&src, &dst)?;
        }
    }
    let _ = fs::remove_dir_all(from);
    Ok(())
}

#[tauri::command]
pub async fn cache_info(app: AppHandle) -> Result<CacheInfoDto, String> {
    crate::off_main(move || build_info(&app)).await
}

#[tauri::command]
pub async fn open_cache_folder(app: AppHandle) -> Result<(), String> {
    let dir = resolve_cache_dir(&app)?;
    crate::off_main(move || {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        shell::open_path(&dir).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn pick_cache_folder(window: tauri::WebviewWindow, app: AppHandle) -> Result<Option<String>, String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let current = resolve_cache_dir(&app).ok();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let res = shell::pick_folder(hwnd, current.as_deref()).map_err(|e| e.to_string());
            let _ = tx.send(res);
        })
        .map_err(|e| e.to_string())?;
    let picked = crate::off_main(move || rx.recv().map_err(|e| e.to_string())).await??;
    Ok(picked.map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn set_cache_dir(app: AppHandle, path: Option<String>) -> Result<CacheInfoDto, String> {
    crate::off_main(move || {
        let default_dir = default_cache_dir(&app)?;
        let target = match path.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
            Some(p) => PathBuf::from(p),
            None => default_dir.clone(),
        };
        let old = resolve_cache_dir(&app)?;
        if !old.to_string_lossy().eq_ignore_ascii_case(&target.to_string_lossy()) {
            fs::create_dir_all(&target).map_err(|e| format!("Cannot create cache folder: {e}"))?;
            // Verify write access before updating the pointer.
            let probe = target.join(".octopolis-write-test");
            fs::write(&probe, b"").map_err(|e| format!("Cache folder is not writable: {e}"))?;
            let _ = fs::remove_file(&probe);

            let sizes_state: State<'_, SizesState> = app.state();
            sizes_state.flush_now();
            move_file_or_copy(&old.join(SAVE_FILE), &target.join(SAVE_FILE))?;
            move_dir_contents(&old.join(UPDATES_DIR), &target.join(UPDATES_DIR))?;
            sizes_state.set_saved_file(target.join(SAVE_FILE));
        }

        let ptr = pointer_file(&app)?;
        if target.to_string_lossy().eq_ignore_ascii_case(&default_dir.to_string_lossy()) {
            let _ = fs::remove_file(&ptr);
        } else {
            if let Some(parent) = ptr.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&ptr, target.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
        }
        *app.state::<CacheState>().dir.lock().map_err(|e| e.to_string())? = Some(target);
        build_info(&app)
    })
    .await
}

#[tauri::command]
pub async fn clear_cache(app: AppHandle, scope: String) -> Result<CacheInfoDto, String> {
    crate::off_main(move || {
        let dir = resolve_cache_dir(&app)?;
        let clear_all = scope == "all";
        if clear_all || scope == "sizes" {
            app.state::<SizesState>().clear_cache(&app)?;
        }
        if clear_all || scope == "updates" {
            let upd = dir.join(UPDATES_DIR);
            if upd.exists() {
                fs::remove_dir_all(&upd).map_err(|e| e.to_string())?;
            }
        }
        if clear_all || scope == "search" {
            app.state::<SearchState>().clear_cache();
        }
        build_info(&app)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_dir_size_and_moves_contents() {
        let base = std::env::temp_dir().join(format!("octopolis-cache-test-{}", std::process::id()));
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(src.join("updates")).unwrap();
        fs::write(src.join("size-cache.json"), b"{\"a\":[1,2,3]}").unwrap();
        fs::write(src.join("updates/setup.exe"), vec![0u8; 64]).unwrap();

        assert_eq!(dir_size_and_files(&src.join("updates")), (64, 1));
        move_dir_contents(&src.join("updates"), &dst.join("updates")).unwrap();
        assert_eq!(dir_size_and_files(&dst.join("updates")), (64, 1));
        assert!(!src.join("updates").exists());

        let _ = fs::remove_dir_all(base);
    }
}
