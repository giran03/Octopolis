//! File operation commands. Transfers run one at a time on a queue thread and
//! stream progress back over a channel; deletes start immediately.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use octo_core::archive;
use octo_core::ops::{self, CancelToken, Conflict, Operation, Options, Progress, Report};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
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
    Relocate { pairs: Vec<(PathBuf, PathBuf)> },
    Extract { archive: PathBuf, items: Vec<String>, dest: PathBuf },
}

#[derive(Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    #[default]
    KeepBoth,
    Overwrite,
    Skip,
}

#[derive(Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase", default)]
pub struct OpOptions {
    conflict: ConflictChoice,
    verify: bool,
    limit_bps: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OpEvent {
    /// The operation left the queue and is running.
    Started,
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
        pairs: Vec<(String, String)>,
        cancelled: bool,
    },
}

#[derive(Serialize, Clone)]
pub struct OpErrorDto {
    path: String,
    message: String,
}

fn text(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

impl From<&Progress> for OpEvent {
    fn from(p: &Progress) -> Self {
        OpEvent::Progress {
            total_bytes: p.total_bytes,
            done_bytes: p.done_bytes,
            total_items: p.total_items,
            done_items: p.done_items,
            current: p.current.as_deref().map(text),
        }
    }
}

impl From<Report> for OpEvent {
    fn from(r: Report) -> Self {
        OpEvent::Done {
            errors: r.errors.into_iter().map(|e| OpErrorDto { path: text(&e.path), message: e.message }).collect(),
            skipped: r.skipped.len(),
            created: r.created.iter().map(|p| text(p)).collect(),
            pairs: r.pairs.iter().map(|(a, b)| (text(a), text(b))).collect(),
            cancelled: r.cancelled,
        }
    }
}

fn to_options(o: OpOptions) -> Options {
    Options {
        conflict: match o.conflict {
            ConflictChoice::KeepBoth => Conflict::KeepBoth,
            ConflictChoice::Overwrite => Conflict::Overwrite,
            ConflictChoice::Skip => Conflict::Skip,
        },
        verify: o.verify,
        limit_bps: o.limit_bps,
    }
}

type Job = Box<dyn FnOnce() + Send>;

/// The single worker that runs queued transfers in order.
fn queue() -> &'static Sender<Job> {
    static Q: OnceLock<Sender<Job>> = OnceLock::new();
    Q.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("octo-transfer-queue".into())
            .spawn(move || {
                while let Ok(job) = rx.recv() {
                    job();
                }
            })
            .expect("spawning the transfer queue thread");
        tx
    })
}

fn execute(request: OpRequest, options: Options, cancel: &CancelToken, on_event: &Channel<OpEvent>) -> OpEvent {
    let _ = on_event.send(OpEvent::Started);
    let op = match request {
        OpRequest::Copy { sources, dest } => Operation::Copy { sources, dest },
        OpRequest::Move { sources, dest } => Operation::Move { sources, dest },
        OpRequest::Delete { paths, permanent } => Operation::Delete { paths, permanent },
        OpRequest::Relocate { pairs } => Operation::Relocate { pairs },
        OpRequest::Extract { archive: file, items, dest } => return extract(&file, &items, &dest, cancel, on_event),
    };
    OpEvent::from(ops::run_with(&op, &options, cancel, &mut |p| {
        let _ = on_event.send(OpEvent::from(p));
    }))
}

fn extract(file: &std::path::Path, items: &[String], dest: &std::path::Path, cancel: &CancelToken, on_event: &Channel<OpEvent>) -> OpEvent {
    let result = archive::extract(file, items, dest, cancel, |done, total| {
        let _ = on_event.send(OpEvent::Progress { total_bytes: total, done_bytes: done, total_items: 0, done_items: 0, current: None });
    });
    match result {
        Ok(r) => OpEvent::Done {
            errors: r.errors.into_iter().map(|(path, message)| OpErrorDto { path, message }).collect(),
            skipped: 0,
            created: r.created.iter().map(|p| text(p)).collect(),
            pairs: Vec::new(),
            cancelled: cancel.is_cancelled(),
        },
        Err(e) => OpEvent::Done {
            errors: if cancel.is_cancelled() { Vec::new() } else { vec![OpErrorDto { path: text(file), message: e.to_string() }] },
            skipped: 0,
            created: Vec::new(),
            pairs: Vec::new(),
            cancelled: cancel.is_cancelled(),
        },
    }
}

/// Queues (or, for deletes, starts) an operation and returns its id.
#[tauri::command]
pub fn start_op(
    app: tauri::AppHandle,
    state: State<'_, OpsState>,
    request: OpRequest,
    options: Option<OpOptions>,
    on_event: Channel<OpEvent>,
) -> Result<u64, String> {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel = CancelToken::default();
    state.running.lock().map_err(|e| e.to_string())?.insert(id, cancel.clone());
    let opts = to_options(options.unwrap_or_default());
    let immediate = matches!(request, OpRequest::Delete { .. });

    let job = move || {
        let done = execute(request, opts, &cancel, &on_event);
        let _ = on_event.send(done);
        if let Ok(mut running) = app.state::<OpsState>().running.lock() {
            running.remove(&id);
        }
    };
    if immediate {
        std::thread::Builder::new().name(format!("octo-op-{id}")).spawn(job).map_err(|e| e.to_string())?;
    } else {
        queue().send(Box::new(job)).map_err(|e| e.to_string())?;
    }
    Ok(id)
}

fn with_token(state: &State<'_, OpsState>, id: u64, f: impl FnOnce(&CancelToken)) -> Result<(), String> {
    if let Some(token) = state.running.lock().map_err(|e| e.to_string())?.get(&id) {
        f(token);
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_op(state: State<'_, OpsState>, id: u64) -> Result<(), String> {
    with_token(&state, id, CancelToken::cancel)
}

#[tauri::command]
pub fn pause_op(state: State<'_, OpsState>, id: u64, paused: bool) -> Result<(), String> {
    with_token(&state, id, |t| t.set_paused(paused))
}

#[tauri::command]
pub async fn rename_item(path: PathBuf, new_name: String) -> Result<String, String> {
    crate::off_main(move || {
        ops::rename(&path, &new_name).map(|p| text(&p)).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn create_folder(parent: PathBuf, name: String) -> Result<String, String> {
    crate::off_main(move || {
        ops::create_folder(&parent, &name).map(|p| text(&p)).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn batch_rename(items: Vec<(PathBuf, String)>) -> Result<Vec<(String, String)>, String> {
    crate::off_main(move || {
        ops::batch_rename(&items).map(|v| v.iter().map(|(a, b)| (text(a), text(b))).collect()).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn restore_recycled(paths: Vec<PathBuf>) -> Result<usize, String> {
    crate::off_main(move || ops::restore_recycled(&paths).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn remove_empty_dir(path: PathBuf) -> Result<(), String> {
    crate::off_main(move || ops::remove_empty_dir(&path).map_err(|e| e.to_string())).await
}
