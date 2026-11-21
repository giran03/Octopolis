//! Optional: new File Explorer folder windows opened by other apps are handed
//! to Octopolis (see `octo_core::explorer_catch`). Only active while Octopolis
//! is the default file manager and the setting is on.

use std::sync::atomic::{AtomicBool, Ordering};

use octo_core::explorer_catch::{self, Caught};
use tauri::{AppHandle, Emitter};

use crate::shellwin_cmd::{SHOW_ITEMS_EVENT, ShowItems};

/// The user's setting, kept so the default-file-manager switch can re-apply it.
static WANTED: AtomicBool = AtomicBool::new(false);

fn on_caught(app: &AppHandle, caught: Caught) {
    crate::launch::show_main(app);
    if caught.selected.is_empty() {
        let _ = app.emit_to("main", crate::launch::OPEN_PATHS_EVENT, vec![caught.folder]);
    } else {
        let _ = app.emit_to("main", SHOW_ITEMS_EVENT, ShowItems::new(caught.folder, caught.selected));
    }
}

/// Starts or stops catching to match the setting and the default-file-manager switch.
pub fn apply(app: &AppHandle) {
    // Only the copy the entries point at catches windows (WE-15).
    let active = crate::system::catchers(&octo_core::explorer_mode::status(), false, WANTED.load(Ordering::Relaxed)).explorer_windows;
    let handle = app.clone();
    explorer_catch::set(active, move |caught| on_caught(&handle, caught));
}

#[tauri::command]
pub async fn explorer_catch_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    WANTED.store(enabled, Ordering::Relaxed);
    crate::off_main(move || {
        apply(&app);
        Ok(())
    })
    .await
}
