//! "Show in folder" from other apps: lists the folders open in tabs with
//! Windows (see `octo_core::shell_windows`) and passes the files other apps
//! ask for on to the UI. Only active while Octopolis is the default file manager.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use octo_core::shell_windows::{Registry, Selected};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Event the UI listens for: another app asked for these items to be shown.
pub const SHOW_ITEMS_EVENT: &str = "octopolis://show-items";
/// Windows asks for the items of one request one at a time; they are passed on together.
const BATCH_WAIT: Duration = Duration::from_millis(80);

#[derive(Default)]
pub struct ShellWinState {
    registry: OnceLock<Registry>,
    /// Folders the UI last reported, kept so the setting can be switched without the UI resending.
    wanted: Mutex<Vec<String>>,
    pending: Mutex<Vec<Selected>>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShowItems {
    folder: String,
    /// Full paths, in the order they were asked for.
    items: Vec<String>,
}

/// Groups the items of one burst by folder, keeping only what follows the last "replace" of each.
pub fn batches(selected: Vec<Selected>) -> Vec<ShowItems> {
    let mut out: Vec<ShowItems> = Vec::new();
    for s in selected {
        let at = out.iter().position(|b| b.folder == s.folder).unwrap_or_else(|| {
            out.push(ShowItems { folder: s.folder.clone(), items: Vec::new() });
            out.len() - 1
        });
        if s.replace {
            out[at].items.clear();
        }
        if !out[at].items.contains(&s.item) {
            out[at].items.push(s.item);
        }
    }
    out
}

fn on_select(app: &AppHandle, selected: Selected) {
    let state = app.state::<ShellWinState>();
    let mut pending = state.pending.lock().unwrap_or_else(|e| e.into_inner());
    let first = pending.is_empty();
    pending.push(selected);
    drop(pending);
    if !first {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(BATCH_WAIT);
        let state = app.state::<ShellWinState>();
        let taken = std::mem::take(&mut *state.pending.lock().unwrap_or_else(|e| e.into_inner()));
        crate::launch::show_main(&app);
        for batch in batches(taken) {
            let _ = app.emit_to("main", SHOW_ITEMS_EVENT, batch);
        }
    });
}

/// Lists the wanted folders with Windows, or none while File Explorer is the default.
pub fn apply(app: &AppHandle) {
    let state = app.state::<ShellWinState>();
    let wanted = state.wanted.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let active = octo_core::explorer_mode::status().folders;
    if !active && state.registry.get().is_none() {
        return;
    }
    let Some(window) = app.get_webview_window("main") else { return };
    let Ok(hwnd) = window.hwnd() else { return };
    let handle = app.clone();
    let registry = state.registry.get_or_init(|| Registry::start(hwnd.0 as isize, move |s| on_select(&handle, s)));
    registry.sync(if active { wanted } else { Vec::new() });
}

/// The UI reports the folders its tabs are showing.
#[tauri::command]
pub async fn shell_windows_sync(app: AppHandle, state: State<'_, ShellWinState>, paths: Vec<String>) -> Result<(), String> {
    *state.wanted.lock().unwrap_or_else(|e| e.into_inner()) = paths;
    crate::off_main(move || {
        apply(&app);
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sel(folder: &str, item: &str, replace: bool) -> Selected {
        Selected { folder: folder.into(), item: item.into(), replace }
    }

    #[test]
    fn one_request_becomes_one_batch_in_order() {
        let got = batches(vec![sel("C:\\a", "C:\\a\\1", true), sel("C:\\a", "C:\\a\\2", false), sel("C:\\b", "C:\\b\\x", true)]);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].items, vec!["C:\\a\\1", "C:\\a\\2"]);
        assert_eq!(got[1].folder, "C:\\b");
    }

    #[test]
    fn a_later_request_for_the_same_folder_replaces_the_earlier_one() {
        let got = batches(vec![sel("C:\\a", "C:\\a\\1", true), sel("C:\\a", "C:\\a\\2", true), sel("C:\\a", "C:\\a\\2", false)]);
        assert_eq!(got, vec![ShowItems { folder: "C:\\a".into(), items: vec!["C:\\a\\2".into()] }]);
    }
}
