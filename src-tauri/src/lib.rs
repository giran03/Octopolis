//! Tauri shell: exposes the octo-core engine to the UI as commands.

mod diag;
mod launch;
mod listing;
mod ops_cmd;
mod search_cmd;
mod system;
mod term_cmd;
mod tools_cmd;
mod size_cmd;
mod cache_cmd;
mod update_cmd;
mod watch;

/// Runs file-system work on the blocking pool. Sync Tauri commands run on the
/// main thread, so a slow disk or a dead network share would freeze the UI.
pub(crate) async fn off_main<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

pub fn run() {
    // `Octopolis.exe --restore-explorer` gives folders back to File Explorer
    // without opening a window (also usable if the app can't start).
    if std::env::args().any(|a| a.eq_ignore_ascii_case("--restore-explorer")) {
        let menu = octo_core::explorer_mode::disable_menu();
        let code = i32::from(octo_core::explorer_mode::disable().is_err() || menu.is_err());
        std::process::exit(code);
    }
    diag::mark_start();
    octo_core::shell::suppress_drive_error_dialogs();
    // Grammar setup takes a moment; do it now so the first preview is instant.
    std::thread::spawn(octo_core::preview::highlight::warm_up);
    tauri::Builder::default()
        // Must come first: a second launch hands its paths to this window and exits.
        .plugin(tauri_plugin_single_instance::init(launch::on_second_instance))
        .plugin(tauri_plugin_notification::init())
        .manage(launch::LaunchState::default())
        .manage(tools_cmd::ScanState::default())
        .manage(tools_cmd::TagsState::default())
        .manage(ops_cmd::OpsState::default())
        .manage(watch::WatchState::default())
        .manage(search_cmd::SearchState::default())
        .manage(cache_cmd::CacheState::default())
        .manage(size_cmd::SizesState::default())
        .manage(term_cmd::TermState::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                launch::on_close_requested(window, api);
            }
        })
        .setup(|app| {
            diag::init(app.handle());
            launch::init(app.handle());
            std::thread::spawn(system::repair_explorer_mode);
            size_cmd::warm_cache(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            launch::startup_paths,
            diag::diag_log,
            diag::startup_mark,
            diag::open_log_folder,
            launch::set_keep_in_tray,
            launch::quit_app,
            launch::set_summon,
            search_cmd::search,
            search_cmd::cancel_search,
            listing::list_dir,
            listing::resolve_path,
            ops_cmd::start_op,
            ops_cmd::cancel_op,
            ops_cmd::pause_op,
            ops_cmd::batch_rename,
            ops_cmd::restore_recycled,
            ops_cmd::remove_empty_dir,
            tools_cmd::preview_file,
            tools_cmd::read_bytes,
            tools_cmd::extract_and_open,
            tools_cmd::thumbnail,
            tools_cmd::who_locks,
            tools_cmd::kill_process,
            tools_cmd::file_tags,
            tools_cmd::file_properties,
            tools_cmd::set_file_attributes,
            tools_cmd::set_file_times,
            tools_cmd::file_checksum,
            tools_cmd::set_cloud_pin,
            tools_cmd::content_matches,
            tools_cmd::cancel_scan,
            tools_cmd::find_duplicates,
            tools_cmd::scan_cleanup,
            tools_cmd::tags_in_dir,
            tools_cmd::set_tag,
            tools_cmd::all_tags,
            tools_cmd::tagged_paths,
            tools_cmd::git_change,
            tools_cmd::git_diff,
            size_cmd::cached_folder_sizes,
            size_cmd::folder_sizes,
            size_cmd::disk_space_tree,
            size_cmd::scan_disk_space,
            size_cmd::cancel_disk_space,
            tools_cmd::git_status,
            tools_cmd::git_last_commits,
            tools_cmd::native_menu,
            term_cmd::term_start,
            term_cmd::term_write,
            term_cmd::term_resize,
            term_cmd::term_close,
            ops_cmd::rename_item,
            ops_cmd::create_folder,
            ops_cmd::create_file,
            ops_cmd::transfer_conflicts,
            ops_cmd::create_links,
            ops_cmd::recycle_bin_list,
            ops_cmd::recycle_bin_restore,
            ops_cmd::recycle_bin_purge,
            ops_cmd::recycle_bin_empty,
            ops_cmd::list_templates,
            ops_cmd::templates_folder,
            system::open_path,
            system::open_in_editor,
            system::install_font,
            system::set_keep_awake,
            system::notify,
            system::reveal_in_explorer,
            system::open_with,
            system::run_as_admin,
            system::eject_drive,
            system::open_in_explorer,
            system::run_custom_action,
            system::map_network_drive,
            system::disconnect_network_drive,
            system::wsl_distros,
            system::explorer_mode_status,
            system::explorer_mode_set,
            system::explorer_menu_set,
            system::clipboard_write_files,
            system::clipboard_read_files,
            system::clipboard_clear,
            system::paste_clipboard_as_file,
            system::list_drives,
            system::known_folders,
            system::open_data_folder,
            system::debug_info,
            cache_cmd::cache_info,
            cache_cmd::open_cache_folder,
            cache_cmd::pick_cache_folder,
            cache_cmd::set_cache_dir,
            cache_cmd::clear_cache,
            update_cmd::update_check,
            update_cmd::update_download,
            update_cmd::update_install,
            watch::watch_dir,
            watch::unwatch_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Octopolis");
}
