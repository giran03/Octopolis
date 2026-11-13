//! Google Fonts for the interface: download a family, keep it for this session, and optionally save it on this PC.
//!
//! Downloaded fonts never touch the page's network access: the app fetches them here and hands the bytes to the
//! page. Saved fonts live in `<app data>/fonts/<family>/` so they load offline and can be removed with the app.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use octo_core::fonts::{self, Face};
use octo_core::shell;
use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, State};

const FONTS_DIR: &str = "fonts";
const META_FILE: &str = "meta.json";
const MAX_FILE_BYTES: u64 = 3 * 1024 * 1024;
const MAX_CSS_BYTES: u64 = 256 * 1024;
/// Google serves woff2 files to browsers it recognises.
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FaceMeta {
    file: String,
    weight: String,
    style: String,
    subset: String,
    range: String,
    size: usize,
}

struct Loaded {
    meta: FaceMeta,
    bytes: Vec<u8>,
}

/// Fonts downloaded this session and not (yet) saved.
#[derive(Default)]
pub struct FontsState {
    session: Mutex<HashMap<String, Vec<Loaded>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontInfo {
    faces: Vec<FaceMeta>,
    saved: bool,
    bytes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFont {
    family: String,
    bytes: u64,
}

fn fonts_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(FONTS_DIR))
}

fn family_dir(app: &AppHandle, family: &str) -> Result<PathBuf, String> {
    if !fonts::valid_family(family) {
        return Err("That isn't a valid font name".into());
    }
    Ok(fonts_root(app)?.join(family.trim()))
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_recv_body(Some(Duration::from_secs(30)))
        .user_agent(BROWSER_UA)
        .build()
        .into()
}

fn get_css(agent: &ureq::Agent, family: &str) -> Result<Vec<Face>, String> {
    let mut last = String::from("Google Fonts has no font with that name");
    for weights in fonts::WEIGHT_TRIES {
        match agent.get(&fonts::css_url(family, *weights)).call() {
            Ok(mut resp) => {
                let css = resp.body_mut().with_config().limit(MAX_CSS_BYTES).read_to_string().map_err(|e| e.to_string())?;
                let faces = fonts::parse_css(&css);
                if !faces.is_empty() {
                    return Ok(faces);
                }
            }
            Err(ureq::Error::StatusCode(400 | 404)) => last = "Google Fonts has no font with that name, or not in those weights".into(),
            Err(e) => return Err(format!("Couldn't reach Google Fonts: {e}")),
        }
    }
    Err(last)
}

fn download(family: &str) -> Result<Vec<Loaded>, String> {
    let agent = agent();
    let faces = get_css(&agent, family)?;
    let mut out = Vec::new();
    for face in faces {
        let mut resp = agent.get(&face.url).call().map_err(|e| format!("Couldn't download the font: {e}"))?;
        let bytes = resp.body_mut().with_config().limit(MAX_FILE_BYTES).read_to_vec().map_err(|e| e.to_string())?;
        let meta = FaceMeta { file: fonts::face_file_name(&face), weight: face.weight, style: face.style, subset: face.subset, range: face.range, size: bytes.len() };
        out.push(Loaded { meta, bytes });
    }
    Ok(out)
}

fn read_saved(dir: &Path) -> Option<Vec<FaceMeta>> {
    let text = fs::read_to_string(dir.join(META_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

fn info(faces: Vec<FaceMeta>, saved: bool) -> FontInfo {
    let bytes = faces.iter().map(|f| f.size).sum();
    FontInfo { faces, saved, bytes }
}

/// The files of a family: the saved copy if there is one, else this session's download, else (when allowed) a fresh download.
#[tauri::command]
pub async fn google_font_faces(app: AppHandle, state: State<'_, FontsState>, family: String, allow_download: bool) -> Result<FontInfo, String> {
    let dir = family_dir(&app, &family)?;
    if let Some(faces) = read_saved(&dir) {
        return Ok(info(faces, true));
    }
    let key = family.trim().to_string();
    if let Some(list) = state.session.lock().map_err(|e| e.to_string())?.get(&key) {
        return Ok(info(list.iter().map(|l| l.meta.clone()).collect(), false));
    }
    if !allow_download {
        return Err("This font isn't saved on this device".into());
    }
    let fetched = tauri::async_runtime::spawn_blocking(move || download(&family)).await.map_err(|e| e.to_string())??;
    let result = info(fetched.iter().map(|l| l.meta.clone()).collect(), false);
    state.session.lock().map_err(|e| e.to_string())?.insert(key, fetched);
    Ok(result)
}

/// One font file as raw bytes.
#[tauri::command]
pub async fn google_font_bytes(app: AppHandle, state: State<'_, FontsState>, family: String, file: String) -> Result<Response, String> {
    if file.contains(['/', '\\']) || !file.ends_with(".woff2") {
        return Err("Not a font file".into());
    }
    if let Some(l) = state.session.lock().map_err(|e| e.to_string())?.get(family.trim()).and_then(|v| v.iter().find(|l| l.meta.file == file)) {
        return Ok(Response::new(l.bytes.clone()));
    }
    let path = family_dir(&app, &family)?.join(&file);
    let bytes = crate::off_main(move || fs::read(&path).map_err(|e| e.to_string())).await?;
    Ok(Response::new(bytes))
}

/// Saves this session's download of a family on this PC.
#[tauri::command]
pub async fn google_font_save(app: AppHandle, state: State<'_, FontsState>, family: String) -> Result<FontInfo, String> {
    let dir = family_dir(&app, &family)?;
    let session = state.session.lock().map_err(|e| e.to_string())?;
    let list = session.get(family.trim()).ok_or("Download the font first")?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for l in list {
        fs::write(dir.join(&l.meta.file), &l.bytes).map_err(|e| e.to_string())?;
    }
    let metas: Vec<FaceMeta> = list.iter().map(|l| l.meta.clone()).collect();
    fs::write(dir.join(META_FILE), serde_json::to_string_pretty(&metas).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(info(metas, true))
}

/// Deletes a saved family (and forgets this session's copy).
#[tauri::command]
pub async fn google_font_remove(app: AppHandle, state: State<'_, FontsState>, family: String) -> Result<(), String> {
    let dir = family_dir(&app, &family)?;
    state.session.lock().map_err(|e| e.to_string())?.remove(family.trim());
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Every font saved on this PC, with its size on disk.
#[tauri::command]
pub async fn google_fonts_saved(app: AppHandle) -> Result<Vec<SavedFont>, String> {
    let root = fonts_root(&app)?;
    crate::off_main(move || {
        let mut out = Vec::new();
        if let Ok(read) = fs::read_dir(&root) {
            for entry in read.flatten().filter(|e| e.path().join(META_FILE).is_file()) {
                let bytes = fs::read_dir(entry.path()).map(|r| r.flatten().filter_map(|f| f.metadata().ok()).map(|m| m.len()).sum()).unwrap_or(0);
                out.push(SavedFont { family: entry.file_name().to_string_lossy().into_owned(), bytes });
            }
        }
        out.sort_by_key(|f| f.family.to_lowercase());
        Ok(out)
    })
    .await
}

/// Opens the folder where saved fonts live.
#[tauri::command]
pub async fn open_fonts_folder(app: AppHandle) -> Result<(), String> {
    let root = fonts_root(&app)?;
    crate::off_main(move || {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        shell::open_path(&root).map_err(|e| e.to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs the network: `cargo test -p octopolis -- --ignored --nocapture google_download`.
    #[test]
    #[ignore]
    fn google_download_gets_latin_faces() {
        for family in ["Inter", "Open Sans", "Pacifico"] {
            let faces = download(family).unwrap_or_else(|e| panic!("{family}: {e}"));
            assert!(!faces.is_empty());
            println!("{family}: {} files, {} bytes, weights {:?}", faces.len(), faces.iter().map(|f| f.bytes.len()).sum::<usize>(), faces.iter().map(|f| f.meta.weight.clone()).collect::<Vec<_>>());
            assert!(faces.iter().all(|f| f.bytes.starts_with(b"wOF2")));
        }
        assert!(download("Not A Real Font Name").is_err());
    }
}
