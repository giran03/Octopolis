//! Image tools: similar-picture search and batch resize / convert.

use std::path::PathBuf;

use octo_core::imgtools::{self, ConvertOptions, Format};
use serde::Serialize;

use crate::tools_cmd::{DupeGroupDto, ScanState, begin_scan};

/// Groups of pictures that look alike under `root`. Progress is (pictures read, pictures found).
#[tauri::command]
pub async fn find_similar_images(
    state: tauri::State<'_, ScanState>,
    id: String,
    root: PathBuf,
    max_distance: u32,
    on_progress: tauri::ipc::Channel<(u64, u64)>,
) -> Result<Vec<DupeGroupDto>, String> {
    let cancel = begin_scan(&state, &id);
    crate::off_main(move || {
        let last = std::sync::Mutex::new(std::time::Instant::now());
        let progress = |done: u64, total: u64| {
            let mut t = last.lock().unwrap_or_else(|e| e.into_inner());
            if t.elapsed().as_millis() >= 100 || done == total {
                *t = std::time::Instant::now();
                let _ = on_progress.send((done, total));
            }
        };
        let groups = imgtools::find_similar(&root, max_distance.min(16), &cancel, &progress).map_err(|e| e.to_string())?;
        if cancel.is_cancelled() {
            return Err("cancelled".into());
        }
        Ok(groups.into_iter().map(|g| DupeGroupDto::new(g.size, g.files.into_iter().map(|f| (f.path.to_string_lossy().into_owned(), f.modified_ms)).collect())).collect())
    })
    .await
}

#[derive(Serialize)]
pub struct ConvertResult {
    created: Vec<String>,
    errors: Vec<String>,
}

/// Writes resized and/or converted copies of the pictures. Originals are never changed.
/// With no `out_dir`, each copy goes next to its original.
#[tauri::command]
pub async fn convert_images(paths: Vec<PathBuf>, max_edge: Option<u32>, format: Option<String>, quality: u8, out_dir: Option<PathBuf>) -> Result<ConvertResult, String> {
    let format = match format.as_deref() {
        None | Some("") | Some("same") => None,
        Some(f) => Some(Format::parse(f).ok_or_else(|| format!("unknown format {f}"))?),
    };
    crate::off_main(move || {
        let opts = ConvertOptions { max_edge, format, quality };
        let mut result = ConvertResult { created: Vec::new(), errors: Vec::new() };
        for path in paths.iter().filter(|p| imgtools::is_image(p)) {
            let dir = out_dir.clone().or_else(|| path.parent().map(PathBuf::from)).unwrap_or_default();
            match imgtools::convert(path, &dir, opts) {
                Ok(out) => result.created.push(out.to_string_lossy().into_owned()),
                Err(e) => result.errors.push(e.to_string()),
            }
        }
        Ok(result)
    })
    .await
}
