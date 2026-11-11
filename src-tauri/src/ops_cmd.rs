//! File operation commands. Long operations run on their own thread and
//! stream progress back over a channel.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use octo_core::ops::{self, CancelToken, Conflict, Operation, Progress, Report};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;

#[derive(Default)]
pub struct OpsState {
    next_id: AtomicU64,
    running: Mutex<HashMap<u64, CancelToken>>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpRequest {
    Copy { sources: Vec<PathBuf>, dest: PathBuf },
    Move { sources: Vec<PathBuf>, dest: PathBuf },
    Delete { paths: Vec<PathBuf>, permanent: bool },
}

#[derive(Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    #[default]
    KeepBoth,
    Overwrite,
    Skip,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OpEvent {
    #[serde(rename_all = "camelCase")]
    Progress {
        total_bytes: u64,
        done_bytes: u64,
        total_items: u64,
        done_items: u64,
        current: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        errors: Vec<OpErrorDto>,
        skipped: usize,
        created: Vec<String>,
        cancelled: bool,
    },
}

#[derive(Serialize, Clone)]
pub struct OpErrorDto {
    path: String,
    message: String,
}

impl From<&Progress> for OpEvent {
    fn from(p: &Progress) -> Self {
        OpEvent::Progress {
            total_bytes: p.total_bytes,
            done_bytes: p.done_bytes,
            total_items: p.total_items,
            done_items: p.done_items,
            current: p.current.as_ref().map(|c| c.to_string_lossy().into_owned()),
        }
    }
}

impl From<Report> for OpEvent {
    fn from(r: Report) -> Self {
        OpEvent::Done {
            errors: r
                .errors
                .into_iter()
                .map(|e| OpErrorDto { path: e.path.to_string_lossy().into_owned(), message: e.message })
                .collect(),
            skipped: r.skipped.len(),
            created: r.created.into_iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            cancelled: r.cancelled,
        }
    }
}

fn to_operation(req: OpRequest) -> Operation {
    match req {
        OpRequest::Copy { sources, dest } => Operation::Copy { sources, dest },
        OpRequest::Move { sources, dest } => Operation::Move { sources, dest },
        OpRequest::Delete { paths, permanent } => Operation::Delete { paths, permanent },
    }
}

fn to_conflict(c: ConflictChoice) -> Conflict {
    match c {
        ConflictChoice::KeepBoth => Conflict::KeepBoth,
        ConflictChoice::Overwrite => Conflict::Overwrite,
        ConflictChoice::Skip => Conflict::Skip,
    }
}

/// Starts an operation in the background and returns its id for cancelling.
#[tauri::command]
pub fn start_op(
    app: tauri::AppHandle,
    state: State<'_, OpsState>,
    request: OpRequest,
    conflict: Option<ConflictChoice>,
    on_event: Channel<OpEvent>,
) -> Result<u64, String> {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel = CancelToken::default();
    state.running.lock().map_err(|e| e.to_string())?.insert(id, cancel.clone());
    let op = to_operation(request);
    let conflict = to_conflict(conflict.unwrap_or_default());

    std::thread::Builder::new()
        .name(format!("octo-op-{id}"))
        .spawn(move || {
            let report = ops::run(&op, conflict, &cancel, &mut |p| {
                let _ = on_event.send(OpEvent::from(p));
            });
            let _ = on_event.send(OpEvent::from(report));
            use tauri::Manager;
            if let Ok(mut running) = app.state::<OpsState>().running.lock() {
                running.remove(&id);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn cancel_op(state: State<'_, OpsState>, id: u64) -> Result<(), String> {
    if let Some(token) = state.running.lock().map_err(|e| e.to_string())?.get(&id) {
        token.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn rename_item(path: PathBuf, new_name: String) -> Result<String, String> {
    crate::off_main(move || {
        ops::rename(&path, &new_name).map(|p| p.to_string_lossy().into_owned()).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn create_folder(parent: PathBuf, name: String) -> Result<String, String> {
    crate::off_main(move || {
        ops::create_folder(&parent, &name).map(|p| p.to_string_lossy().into_owned()).map_err(|e| e.to_string())
    })
    .await
}
