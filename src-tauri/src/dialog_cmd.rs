//! Help in other apps' Open and Save dialogs (see `octo_core::dialog_assist`):
//! Ctrl+G sends the dialog to the folder Octopolis is showing, Ctrl+Shift+G
//! brings Octopolis forward to pick the file here.

use std::path::PathBuf;
use std::sync::Mutex;

use octo_core::dialog_assist::{self, Dialog, Key};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Event the UI listens for: pick a file here for another app's dialog.
pub const DIALOG_PICK_EVENT: &str = "octopolis://dialog-pick";

#[derive(Default)]
pub struct DialogState {
    /// Folder of the tab in front, reported by the UI.
    folder: Mutex<String>,
    /// The dialog a pick is in progress for.
    picking: Mutex<Option<isize>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DialogPick {
    title: String,
    app: String,
    /// A Save dialog: only a folder can be sent.
    save: bool,
}

fn on_key(app: &AppHandle, key: Key, dialog: Dialog) {
    let state = app.state::<DialogState>();
    match key {
        Key::Jump => {
            let folder = lock(&state.folder).clone();
            if folder.is_empty() {
                return;
            }
            // Off the shortcut thread: sending waits briefly on the other app.
            std::thread::spawn(move || {
                if let Err(e) = dialog_assist::go_to_folder(dialog.hwnd, &PathBuf::from(folder)) {
                    crate::diag::write("warn", &format!("dialog: {e}"));
                }
            });
        }
        Key::Pick => {
            *lock(&state.picking) = Some(dialog.hwnd);
            crate::launch::show_main(app);
            let _ = app.emit_to("main", DIALOG_PICK_EVENT, DialogPick { title: dialog.title, app: dialog.app, save: dialog.save });
        }
    }
}

/// Turns the dialog shortcuts on or off. `exclude` is the user's list of programs to leave alone.
#[tauri::command]
pub fn dialog_assist_set(app: AppHandle, enabled: bool, exclude: String) {
    dialog_assist::set(enabled, dialog_assist::parse_excluded(&exclude), move |key, dialog| on_key(&app, key, dialog));
}

/// The UI reports the folder of the tab in front (empty when it isn't a real folder).
#[tauri::command]
pub fn dialog_assist_folder(state: State<'_, DialogState>, path: String) {
    *lock(&state.folder) = path;
}

/// Finishes a pick: opens `files` in the waiting dialog, or sends it to `folder` when no files are given.
#[tauri::command]
pub async fn dialog_assist_send(state: State<'_, DialogState>, files: Vec<String>, folder: String) -> Result<(), String> {
    let hwnd = lock(&state.picking).take().ok_or("The dialog is no longer waiting")?;
    crate::off_main(move || {
        let done = if files.is_empty() {
            dialog_assist::go_to_folder(hwnd, &PathBuf::from(folder))
        } else {
            dialog_assist::choose_files(hwnd, &files.iter().map(PathBuf::from).collect::<Vec<_>>())
        };
        dialog_assist::focus(hwnd);
        done.map_err(|e| e.to_string())
    })
    .await
}

/// Abandons a pick and goes back to the dialog.
#[tauri::command]
pub fn dialog_assist_cancel(state: State<'_, DialogState>) {
    if let Some(hwnd) = lock(&state.picking).take() {
        dialog_assist::focus(hwnd);
    }
}
