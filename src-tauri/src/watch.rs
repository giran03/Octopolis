//! Folder change notifications (ReadDirectoryChangesW through `notify`).
//!
//! Each watch is non-recursive and debounced: a burst of changes, such as an
//! unzip writing thousands of files, produces one "changed" message.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::State;
use tauri::ipc::Channel;

const DEBOUNCE: Duration = Duration::from_millis(150);

#[derive(Default)]
pub struct WatchState {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

/// Watches `path` under the caller-chosen `id` (one per tab), replacing any
/// earlier watch with the same id.
#[tauri::command]
pub async fn watch_dir(app: tauri::AppHandle, id: String, path: PathBuf, on_change: Channel<u32>) -> Result<(), String> {
    // Opening a watch on a slow or dead share can block, so do it off the main thread.
    let watcher = crate::off_main(move || start_watcher(path, on_change)).await?;
    use tauri::Manager;
    app.state::<WatchState>().watchers.lock().map_err(|e| e.to_string())?.insert(id, watcher);
    Ok(())
}

fn start_watcher(path: PathBuf, on_change: Channel<u32>) -> Result<RecommendedWatcher, String> {
    let (tx, rx) = mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok_and(|e| !e.kind.is_access()) {
            let _ = tx.send(());
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(&path, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;

    // The thread ends when the watcher (and with it the sender) is dropped.
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            let mut burst = 1u32;
            loop {
                match rx.recv_timeout(DEBOUNCE) {
                    Ok(()) => burst += 1,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            if on_change.send(burst).is_err() {
                return;
            }
        }
    });

    Ok(watcher)
}

#[tauri::command]
pub fn unwatch_dir(state: State<'_, WatchState>, id: String) -> Result<(), String> {
    state.watchers.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}
