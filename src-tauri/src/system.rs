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

/// Opens several files with their own apps in one go. Returns a message for each one that could not be opened.
#[tauri::command]
pub async fn open_paths(paths: Vec<PathBuf>) -> Result<Vec<String>, String> {
    crate::off_main(move || {
        let failed = paths
            .iter()
            .filter_map(|p| shell::open_path(p).err().map(|e| format!("{}: {e}", p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())))
            .collect();
        Ok(failed)
    })
    .await
}

/// Opens several files in an editor at once: one launch of the chosen editor with all of them.
#[tauri::command]
pub async fn open_in_editor_many(paths: Vec<PathBuf>, editor: Option<String>) -> Result<(), String> {
    let editor = editor.map(|e| e.trim().trim_matches('"').to_string()).filter(|e| !e.is_empty()).map(PathBuf::from);
    crate::off_main(move || shell::edit_paths(&paths, editor.as_deref()).map_err(|e| e.to_string())).await
}

/// For each path, whether it is a folder (false for files and for paths that can't be read).
#[tauri::command]
pub async fn paths_are_dirs(paths: Vec<PathBuf>) -> Result<Vec<bool>, String> {
    crate::off_main(move || Ok(paths.iter().map(|p| p.is_dir()).collect())).await
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
pub async fn run_path(path: PathBuf) -> Result<(), String> {
    crate::off_main(move || shell::run_path(&path).map_err(|e| e.to_string())).await
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

#[cfg(windows)]
#[link(name = "dwmapi")]
unsafe extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: *mut core::ffi::c_void,
        attr: u32,
        value: *const core::ffi::c_void,
        size: u32,
    ) -> i32;
}

/// Sets the Windows 11 DWM corner preference for the main app window.
#[tauri::command]
pub fn set_window_corners(window: tauri::WebviewWindow, mode: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
        let pref: u32 = match mode.as_str() {
            "square" => 1,  // DWMWCP_DONOTROUND
            "rounded" => 2, // DWMWCP_ROUND
            "small" => 3,   // DWMWCP_ROUNDSMALL
            _ => 0,         // DWMWCP_DEFAULT
        };
        let hwnd = hwnd_of(&window)?;
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd as *mut core::ffi::c_void,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                (&pref as *const u32).cast(),
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
    let _ = (&window, &mode);
    Ok(())
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
pub async fn explorer_mode_set(app: tauri::AppHandle, on: bool) -> Result<ExplorerModeDto, String> {
    crate::off_main(move || {
        if on {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            octo_core::explorer_mode::enable(&exe).map_err(|e| e.to_string())?;
        } else {
            octo_core::explorer_mode::disable().map_err(|e| e.to_string())?;
        }
        // "Show in folder" follows the same switch.
        crate::shellwin_cmd::apply(&app);
        crate::catch_cmd::apply(&app);
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
    // This File Explorer window is wanted: the optional catcher must not hand it back to Octopolis.
    octo_core::explorer_catch::pause(std::time::Duration::from_secs(5));
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

/// The folders whose Windows icons can be borrowed by other folders (the colored Documents, Downloads, 3D Objects
/// and so on). Only the ones that exist on this PC are listed.
#[tauri::command]
pub async fn folder_icon_styles() -> Result<Vec<KnownFolder>, String> {
    crate::off_main(|| Ok(collect_icon_styles())).await
}

fn collect_icon_styles() -> Vec<KnownFolder> {
    let home = dirs::home_dir();
    let under = |name: &str| home.as_ref().map(|h| h.join(name));
    let onedrive = std::env::var_os("OneDrive").or_else(|| std::env::var_os("OneDriveConsumer")).map(PathBuf::from);
    let entries: Vec<(&'static str, &'static str, Option<PathBuf>)> = vec![
        ("documents", "Documents", dirs::document_dir()),
        ("downloads", "Downloads", dirs::download_dir()),
        ("desktop", "Desktop", dirs::desktop_dir()),
        ("pictures", "Pictures", dirs::picture_dir()),
        ("music", "Music", dirs::audio_dir()),
        ("videos", "Videos", dirs::video_dir()),
        ("3dobjects", "3D Objects", under("3D Objects")),
        ("favorites", "Favorites", under("Favorites")),
        ("links", "Links", under("Links")),
        ("contacts", "Contacts", under("Contacts")),
        ("searches", "Searches", under("Searches")),
        ("savedgames", "Saved Games", under("Saved Games")),
        ("onedrive", "OneDrive", onedrive),
        ("user", "User folder", home.clone()),
    ];
    entries
        .into_iter()
        .filter_map(|(id, label, path)| {
            let path = path.filter(|p| p.is_dir())?;
            Some(KnownFolder { id, label, path: path.to_string_lossy().into_owned() })
        })
        .collect()
}

#[derive(Serialize)]
pub struct IconFile {
    dll: &'static str,
    count: u32,
}

#[derive(Serialize)]
pub struct StartApp {
    id: String,
    label: String,
}

#[derive(Serialize)]
pub struct IconCatalog {
    resources: Vec<IconFile>,
    apps: Vec<StartApp>,
}

/// The apps in the Start menu: name and the id Windows knows them by (what `shell:AppsFolder\<id>` opens).
fn start_apps() -> Vec<StartApp> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let out = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | Sort-Object Name | ForEach-Object { $_.Name + [char]9 + $_.AppID }"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let Ok(out) = out else { return Vec::new() };
        let text = String::from_utf8_lossy(&out.stdout);
        let mut seen = std::collections::HashSet::new();
        // The explicit return keeps the cfg(not(windows)) fallback below reachable on other targets.
        #[allow(clippy::needless_return)]
        return text
            .lines()
            .filter_map(|l| l.split_once('\t'))
            .map(|(label, id)| (label.trim().to_string(), id.trim().to_string()))
            // Store apps and programs only: not the shortcuts to web pages, help files and uninstallers the Start menu also holds.
            .filter(|(label, id)| {
                let lower = id.to_ascii_lowercase();
                !label.is_empty() && octo_core::thumbs::is_app_id(id) && (id.contains('!') || lower.ends_with(".exe")) && !label.to_lowercase().contains("uninstall") && seen.insert(id.clone())
            })
            .map(|(label, id)| StartApp { id, label })
            .collect();
    }
    #[cfg(not(windows))]
    Vec::new()
}

/// Every icon Windows offers to borrow beyond the special folders: the apps in the Start menu, and the icons
/// inside the system's own icon files. Asked for when the icon picker opens, since listing apps takes a moment.
#[tauri::command]
pub async fn system_icon_catalog() -> Result<IconCatalog, String> {
    crate::off_main(|| {
        let resources = octo_core::thumbs::ICON_DLLS
            .iter()
            .map(|dll| IconFile { dll, count: octo_core::thumbs::resource_icon_count(dll) })
            .filter(|f| f.count > 0)
            .collect();
        Ok(IconCatalog { resources, apps: start_apps() })
    })
    .await
}

/// Whether a folder is a repository or sits anywhere inside one: it, or a folder above it, holds a .git, .hg or .svn.
#[tauri::command]
pub async fn inside_repository(path: PathBuf) -> Result<bool, String> {
    crate::off_main(move || Ok(is_inside_repository(&path))).await
}

fn is_inside_repository(path: &std::path::Path) -> bool {
    path.ancestors().any(|p| [".git", ".hg", ".svn"].iter().any(|m| p.join(m).exists()))
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

/// Standard base64 (with padding), for PowerShell's `-EncodedCommand`.
fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// A PowerShell script as the text `-EncodedCommand` expects: base64 of UTF-16LE, so no quoting can go wrong.
fn ps_encode(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64(&bytes)
}

/// The arguments for the shell that runs an action: `/C` or `/K` for cmd; for PowerShell the script travels encoded,
/// so quotes in it reach PowerShell untouched.
fn shell_args(command: &str, powershell: bool, console: bool) -> String {
    if powershell {
        format!("-NoProfile -ExecutionPolicy Bypass {}-EncodedCommand {}", if console { "-NoExit " } else { "" }, ps_encode(command))
    } else {
        format!("{} {command}", if console { "/K" } else { "/C" })
    }
}

/// The script that starts an action with the administrator prompt, waiting for it to finish.
fn elevated_script(exe: &str, args: &str, cwd: &str, console: bool) -> String {
    let q = |s: &str| s.replace('\'', "''");
    format!(
        "Start-Process -FilePath '{}' -ArgumentList '{}' -WorkingDirectory '{}' -Verb RunAs {}-Wait",
        q(exe),
        q(args),
        q(cwd),
        if console { "" } else { "-WindowStyle Hidden " }
    )
}

#[cfg(windows)]
fn launch_action(command: &str, cwd: &std::path::Path, console: bool, powershell: bool, elevate: bool, wait: bool) -> Result<Option<i32>, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let exe = if powershell { "powershell.exe" } else { "cmd.exe" };
    let args = shell_args(command, powershell, console);
    let mut cmd;
    if elevate {
        let script = elevated_script(exe, &args, &cwd.to_string_lossy(), console);
        cmd = std::process::Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", &ps_encode(&script)]);
        cmd.creation_flags(CREATE_NO_WINDOW);
    } else {
        cmd = std::process::Command::new(exe);
        cmd.current_dir(cwd);
        // The line goes to the shell exactly as written, so its own quoting is kept.
        cmd.raw_arg(&args);
        cmd.creation_flags(if console { CREATE_NEW_CONSOLE } else { CREATE_NO_WINDOW });
    }
    if wait && !console {
        let status = cmd.status().map_err(|e| e.to_string())?;
        if elevate && !status.success() {
            return Err("it didn't run (was the administrator prompt declined?)".into());
        }
        Ok(status.code())
    } else {
        cmd.spawn().map(|_| None).map_err(|e| e.to_string())
    }
}

#[cfg(not(windows))]
fn launch_action(command: &str, cwd: &std::path::Path, _console: bool, _powershell: bool, _elevate: bool, _wait: bool) -> Result<Option<i32>, String> {
    std::process::Command::new("cmd").current_dir(cwd).arg("/C").arg(command).spawn().map(|_| None).map_err(|e| e.to_string())
}

/// Runs a custom action's command line (already filled in) from `cwd`, in cmd or PowerShell, optionally elevated.
/// Hidden runs can be waited for and return the exit code; console runs stay open for the user and return at once.
#[tauri::command]
pub async fn run_custom_action(command: String, cwd: PathBuf, console: bool, shell: String, elevate: bool, wait: bool) -> Result<Option<i32>, String> {
    if command.trim().is_empty() {
        return Err("the action has no command".into());
    }
    crate::off_main(move || launch_action(&command, &cwd, console, shell == "powershell", elevate, wait)).await
}

/// Saves a list of paths, one per line, in a temp file, so an action can read a selection too long for a command line.
#[tauri::command]
pub async fn write_temp_list(paths: Vec<String>) -> Result<String, String> {
    crate::off_main(move || {
        let dir = std::env::temp_dir().join("octopolis-actions");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // Old lists are not needed any more.
        if let Ok(read) = std::fs::read_dir(&dir) {
            for f in read.flatten() {
                let old = f.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age.as_secs() > 24 * 3600);
                if old {
                    let _ = std::fs::remove_file(f.path());
                }
            }
        }
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let file = dir.join(format!("list-{stamp}.txt"));
        std::fs::write(&file, paths.join("\r\n")).map_err(|e| e.to_string())?;
        Ok(file.to_string_lossy().into_owned())
    })
    .await
}

/// Whether a program can be found: a full path that exists, or a name on PATH (with the usual extensions).
fn find_program(name: &str) -> bool {
    let name = name.trim().trim_matches('"');
    if name.is_empty() {
        return false;
    }
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .filter(|e| !e.is_empty())
        .map(str::to_string)
        .collect();
    let with_ext = |base: PathBuf| -> bool { base.is_file() || exts.iter().any(|e| PathBuf::from(format!("{}{}", base.display(), e)).is_file()) };
    let path = std::path::Path::new(name);
    if path.is_absolute() || name.contains(['\\', '/']) {
        return with_ext(path.to_path_buf());
    }
    std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|dir| with_ext(dir.join(name))))
}

#[tauri::command]
pub async fn program_exists(name: String) -> bool {
    crate::off_main(move || Ok(find_program(&name))).await.unwrap_or(false)
}

#[cfg(test)]
mod action_tests {
    use super::*;

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn powershell_encoding_is_utf16_base64() {
        assert_eq!(ps_encode("a"), "YQA=");
        assert_eq!(ps_encode("hi"), "aABpAA==");
    }

    #[test]
    fn builds_shell_arguments() {
        assert_eq!(shell_args("dir", false, false), "/C dir");
        assert_eq!(shell_args("dir", false, true), "/K dir");
        assert_eq!(shell_args("a", true, false), "-NoProfile -ExecutionPolicy Bypass -EncodedCommand YQA=");
        assert!(shell_args("a", true, true).contains("-NoExit -EncodedCommand"));
    }

    #[test]
    fn elevated_script_escapes_quotes_and_hides_unless_console() {
        let s = elevated_script("cmd.exe", "/C echo 'hi'", "C:\\it's", false);
        assert!(s.contains("-ArgumentList '/C echo ''hi'''"));
        assert!(s.contains("-WorkingDirectory 'C:\\it''s'"));
        assert!(s.contains("-WindowStyle Hidden -Wait"));
        assert!(!elevated_script("cmd.exe", "/K x", "C:\\", true).contains("Hidden"));
    }

    #[test]
    fn finds_system_programs() {
        assert!(find_program("cmd"));
        assert!(find_program("powershell"));
        assert!(!find_program("definitely-not-a-real-program-xyz"));
        assert!(!find_program(""));
    }
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

#[cfg(all(test, windows))]
mod catalog_tests {
    use super::*;

    /// Machine-specific (needs a Start menu): `cargo test -p octopolis -- --ignored --nocapture start_apps`.
    #[test]
    #[ignore]
    fn start_apps_have_icons() {
        let apps = start_apps();
        println!("{} apps", apps.len());
        assert!(!apps.is_empty());
        for a in apps.iter().take(5) {
            let path = std::path::PathBuf::from(format!("shell:AppsFolder\\{}", a.id));
            let png = octo_core::thumbs::thumbnail_png(&path, 64, true);
            println!("{} | {} | {}", a.label, a.id, png.as_ref().map_or_else(|e| format!("ERR {e}"), |p| format!("{} bytes", p.len())));
        }
    }
}

#[cfg(test)]
mod repo_tests {
    use super::*;

    #[test]
    fn finds_repositories_and_their_subfolders() {
        let root = std::env::temp_dir().join(format!("octo-repo-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let deep = root.join("repo").join("docs").join("shots");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::create_dir_all(root.join("repo").join(".git")).unwrap();
        std::fs::create_dir_all(root.join("plain").join("pics")).unwrap();
        assert!(is_inside_repository(&root.join("repo")));
        assert!(is_inside_repository(&deep));
        // A .git file (worktrees and submodules) counts too.
        std::fs::write(root.join("plain").join(".git"), "gitdir: x").unwrap();
        assert!(is_inside_repository(&root.join("plain").join("pics")));
        std::fs::remove_file(root.join("plain").join(".git")).unwrap();
        assert!(!is_inside_repository(&root.join("plain").join("pics")) || root.ancestors().any(|p| p.join(".git").exists()));
        let _ = std::fs::remove_dir_all(&root);
    }
}
