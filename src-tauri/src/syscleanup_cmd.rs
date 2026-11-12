//! System cleanup commands: scan the catalog, then clean what the user ticked.

use octo_core::ops;
use octo_core::syscleanup::{self, Dirs};
use serde::Serialize;
use tauri::AppHandle;

use crate::tools_cmd::{ScanState, begin_scan};

const SCAN_ID: &str = "system-cleanup";
const RECYCLE_BIN: &str = "recycle-bin";
const COMPONENT_STORE: &str = "component-store";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryDto {
    id: String,
    label: String,
    note: String,
    /// "safe", "recycle", "browsers", "developer" or "windows".
    group: String,
    admin: bool,
    report_only: bool,
    bytes: u64,
    files: u64,
    folders: Vec<String>,
    /// An action whose size can't be measured in advance.
    action: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDto {
    freed_bytes: u64,
    freed_files: u64,
    skipped_files: u64,
    errors: Vec<String>,
}

fn dirs(app: &AppHandle) -> Dirs {
    let mut dirs = Dirs::from_env();
    dirs.app_updates = crate::cache_cmd::resolve_cache_dir(app).ok().map(|d| d.join("updates"));
    dirs
}

fn text(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Sizes every category, plus the Recycle Bin. Nothing is deleted.
#[tauri::command]
pub async fn system_cleanup_scan(app: AppHandle, state: tauri::State<'_, ScanState>) -> Result<Vec<CategoryDto>, String> {
    let cancel = begin_scan(&state, SCAN_ID);
    crate::off_main(move || {
        let dirs = dirs(&app);
        let mut out: Vec<CategoryDto> = syscleanup::scan(&dirs, &cancel)
            .into_iter()
            .map(|r| CategoryDto {
                id: r.id.into(),
                label: r.label.into(),
                note: r.note.into(),
                group: r.group.as_str().into(),
                admin: r.admin,
                report_only: r.report_only,
                bytes: r.bytes,
                files: r.files,
                folders: r.folders.iter().map(|p| text(p)).collect(),
                action: false,
            })
            .collect();
        if cancel.is_cancelled() {
            return Err("cancelled".into());
        }
        let bin = ops::list_bin().unwrap_or_default();
        out.push(CategoryDto {
            id: RECYCLE_BIN.into(),
            label: "Recycle Bin".into(),
            note: "Everything you deleted that is still waiting in the Recycle Bin, on every drive.".into(),
            group: "recycle".into(),
            admin: false,
            report_only: false,
            bytes: bin.iter().filter_map(|i| i.size).sum(),
            files: bin.len() as u64,
            folders: Vec::new(),
            action: false,
        });
        out.push(CategoryDto {
            id: COMPONENT_STORE.into(),
            label: "Windows component store".into(),
            note: "Runs Windows' own cleanup of superseded update files (DISM). It can take several minutes, and the size freed isn't known in advance.".into(),
            group: "windows".into(),
            admin: true,
            report_only: false,
            bytes: 0,
            files: 0,
            folders: Vec::new(),
            action: true,
        });
        Ok(out)
    })
    .await
}

#[tauri::command]
pub fn system_cleanup_cancel(state: tauri::State<'_, ScanState>) {
    crate::tools_cmd::cancel_scan(state, SCAN_ID.into());
}

/// Runs the script elevated and waits. Fails if the user declines the prompt.
fn run_elevated(script: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let encoded = syscleanup::encode_powershell(script);
    let command = format!("try {{ Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ErrorAction Stop -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','{encoded}' }} catch {{ exit 1 }}");
    let status = std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &command]).creation_flags(CREATE_NO_WINDOW).status().map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err("Administrator rights were not granted, so the Windows items were left alone".into()) }
}

/// Cleans the given categories by id. Ids outside the catalog are ignored.
#[tauri::command]
pub async fn system_cleanup_run(app: AppHandle, state: tauri::State<'_, ScanState>, ids: Vec<String>) -> Result<RunDto, String> {
    let cancel = begin_scan(&state, SCAN_ID);
    crate::off_main(move || {
        let dirs = dirs(&app);
        let mut run = RunDto { freed_bytes: 0, freed_files: 0, skipped_files: 0, errors: Vec::new() };

        let tally = syscleanup::clean(&ids, &dirs, &cancel);
        run.freed_bytes += tally.bytes;
        run.freed_files += tally.files;
        run.skipped_files += tally.skipped;

        if ids.iter().any(|i| i == RECYCLE_BIN) {
            let bytes: u64 = ops::list_bin().map(|b| b.iter().filter_map(|i| i.size).sum()).unwrap_or(0);
            match ops::empty_bin() {
                Ok(count) => {
                    run.freed_bytes += bytes;
                    run.freed_files += count as u64;
                }
                Err(e) => run.errors.push(format!("Recycle Bin: {e}")),
            }
        }

        let admin: Vec<String> = ids.iter().filter(|i| i.as_str() == COMPONENT_STORE || syscleanup::category(i).is_some_and(|c| c.admin && !c.report_only)).cloned().collect();
        if !admin.is_empty() {
            let before = syscleanup::measure(&admin, &dirs, &cancel);
            match run_elevated(&syscleanup::admin_script(&admin, &dirs)) {
                Ok(()) => run.freed_bytes += before.saturating_sub(syscleanup::measure(&admin, &dirs, &cancel)),
                Err(e) => run.errors.push(e),
            }
        }
        Ok(run)
    })
    .await
}
