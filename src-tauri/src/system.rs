//! Shell and system information commands.

use std::path::PathBuf;

use octo_core::shell::{self, DriveKind};
use serde::Serialize;

#[tauri::command]
pub async fn open_path(path: PathBuf) -> Result<(), String> {
    crate::off_main(move || shell::open_path(&path).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub fn reveal_in_explorer(path: PathBuf) -> Result<(), String> {
    shell::reveal_in_explorer(&path).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveDto {
    root: String,
    label: String,
    file_system: String,
    kind: &'static str,
    total_bytes: u64,
    free_bytes: u64,
}

/// Drive queries can stall on sleeping network shares, so they run off the
/// main thread.
#[tauri::command]
pub async fn list_drives() -> Result<Vec<DriveDto>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        shell::list_drives()
            .into_iter()
            .map(|d| DriveDto {
                root: d.root.to_string_lossy().into_owned(),
                label: d.label,
                file_system: d.file_system,
                kind: match d.kind {
                    DriveKind::Fixed => "fixed",
                    DriveKind::Removable => "removable",
                    DriveKind::Network => "network",
                    DriveKind::Optical => "optical",
                    DriveKind::Ram => "ram",
                    DriveKind::Unknown => "unknown",
                },
                total_bytes: d.total_bytes,
                free_bytes: d.free_bytes,
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct KnownFolder {
    id: &'static str,
    label: &'static str,
    path: String,
}

/// Known-folder existence checks touch the disk (a redirected Documents folder
/// may live on a network share), so they run off the main thread.
#[tauri::command]
pub async fn known_folders() -> Result<Vec<KnownFolder>, String> {
    crate::off_main(|| Ok(collect_known_folders())).await
}

fn collect_known_folders() -> Vec<KnownFolder> {
    let entries: [(&str, &str, Option<PathBuf>); 7] = [
        ("home", "Home", dirs::home_dir()),
        ("desktop", "Desktop", dirs::desktop_dir()),
        ("documents", "Documents", dirs::document_dir()),
        ("downloads", "Downloads", dirs::download_dir()),
        ("pictures", "Pictures", dirs::picture_dir()),
        ("music", "Music", dirs::audio_dir()),
        ("videos", "Videos", dirs::video_dir()),
    ];
    entries
        .into_iter()
        .filter_map(|(id, label, path)| {
            let path = path.filter(|p| p.is_dir())?;
            Some(KnownFolder { id, label, path: path.to_string_lossy().into_owned() })
        })
        .collect()
}
