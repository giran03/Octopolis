//! Inspector previews, thumbnails, lock hunting, tags and folder sizes.

use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use octo_core::ops::CancelToken;
use octo_core::preview::{self, Kind};
use octo_core::{archive, lock, meta, sizes, thumbs};
use serde::Serialize;
use tauri::ipc::{Channel, Response};
use tauri::{Manager, State};

const TEXT_LIMIT: usize = 1024 * 1024;
const HEX_LIMIT: usize = 4096;
const MEDIA_LIMIT: u64 = 512 * 1024 * 1024;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDto {
    kind: &'static str,
    lang: Option<&'static str>,
    size: u64,
    text: Option<String>,
    /// Highlighted HTML, one string per line.
    lines: Option<Vec<String>>,
    /// Rendered Markdown.
    html: Option<String>,
    hex: Option<String>,
    truncated: bool,
    /// Number of entries, for archives.
    entries: Option<usize>,
    tags: BTreeMap<String, String>,
}

/// Reads the first `max` bytes of a real file or a file inside an archive.
fn read_head(path: &Path, max: usize) -> Result<(Vec<u8>, u64), String> {
    if let Some((file, inner)) = archive::split_path(path).filter(|(_, i)| !i.is_empty()) {
        let bytes = archive::read(&file, &inner, max).map_err(|e| e.to_string())?;
        let size = archive::entries(&file)
            .ok()
            .and_then(|all| all.iter().find(|e| e.path.eq_ignore_ascii_case(&inner)).map(|e| e.size))
            .unwrap_or(bytes.len() as u64);
        return Ok((bytes, size));
    }
    let f = File::open(path).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let mut buf = Vec::with_capacity((size as usize).min(max));
    f.take(max as u64).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok((buf, size))
}

/// Size of a real file or of a file inside an archive, without reading it.
fn file_size(path: &Path) -> Result<u64, String> {
    if let Some((file, inner)) = archive::split_path(path).filter(|(_, i)| !i.is_empty()) {
        let all = archive::entries(&file).map_err(|e| e.to_string())?;
        return all.iter().find(|e| e.path.eq_ignore_ascii_case(&inner)).map(|e| e.size).ok_or_else(|| "Not found in the archive".to_string());
    }
    std::fs::metadata(path).map(|m| m.len()).map_err(|e| e.to_string())
}

fn build_preview(path: &Path) -> Result<PreviewDto, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let kind = preview::classify(&name);
    let mut dto = PreviewDto { kind: kind.tag(), ..PreviewDto::default() };
    let in_archive = archive::split_path(path).is_some_and(|(_, i)| !i.is_empty());
    if !in_archive {
        dto.tags = meta::tags(path);
    }
    match kind {
        Kind::Code(_) | Kind::Markdown | Kind::Text => {
            let (bytes, size) = read_head(path, TEXT_LIMIT)?;
            dto.size = size;
            if preview::looks_binary(&bytes) {
                dto.kind = Kind::Binary.tag();
                dto.hex = Some(preview::hex_dump(&bytes[..bytes.len().min(HEX_LIMIT)]));
                dto.truncated = size as usize > HEX_LIMIT;
                return Ok(dto);
            }
            dto.truncated = size as usize > TEXT_LIMIT;
            let text = preview::decode_text(&bytes);
            match kind {
                Kind::Code(lang) => {
                    dto.lang = Some(lang);
                    dto.lines = preview::highlight::to_html_lines(lang, &text);
                }
                Kind::Markdown => dto.html = Some(preview::markdown::to_html(&text)),
                _ => {}
            }
            dto.text = Some(text);
        }
        Kind::Binary => {
            let (bytes, size) = read_head(path, HEX_LIMIT)?;
            dto.size = size;
            dto.truncated = size as usize > HEX_LIMIT;
            dto.hex = Some(preview::hex_dump(&bytes));
        }
        Kind::Archive => {
            if !in_archive {
                dto.size = std::fs::metadata(path).map_or(0, |m| m.len());
                dto.entries = archive::entries(path).ok().map(|a| a.len());
            }
        }
        _ => {
            dto.size = if in_archive { read_head(path, 0)?.1 } else { std::fs::metadata(path).map_or(0, |m| m.len()) };
        }
    }
    Ok(dto)
}

#[tauri::command]
pub async fn preview_file(path: PathBuf) -> Result<PreviewDto, String> {
    crate::off_main(move || build_preview(&path)).await
}

/// Whole file as raw bytes, for images, audio, video, PDF and 3D models.
#[tauri::command]
pub async fn read_bytes(path: PathBuf) -> Result<Response, String> {
    crate::off_main(move || {
        if file_size(&path)? > MEDIA_LIMIT {
            return Err("This file is too large to preview".to_string());
        }
        Ok(Response::new(read_head(&path, MEDIA_LIMIT as usize)?.0))
    })
    .await
}

#[tauri::command]
pub async fn thumbnail(path: PathBuf, size: u32, icon_only: bool) -> Result<Response, String> {
    crate::off_main(move || thumbs::thumbnail_png(&path, size, icon_only).map(Response::new).map_err(|e| e.to_string())).await
}

#[derive(Serialize)]
pub struct LockerDto {
    pid: u32,
    name: String,
    kind: &'static str,
}

#[tauri::command]
pub async fn who_locks(paths: Vec<PathBuf>) -> Result<Vec<LockerDto>, String> {
    crate::off_main(move || {
        lock::who_locks(&paths)
            .map(|v| v.into_iter().map(|l| LockerDto { pid: l.pid, name: l.name, kind: l.kind }).collect())
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn kill_process(pid: u32, paths: Vec<PathBuf>) -> Result<(), String> {
    crate::off_main(move || {
        // Only a process that holds these files right now may be ended.
        let lockers = lock::who_locks(&paths).map_err(|e| e.to_string())?;
        if !lockers.iter().any(|l| l.pid == pid) {
            return Err("That program is no longer locking these files".to_string());
        }
        lock::kill(pid).map_err(|e| e.to_string())
    })
    .await
}

/// Template tags (`exif:date`, `id3:artist`, …) for each file.
#[tauri::command]
pub async fn file_tags(paths: Vec<PathBuf>) -> Result<Vec<BTreeMap<String, String>>, String> {
    crate::off_main(move || Ok(paths.iter().map(|p| meta::tags(p)).collect())).await
}

#[derive(Default)]
pub struct SizesState {
    running: Mutex<HashMap<String, CancelToken>>,
}

#[derive(Serialize, Clone)]
pub struct SizeDto {
    name: String,
    bytes: u64,
    files: u64,
}

/// Streams the recursive size of each subfolder. A new call for the same tab
/// cancels the previous one; an empty `dir` only cancels.
#[tauri::command]
pub async fn folder_sizes(app: tauri::AppHandle, tab_id: String, dir: String, on_size: Channel<SizeDto>) -> Result<(), String> {
    let cancel = CancelToken::default();
    {
        let state: State<'_, SizesState> = app.state();
        let mut running = state.running.lock().map_err(|e| e.to_string())?;
        if let Some(prev) = running.insert(tab_id, cancel.clone()) {
            prev.cancel();
        }
    }
    if dir.is_empty() {
        return Ok(());
    }
    crate::off_main(move || {
        sizes::subfolder_sizes(Path::new(&dir), &cancel, |name, s| {
            let _ = on_size.send(SizeDto { name: name.to_string(), bytes: s.bytes, files: s.files });
        })
        .map_err(|e| e.to_string())
    })
    .await
}

/// Copies a file out of an archive to a temp folder and opens it.
#[tauri::command]
pub async fn extract_and_open(path: PathBuf) -> Result<(), String> {
    crate::off_main(move || {
        let (file, inner) = archive::split_path(&path).ok_or("That file is not inside an archive")?;
        if file_size(&path)? > MEDIA_LIMIT {
            return Err("This file is too large to open from the archive. Extract it first.".to_string());
        }
        let bytes = archive::read(&file, &inner, MEDIA_LIMIT as usize).map_err(|e| e.to_string())?;
        let name = path.file_name().ok_or("That file has no name")?;
        let stamp = blake3::hash(path.to_string_lossy().as_bytes()).to_hex();
        let dir = std::env::temp_dir().join("octopolis").join(&stamp.as_str()[..16]);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let out = dir.join(name);
        std::fs::write(&out, bytes).map_err(|e| e.to_string())?;
        octo_core::shell::open_path(&out).map_err(|e| e.to_string())
    })
    .await
}

#[derive(Serialize)]
pub struct GitDto {
    branch: Option<String>,
    /// Status letter per lower-case child name.
    children: HashMap<String, &'static str>,
}

/// Git status of a folder's children; null outside a repository.
#[tauri::command]
pub async fn git_status(dir: PathBuf) -> Result<Option<GitDto>, String> {
    crate::off_main(move || {
        Ok(octo_core::git::status(&dir).map(|s| GitDto {
            branch: s.branch,
            children: s.children.into_iter().map(|(k, v)| (k, v.letter())).collect(),
        }))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDto {
    time_ms: i64,
    author: String,
}

#[tauri::command]
pub async fn git_last_commits(dir: PathBuf) -> Result<HashMap<String, CommitDto>, String> {
    crate::off_main(move || {
        Ok(octo_core::git::last_commits(&dir)
            .unwrap_or_default()
            .into_iter()
            .map(|(k, c)| (k, CommitDto { time_ms: c.time_ms, author: c.author }))
            .collect())
    })
    .await
}

/// Shows the classic Windows menu. It runs on the UI thread because shell
/// menus need that thread's message loop.
#[tauri::command]
pub fn native_menu(window: tauri::WebviewWindow, paths: Vec<PathBuf>) -> Result<(), String> {
    let parent = |p: &PathBuf| p.parent().map(|d| d.to_string_lossy().to_lowercase());
    if paths.iter().any(|p| parent(p) != paths.first().and_then(parent)) {
        return Err("The Windows menu needs items from a single folder".to_string());
    }
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    window
        .run_on_main_thread(move || {
            let _ = octo_core::shell::show_native_menu(hwnd, &paths);
        })
        .map_err(|e| e.to_string())
}
