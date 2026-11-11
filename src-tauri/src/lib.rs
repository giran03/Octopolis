//! Tauri shell: exposes the octo-core engine to the UI as commands.

mod listing;
mod ops_cmd;
mod system;
mod watch;

/// Runs file-system work on the blocking pool. Sync Tauri commands run on the
/// main thread, so a slow disk or a dead network share would freeze the UI.
pub(crate) async fn off_main<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

pub fn run() {
    octo_core::shell::suppress_drive_error_dialogs();
    tauri::Builder::default()
        .manage(ops_cmd::OpsState::default())
        .manage(watch::WatchState::default())
        .invoke_handler(tauri::generate_handler![
            listing::list_dir,
            listing::resolve_path,
            ops_cmd::start_op,
            ops_cmd::cancel_op,
            ops_cmd::rename_item,
            ops_cmd::create_folder,
            system::open_path,
            system::reveal_in_explorer,
            system::list_drives,
            system::known_folders,
            watch::watch_dir,
            watch::unwatch_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Octopolis");
}
