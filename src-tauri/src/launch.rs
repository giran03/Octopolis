//! Launch handling: paths passed on the command line, a single running copy
//! (later launches hand their paths over and quit), and the tray icon.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};

/// Event the UI listens for: a later launch asked to open these paths.
pub const OPEN_PATHS_EVENT: &str = "octopolis://open-paths";

#[derive(Default)]
pub struct LaunchState {
    /// Paths from the first launch, taken once by the UI.
    startup: Mutex<Vec<String>>,
    /// Closing the window hides it to the tray instead of quitting.
    keep_in_tray: AtomicBool,
}

/// Turns command-line arguments into absolute paths to open. Explorer-style
/// switches (`/e,`, `/n`, `/root,`) are ignored and `/select,X` opens `X`;
/// other dash or slash options are skipped. Relative paths resolve against `cwd`.
pub fn launch_targets(args: &[String], cwd: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for raw in args {
        let arg = raw.trim().trim_matches('"');
        if arg.is_empty() {
            continue;
        }
        let lower = arg.to_ascii_lowercase();
        let path = if let Some(rest) = lower.strip_prefix("/select,") {
            &arg[arg.len() - rest.len()..]
        } else if lower.starts_with("shell:") || lower.starts_with("::{") {
            // Known-folder names and shell objects are resolved by the UI side.
            out.push(arg.to_string());
            continue;
        } else if arg.starts_with('-') || (arg.starts_with('/') && !arg.starts_with("//")) {
            continue;
        } else {
            arg
        };
        let p = PathBuf::from(path.trim_matches('"'));
        let abs = if p.is_absolute() || path.starts_with("\\\\") { p } else { cwd.join(p) };
        out.push(abs.to_string_lossy().into_owned());
    }
    out
}

/// Paths given when Octopolis was started; empty after the first call.
#[tauri::command]
pub fn startup_paths(state: State<'_, LaunchState>) -> Vec<String> {
    std::mem::take(&mut *state.startup.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Turns tray mode on or off: when on, closing the window keeps Octopolis
/// running in the notification area so it reopens instantly.
#[tauri::command]
pub fn set_keep_in_tray(app: AppHandle, state: State<'_, LaunchState>, on: bool) -> Result<(), String> {
    state.keep_in_tray.store(on, Ordering::Relaxed);
    let tray = app.tray_by_id(TRAY_ID);
    match (on, tray) {
        (true, None) => build_tray(&app).map_err(|e| e.to_string()),
        (false, Some(_)) => {
            let _ = app.remove_tray_by_id(TRAY_ID);
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Sets the summon shortcut: "off", "ctrlE" (desktop and taskbar only) or
/// "ctrlAltE" (anywhere; pressed while Octopolis is in front, it hides it).
#[tauri::command]
pub fn set_summon(app: AppHandle, mode: String) {
    let summon = octo_core::hotkey::Summon::parse(&mode);
    let handle = app.clone();
    octo_core::hotkey::set(summon, move || {
        let Some(w) = handle.get_webview_window("main") else { return };
        let in_front = w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false);
        if in_front && summon == octo_core::hotkey::Summon::CtrlAltE {
            let keep = handle.state::<LaunchState>().keep_in_tray.load(Ordering::Relaxed);
            let _ = if keep { w.hide() } else { w.minimize() };
        } else {
            show_main(&handle);
        }
    });
}

/// Quits for real, even in tray mode.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

const TRAY_ID: &str = "octopolis-tray";

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Octopolis", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID).tooltip("Octopolis").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Records the first launch's paths.
pub fn init(app: &AppHandle) {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    let state = app.state::<LaunchState>();
    *state.startup.lock().unwrap_or_else(|e| e.into_inner()) = launch_targets(&args, &cwd);
}

/// A second launch: open its paths in this window and bring it forward.
pub fn on_second_instance(app: &AppHandle, argv: Vec<String>, cwd: String) {
    let targets = launch_targets(argv.get(1..).unwrap_or_default(), Path::new(&cwd));
    show_main(app);
    if !targets.is_empty() {
        let _ = app.emit_to("main", OPEN_PATHS_EVENT, targets);
    }
}

/// Window close: hide to the tray when tray mode is on.
pub fn on_close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    let state = window.app_handle().state::<LaunchState>();
    if state.keep_in_tray.load(Ordering::Relaxed) {
        api.prevent_close();
        let _ = window.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn keeps_paths_and_drops_switches() {
        let cwd = Path::new("C:\\work");
        assert_eq!(launch_targets(&s(&["D:\\Photos", "--verbose", "/e,", "sub"]), cwd), s(&["D:\\Photos", "C:\\work\\sub"]));
    }

    #[test]
    fn select_opens_the_named_item() {
        assert_eq!(launch_targets(&s(&["/select,C:\\a\\b.txt"]), Path::new("C:\\")), s(&["C:\\a\\b.txt"]));
        assert_eq!(launch_targets(&s(&["/Select,\"C:\\a b\\c.txt\""]), Path::new("C:\\")), s(&["C:\\a b\\c.txt"]));
    }

    #[test]
    fn passes_shell_names_and_unc_paths_through() {
        assert_eq!(launch_targets(&s(&["shell:Downloads", "\\\\nas\\share"]), Path::new("C:\\")), s(&["shell:Downloads", "\\\\nas\\share"]));
    }
}
