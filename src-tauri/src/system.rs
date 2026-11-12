//! Shell and system information commands.

use std::path::PathBuf;

use octo_core::clipboard;
use octo_core::shell::{self, DriveKind};
use serde::Serialize;

#[tauri::command]
pub async fn open_path(path: PathBuf) -> Result<(), String> {
    crate::off_main(move || shell::open_path(&path).map_err(|e| e.to_string())).await
}

/// Opens a file in `editor`, or the file type's editor (Notepad if none).
#[tauri::command]
pub async fn open_in_editor(path: PathBuf, editor: Option<String>) -> Result<(), String> {
    let editor = editor.map(|e| e.trim().trim_matches('"').to_string()).filter(|e| !e.is_empty()).map(PathBuf::from);
    crate::off_main(move || shell::edit_path(&path, editor.as_deref()).map_err(|e| e.to_string())).await
}

/// Opens a terminal window in a folder.
#[tauri::command]
pub async fn open_terminal_here(path: PathBuf) -> Result<(), String> {
    crate::off_main(move || {
        let dir = if path.is_dir() { path } else { path.parent().map(PathBuf::from).unwrap_or(path) };
        shell::open_terminal_at(&dir).map_err(|e| e.to_string())
    })
    .await
}

/// Shows the Windows folder picker and returns the chosen folder, or None if cancelled.
#[tauri::command]
pub async fn pick_folder_dialog(window: tauri::WebviewWindow, initial: Option<PathBuf>) -> Result<Option<String>, String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let res = shell::pick_folder(hwnd, initial.as_deref()).map_err(|e| e.to_string());
            let _ = tx.send(res);
        })
        .map_err(|e| e.to_string())?;
    let picked = crate::off_main(move || rx.recv().map_err(|e| e.to_string())).await??;
    Ok(picked.map(|p| p.to_string_lossy().into_owned()))
}

#[derive(Serialize)]
pub struct DetectedEditor {
    name: String,
    path: String,
}

/// Editors found on this PC, for the Editor setting.
#[tauri::command]
pub async fn detect_editors() -> Vec<DetectedEditor> {
    crate::off_main(|| Ok::<_, String>(octo_core::editors::detect().into_iter().map(|e| DetectedEditor { name: e.name, path: e.path.to_string_lossy().into_owned() }).collect()))
        .await
        .unwrap_or_default()
}

/// Keeps the PC awake while transfers run.
#[tauri::command]
pub fn set_keep_awake(on: bool) {
    shell::keep_awake(on);
}

/// A Windows notification, e.g. when a long transfer finishes in the background.
#[tauri::command]
pub fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn install_font(path: PathBuf) -> Result<(), String> {
    crate::off_main(move || shell::install_font(&path).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub fn reveal_in_explorer(path: PathBuf) -> Result<(), String> {
    shell::reveal_in_explorer(&path).map_err(|e| e.to_string())
}

/// Windows' "Open with" dialog. It is modal, so it runs on the UI thread.
#[tauri::command]
pub fn open_with(window: tauri::WebviewWindow, path: PathBuf) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    window
        .run_on_main_thread(move || {
            let _ = shell::open_with(hwnd, &path);
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn run_as_admin(path: PathBuf) -> Result<(), String> {
    crate::off_main(move || shell::run_as_admin(&path).map_err(|e| e.to_string())).await
}

#[derive(Serialize)]
pub struct ClipFilesDto {
    paths: Vec<String>,
    cut: bool,
    sequence: u32,
}

fn hwnd_of(window: &tauri::WebviewWindow) -> Result<isize, String> {
    Ok(window.hwnd().map_err(|e| e.to_string())?.0 as isize)
}

/// Puts files on the Windows clipboard; returns the clipboard's sequence
/// number afterwards, so the UI can tell later whether it is still current.
#[tauri::command]
pub async fn clipboard_write_files(window: tauri::WebviewWindow, paths: Vec<PathBuf>, cut: bool) -> Result<u32, String> {
    let owner = hwnd_of(&window)?;
    crate::off_main(move || {
        let effect = if cut { clipboard::ClipEffect::Move } else { clipboard::ClipEffect::Copy };
        clipboard::write_files(owner, &paths, effect).map_err(|e| e.to_string())?;
        Ok(clipboard::sequence())
    })
    .await
}

/// Files on the Windows clipboard (copied in Explorer or any other app) and
/// its sequence number. `paths` is empty when it holds no files.
#[tauri::command]
pub async fn clipboard_read_files(window: tauri::WebviewWindow) -> Result<ClipFilesDto, String> {
    let owner = hwnd_of(&window)?;
    crate::off_main(move || {
        let sequence = clipboard::sequence();
        let files = clipboard::read_files(owner).map_err(|e| e.to_string())?;
        Ok(match files {
            Some(f) => ClipFilesDto {
                paths: f.paths.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
                cut: f.effect == clipboard::ClipEffect::Move,
                sequence,
            },
            None => ClipFilesDto { paths: Vec::new(), cut: false, sequence },
        })
    })
    .await
}

/// Saves a picture (as PNG) or text from the clipboard as a new file in
/// `dest`. Returns the new file's path, or None when the clipboard holds neither.
#[tauri::command]
pub async fn paste_clipboard_as_file(window: tauri::WebviewWindow, dest: PathBuf) -> Result<Option<String>, String> {
    let owner = hwnd_of(&window)?;
    crate::off_main(move || {
        let stamp = jiff::Zoned::now().strftime("%Y-%m-%d %H%M%S").to_string();
        let (name, bytes) = if let Some(png) = clipboard::read_image_png(owner).map_err(|e| e.to_string())? {
            (format!("Screenshot {stamp}.png"), png)
        } else if let Some(text) = clipboard::read_text(owner).map_err(|e| e.to_string())? {
            // Windows line endings, so Notepad and other editors show the lines as copied.
            (format!("Pasted text {stamp}.txt"), text.replace("\r\n", "\n").replace('\n', "\r\n").into_bytes())
        } else {
            return Ok(None);
        };
        let path = octo_core::ops::create_file(&dest, &name, None).map_err(|e| e.to_string())?;
        if let Err(e) = std::fs::write(&path, bytes) {
            let _ = std::fs::remove_file(&path);
            return Err(e.to_string());
        }
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
}

#[tauri::command]
pub async fn clipboard_clear(window: tauri::WebviewWindow) -> Result<(), String> {
    let owner = hwnd_of(&window)?;
    crate::off_main(move || clipboard::clear(owner).map_err(|e| e.to_string())).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerModeDto {
    folders: bool,
    win_e: bool,
    /// The entries point at this copy of Octopolis.
    this_copy: bool,
    target: Option<String>,
    /// The opt-in "Open in Octopolis" right-click entry is set up.
    menu: bool,
}

fn explorer_mode_dto() -> ExplorerModeDto {
    let s = octo_core::explorer_mode::status();
    let exe = std::env::current_exe().ok().map(|p| p.to_string_lossy().to_lowercase());
    let this_copy = s.target.as_ref().is_some_and(|t| Some(t.to_lowercase()) == exe);
    let menu = octo_core::explorer_mode::menu_status().is_some();
    ExplorerModeDto { folders: s.folders, win_e: s.win_e, this_copy, target: s.target, menu }
}

#[tauri::command]
pub async fn explorer_mode_status() -> Result<ExplorerModeDto, String> {
    crate::off_main(|| Ok(explorer_mode_dto())).await
}

/// Turns "Use Octopolis instead of File Explorer" on or off (per-user, reversible).
#[tauri::command]
pub async fn explorer_mode_set(on: bool) -> Result<ExplorerModeDto, String> {
    crate::off_main(move || {
        if on {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            octo_core::explorer_mode::enable(&exe).map_err(|e| e.to_string())?;
        } else {
            octo_core::explorer_mode::disable().map_err(|e| e.to_string())?;
        }
        Ok(explorer_mode_dto())
    })
    .await
}

/// Adds or removes the "Open in Octopolis" entry in File Explorer's folder menu.
#[tauri::command]
pub async fn explorer_menu_set(on: bool) -> Result<ExplorerModeDto, String> {
    crate::off_main(move || {
        if on {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            octo_core::explorer_mode::enable_menu(&exe).map_err(|e| e.to_string())?;
        } else {
            octo_core::explorer_mode::disable_menu().map_err(|e| e.to_string())?;
        }
        Ok(explorer_mode_dto())
    })
    .await
}

/// If the entries point at an Octopolis that no longer exists (the app was
/// moved), points them at this copy so folders keep opening.
pub fn repair_explorer_mode() {
    if let Some(menu) = octo_core::explorer_mode::menu_status()
        && !std::path::Path::new(&menu).exists()
        && let Ok(exe) = std::env::current_exe()
    {
        let _ = octo_core::explorer_mode::enable_menu(&exe);
    }
    let s = octo_core::explorer_mode::status();
    let Some(target) = s.target else { return };
    if !(s.folders || s.win_e) || std::path::Path::new(&target).exists() {
        return;
    }
    if let Ok(exe) = std::env::current_exe() {
        let _ = octo_core::explorer_mode::enable(&exe);
    }
}

/// Opens a Windows shell location Octopolis can't show itself (Control Panel,
/// Network, `shell:` names) in File Explorer.
#[tauri::command]
pub fn open_in_explorer(target: String) -> Result<(), String> {
    let t = target.trim();
    let lower = t.to_ascii_lowercase();
    if !(lower.starts_with("shell:") || lower.starts_with("::{")) || t.contains(['"', '&', '|', '<', '>']) {
        return Err("only Windows shell locations are opened this way".into());
    }
    std::process::Command::new("explorer.exe").arg(t).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn eject_drive(root: PathBuf) -> Result<(), String> {
    crate::off_main(move || shell::eject_drive(&root).map_err(|e| e.to_string())).await
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

/// Opens the app data folder in Explorer, creating it first if needed.
#[tauri::command]
pub async fn open_data_folder(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::off_main(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        shell::open_path(&dir).map_err(|e| e.to_string())
    })
    .await
}

/// Plain-text diagnostics for bug reports. Never includes settings contents.
#[tauri::command]
pub async fn debug_info(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let version = app.package_info().version.to_string();
    let data_dir = app.path().app_data_dir().map(|p| p.display().to_string()).unwrap_or_else(|e| format!("unavailable ({e})"));
    crate::off_main(move || {
        let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|e| format!("unavailable ({e})"));
        let webview = tauri::webview_version().unwrap_or_else(|_| "unavailable".into());
        Ok(format!(
            "Octopolis {version}\nOS: {}\nWebView2: {webview}\nData folder: {data_dir}\nExecutable: {exe}",
            os_version()
        ))
    })
    .await
}

fn os_version() -> String {
    let mut cmd = std::process::Command::new("cmd");
    cmd.args(["/C", "ver"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Windows (unknown version)".into())
}

/// Runs a custom action's command line (already filled in) from `cwd`:
/// hidden, or in a new console window that stays open afterwards.
#[tauri::command]
pub async fn run_custom_action(command: String, cwd: PathBuf, console: bool) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("the action has no command".into());
    }
    crate::off_main(move || {
        let mut cmd = std::process::Command::new("cmd");
        cmd.current_dir(&cwd);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // The line goes to cmd exactly as written, so its own quoting is kept.
            cmd.raw_arg(format!("{} {command}", if console { "/K" } else { "/C" }));
            const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(if console { CREATE_NEW_CONSOLE } else { CREATE_NO_WINDOW });
        }
        #[cfg(not(windows))]
        cmd.arg("/C").arg(&command);
        cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
    })
    .await
}

/// Windows' "Map Network Drive" dialog (modal, so it runs on the UI thread).
#[tauri::command]
pub fn map_network_drive(window: tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    window
        .run_on_main_thread(move || {
            let _ = octo_core::network::map_drive_dialog(hwnd);
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn disconnect_network_drive(root: PathBuf, force: bool) -> Result<(), String> {
    crate::off_main(move || octo_core::network::disconnect_drive(&root, force).map_err(|e| e.to_string())).await
}

/// Roots of installed WSL distros (empty without WSL).
#[tauri::command]
pub async fn wsl_distros() -> Result<Vec<String>, String> {
    crate::off_main(|| Ok(octo_core::network::wsl_distros().into_iter().map(|p| p.to_string_lossy().into_owned()).collect())).await
}
