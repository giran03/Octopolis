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
    /// Packs `sources` into a new archive called `name` in the `dest` folder.
    Compress { sources: Vec<PathBuf>, dest: PathBuf, name: String, format: ArchiveFormatDto },
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveFormatDto {
    Zip,
    SevenZ,
    TarGz,
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
                    // One failing transfer must not stop the ones behind it.
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
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
        OpRequest::Compress { sources, dest, name, format } => return compress(&sources, &dest, &name, format, cancel, on_event),
    };
    OpEvent::from(ops::run_with(&op, &options, cancel, &mut |p| {
        let _ = on_event.send(OpEvent::from(p));
    }))
}

fn compress(sources: &[PathBuf], dest: &std::path::Path, name: &str, format: ArchiveFormatDto, cancel: &CancelToken, on_event: &Channel<OpEvent>) -> OpEvent {
    use octo_core::compress::ArchiveFormat;
    let format = match format {
        ArchiveFormatDto::Zip => ArchiveFormat::Zip,
        ArchiveFormatDto::SevenZ => ArchiveFormat::SevenZ,
        ArchiveFormatDto::TarGz => ArchiveFormat::TarGz,
    };
    let result = octo_core::compress::compress(sources, dest, name, format, cancel, |done, total| {
        let _ = on_event.send(OpEvent::Progress { total_bytes: total, done_bytes: done, total_items: 0, done_items: 0, current: None });
    });
    let cancelled = cancel.is_cancelled();
    match result {
        Ok(path) => OpEvent::Done { errors: Vec::new(), skipped: 0, created: vec![text(&path)], pairs: Vec::new(), cancelled },
        Err(e) => OpEvent::Done {
            errors: if cancelled { Vec::new() } else { vec![OpErrorDto { path: text(dest), message: e.to_string() }] },
            skipped: 0,
            created: Vec::new(),
            pairs: Vec::new(),
            cancelled,
        },
    }
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

    let moves = matches!(request, OpRequest::Move { .. } | OpRequest::Relocate { .. });
    let job = move || {
        let done = execute(request, opts, &cancel, &on_event);
        // Tags follow items Octopolis moved.
        if moves && let OpEvent::Done { pairs, .. } = &done {
            let pairs: Vec<(PathBuf, PathBuf)> = pairs.iter().map(|(a, b)| (PathBuf::from(a), PathBuf::from(b))).collect();
            crate::tools_cmd::tags_follow(&app, &pairs);
        }
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
pub async fn rename_item(app: tauri::AppHandle, path: PathBuf, new_name: String) -> Result<String, String> {
    crate::off_main(move || {
        let to = ops::rename(&path, &new_name).map_err(|e| e.to_string())?;
        crate::tools_cmd::tags_follow(&app, &[(path, to.clone())]);
        Ok(text(&to))
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SideDto {
    path: String,
    is_dir: bool,
    size: u64,
    modified_ms: i64,
}

#[derive(Serialize)]
pub struct ConflictDto {
    source: SideDto,
    target: SideDto,
}

fn side_dto(s: ops::Side) -> SideDto {
    SideDto { path: text(&s.path), is_dir: s.is_dir, size: s.size, modified_ms: s.modified_ms }
}

/// Names that a copy or move of `sources` into `dest` would collide with.
#[tauri::command]
pub async fn transfer_conflicts(sources: Vec<PathBuf>, dest: PathBuf) -> Result<Vec<ConflictDto>, String> {
    crate::off_main(move || {
        Ok(ops::find_conflicts(&sources, &dest)
            .into_iter()
            .map(|c| ConflictDto { source: side_dto(c.source), target: side_dto(c.target) })
            .collect())
    })
    .await
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum LinkKindDto {
    Symbolic,
    Junction,
    Hard,
}

/// "Paste as link": creates a link to each target inside `dest`. Returns the
/// links made, plus a message for each target that could not be linked.
#[tauri::command]
pub async fn create_links(kind: LinkKindDto, targets: Vec<PathBuf>, dest: PathBuf) -> Result<(Vec<String>, Vec<String>), String> {
    let kind = match kind {
        LinkKindDto::Symbolic => ops::LinkKind::Symbolic,
        LinkKindDto::Junction => ops::LinkKind::Junction,
        LinkKindDto::Hard => ops::LinkKind::Hard,
    };
    crate::off_main(move || {
        let (mut made, mut errors) = (Vec::new(), Vec::new());
        for t in &targets {
            match ops::create_link(kind, t, &dest) {
                Ok(p) => made.push(text(&p)),
                Err(e) => errors.push(e.to_string()),
            }
        }
        Ok((made, errors))
    })
    .await
}

const TEMPLATES_DIR: &str = "templates";

fn templates_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(TEMPLATES_DIR))
}

/// Creates a file in `parent`. `template` is the name of a file in the
/// templates folder (never a path), whose contents the new file starts with.
#[tauri::command]
pub async fn create_file(app: tauri::AppHandle, parent: PathBuf, name: String, template: Option<String>) -> Result<String, String> {
    let template = match template {
        Some(t) => {
            octo_core::names::validate_name(&t).map_err(|e| e.to_string())?;
            Some(templates_dir(&app)?.join(t))
        }
        None => None,
    };
    crate::off_main(move || {
        ops::create_file(&parent, &name, template.as_deref()).map(|p| text(&p)).map_err(|e| e.to_string())
    })
    .await
}

/// File names in the templates folder, sorted; empty if it doesn't exist yet.
#[tauri::command]
pub async fn list_templates(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = templates_dir(&app)?;
    crate::off_main(move || {
        let Ok(read) = std::fs::read_dir(&dir) else { return Ok(Vec::new()) };
        let mut names: Vec<String> = read
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort_by_key(|n| n.to_lowercase());
        Ok(names)
    })
    .await
}

/// The templates folder's path, creating the folder first.
#[tauri::command]
pub async fn templates_folder(app: tauri::AppHandle) -> Result<String, String> {
    let dir = templates_dir(&app)?;
    crate::off_main(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(text(&dir))
    })
    .await
}

#[tauri::command]
pub async fn batch_rename(app: tauri::AppHandle, items: Vec<(PathBuf, String)>) -> Result<Vec<(String, String)>, String> {
    crate::off_main(move || {
        let done = ops::batch_rename(&items).map_err(|e| e.to_string())?;
        crate::tools_cmd::tags_follow(&app, &done);
        Ok(done.iter().map(|(a, b)| (text(a), text(b))).collect())
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinItemDto {
    id: String,
    name: String,
    original_path: String,
    deleted_ms: i64,
    size: Option<u64>,
    is_dir: bool,
}

#[tauri::command]
pub async fn recycle_bin_list() -> Result<Vec<BinItemDto>, String> {
    crate::off_main(|| {
        Ok(ops::list_bin()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|i| BinItemDto { id: i.id, name: i.name, original_path: text(&i.original_path), deleted_ms: i.deleted_ms, size: i.size, is_dir: i.is_dir })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn recycle_bin_restore(ids: Vec<String>) -> Result<usize, String> {
    crate::off_main(move || ops::restore_from_bin(&ids).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn recycle_bin_purge(ids: Vec<String>) -> Result<usize, String> {
    crate::off_main(move || ops::purge_from_bin(&ids).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn recycle_bin_empty() -> Result<usize, String> {
    crate::off_main(|| ops::empty_bin().map_err(|e| e.to_string())).await
}
