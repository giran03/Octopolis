//! Folder sizes for the Size column and the treemap.
//!
//! Sizes are kept in a live index (see `octo_core::size_index`) and are never recomputed from scratch
//! when they are already known:
//! 1. Numbers we already have, from this session or the last one, are sent at once, marked `stale`.
//! 2. Each subfolder is then scanned and its fresh number replaces the stale one.
//! 3. A recursive watcher keeps the index up to date while the tab stays on this folder. A change reads
//!    only the folder it happened in, and the affected subfolder's new total is pushed to the tab.
//!
//! The last known totals are saved to disk so the next launch also starts with numbers.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use octo_core::entry::{EntryKind, attrs};
use octo_core::ops::CancelToken;
use octo_core::size_index::{SizeIndex, key_of};
use octo_core::sizes::FolderSize;
use rayon::prelude::*;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager, State};

/// After the last change in a burst, wait this long before reading folders again.
const QUIET: Duration = Duration::from_millis(400);
/// A burst that never goes quiet is handled after this long anyway.
const MAX_WAIT: Duration = Duration::from_secs(3);
/// More changed folders than this in one burst: rescan the affected subfolders instead.
const MAX_REFRESH: usize = 400;
const SAVE_EVERY: Duration = Duration::from_secs(5);
const MAX_SAVED: usize = 10_000;
/// Remembered totals untouched for this long are dropped when the file is loaded.
const SAVED_TTL_SECS: u64 = 90 * 24 * 3600;
/// The live index is cut back to the current folder's tree beyond this many folders (roughly 50 MB).
const MAX_LIVE_DIRS: usize = 150_000;
pub const SAVE_FILE: &str = "size-cache.json";

#[derive(Default)]
pub struct SizesState {
    running: Mutex<HashMap<String, CancelToken>>,
    space_cancel: Mutex<Option<CancelToken>>,
    index: Arc<SizeIndex>,
    saved: Arc<Mutex<Saved>>,
}

impl SizesState {
    /// (live folders, live bytes in memory, saved folders, saved file bytes).
    pub fn stats(&self, app: &tauri::AppHandle) -> (usize, u64, usize, u64) {
        let live = self.index.len();
        let live_bytes = self.index.approx_bytes();
        let file = crate::cache_cmd::resolve_cache_dir(app).map(|d| d.join(SAVE_FILE)).ok();
        let mut guard = self.saved.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref f) = file {
            guard.load(f.clone());
        }
        let saved = guard.map.len();
        let bytes = file.and_then(|f| std::fs::metadata(f).ok().map(|m| m.len())).unwrap_or(0);
        (live, live_bytes, saved, bytes)
    }

    pub fn flush_now(&self) {
        self.saved.lock().unwrap_or_else(|e| e.into_inner()).flush(true);
    }

    pub fn set_saved_file(&self, file: PathBuf) {
        let mut guard = self.saved.lock().unwrap_or_else(|e| e.into_inner());
        guard.file = Some(file);
        guard.loaded = true;
    }

    pub fn clear_cache(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if let Ok(mut running) = self.running.lock() {
            for (_, c) in running.drain() {
                c.cancel();
            }
        }
        if let Ok(mut sc) = self.space_cancel.lock()
            && let Some(c) = sc.take()
        {
            c.cancel();
        }
        self.index.clear();
        let file = crate::cache_cmd::resolve_cache_dir(app)?.join(SAVE_FILE);
        let mut guard = self.saved.lock().unwrap_or_else(|e| e.into_inner());
        guard.map.clear();
        guard.dirty = false;
        guard.file = Some(file.clone());
        guard.loaded = true;
        if file.exists() {
            std::fs::remove_file(&file).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpaceNodeDto {
    name: String,
    path: String,
    bytes: u64,
    files: u64,
    cached: bool,
    children: Vec<SpaceNodeDto>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpaceTreeDto {
    root: SpaceNodeDto,
    scanning: bool,
    scanned: usize,
    total: usize,
}

#[derive(Serialize, Clone)]
pub struct SizeDto {
    name: String,
    bytes: u64,
    files: u64,
    /// True for a remembered number that is being checked again.
    stale: bool,
}

/// Totals remembered between launches: key -> [bytes, files, seconds since the Unix epoch].
#[derive(Default)]
struct Saved {
    map: HashMap<String, [u64; 3]>,
    loaded: bool,
    dirty: bool,
    last_save: Option<Instant>,
    file: Option<PathBuf>,
}

impl Saved {
    fn load(&mut self, file: PathBuf) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        self.map = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        self.file = Some(file);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let before = self.map.len();
        self.map.retain(|_, v| now.saturating_sub(v[2]) < SAVED_TTL_SECS);
        if self.map.len() != before {
            self.dirty = true; // rewritten smaller on the next flush
        }
    }

    fn get(&self, dir: &Path) -> Option<FolderSize> {
        self.map.get(&key_of(dir)).map(|v| FolderSize { bytes: v[0], files: v[1] })
    }

    /// Remembered totals for direct subfolders of `dir`, using memory only.
    fn children_of(&self, dir: &Path) -> Vec<(String, FolderSize)> {
        let prefix = format!("{}\\", key_of(dir));
        self.map
            .iter()
            .filter_map(|(k, v)| {
                let rest = k.strip_prefix(&prefix)?;
                if rest.is_empty() || rest.contains('\\') {
                    return None;
                }
                Some((rest.to_string(), FolderSize { bytes: v[0], files: v[1] }))
            })
            .collect()
    }

    /// Remembered totals up to `max_depth` levels under `dir`, using memory only.
    fn under(&self, dir: &Path, max_depth: usize) -> Vec<(String, FolderSize)> {
        let root_key = key_of(dir);
        let prefix = format!("{root_key}\\");
        self.map
            .iter()
            .filter_map(|(k, v)| {
                let rel = if k == &root_key {
                    ""
                } else {
                    let rest = k.strip_prefix(&prefix)?;
                    if rest.is_empty() || rest.matches('\\').count() >= max_depth {
                        return None;
                    }
                    rest
                };
                Some((rel.to_string(), FolderSize { bytes: v[0], files: v[1] }))
            })
            .collect()
    }

    fn set(&mut self, dir: &Path, size: FolderSize) {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        self.map.insert(key_of(dir), [size.bytes, size.files, now]);
        self.dirty = true;
    }

    /// Writes the file when something changed, at most once every few seconds unless `force`.
    fn flush(&mut self, force: bool) {
        if !self.dirty || self.file.is_none() {
            return;
        }
        if !force && self.last_save.is_some_and(|t| t.elapsed() < SAVE_EVERY) {
            return;
        }
        if self.map.len() > MAX_SAVED {
            let mut ages: Vec<(u64, String)> = self.map.iter().map(|(k, v)| (v[2], k.clone())).collect();
            ages.sort_unstable();
            for (_, k) in ages.into_iter().take(self.map.len() - MAX_SAVED * 9 / 10) {
                self.map.remove(&k);
            }
        }
        let file = self.file.clone().unwrap();
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = file.with_extension("json.tmp");
        let written = serde_json::to_vec(&self.map).ok().is_some_and(|b| std::fs::write(&tmp, b).is_ok());
        if written && std::fs::rename(&tmp, &file).is_ok() {
            self.dirty = false;
        }
        self.last_save = Some(Instant::now());
    }
}

/// Preloads the saved disk cache in the background at startup so the first folder sees cached sizes immediately.
pub fn warm_cache(app: &tauri::AppHandle) {
    let Ok(file) = crate::cache_cmd::resolve_cache_dir(app).map(|d| d.join(SAVE_FILE)) else {
        return;
    };
    let saved = app.state::<SizesState>().saved.clone();
    std::thread::spawn(move || {
        saved.lock().unwrap_or_else(|e| e.into_inner()).load(file);
    });
}

/// Returns an immediate, capped directory-size tree built strictly from cached/indexed memory.
#[tauri::command]
pub async fn disk_space_tree(app: tauri::AppHandle, root: String) -> Result<SpaceTreeDto, String> {
    if root.is_empty() {
        return Err("Empty root path".to_string());
    }
    let state: State<'_, SizesState> = app.state();
    let index = state.index.clone();
    let saved = state.saved.clone();
    let file = crate::cache_cmd::resolve_cache_dir(&app)?.join(SAVE_FILE);
    crate::off_main(move || {
        saved.lock().unwrap_or_else(|e| e.into_inner()).load(file);
        Ok(SpaceTreeDto {
            root: build_space_tree(Path::new(&root), &index, &saved),
            scanning: false,
            scanned: 0,
            total: 0,
        })
    })
    .await
}

/// Cancels any active disk-space scan started by the visualizer.
#[tauri::command]
pub fn cancel_disk_space(app: tauri::AppHandle) -> Result<(), String> {
    let state: State<'_, SizesState> = app.state();
    if let Some(prev) = state.space_cancel.lock().map_err(|e| e.to_string())?.take() {
        prev.cancel();
    }
    Ok(())
}

/// Scans top-level subfolders of `root` in parallel, streaming throttled sunburst updates.
#[tauri::command]
pub async fn scan_disk_space(app: tauri::AppHandle, root: String, on_update: Channel<SpaceTreeDto>) -> Result<(), String> {
    if root.is_empty() {
        return Err("Empty root path".to_string());
    }
    let cancel = CancelToken::default();
    let state: State<'_, SizesState> = app.state();
    {
        let mut slot = state.space_cancel.lock().map_err(|e| e.to_string())?;
        if let Some(prev) = slot.replace(cancel.clone()) {
            prev.cancel();
        }
    }
    let index = state.index.clone();
    let saved = state.saved.clone();
    let file = crate::cache_cmd::resolve_cache_dir(&app)?.join(SAVE_FILE);
    crate::off_main(move || {
        saved.lock().unwrap_or_else(|e| e.into_inner()).load(file);
        let root_path = PathBuf::from(&root);
        let names = subfolders(&root_path)?;
        let total = names.len();
        let _ = on_update.send(SpaceTreeDto {
            root: build_space_tree(&root_path, &index, &saved),
            scanning: true,
            scanned: 0,
            total,
        });

        let done = std::sync::atomic::AtomicUsize::new(0);
        let last_emit = Mutex::new(Instant::now());
        names.par_iter().for_each(|name| {
            if cancel.is_cancelled() {
                return;
            }
            let sub = root_path.join(name);
            let size = index.scan(&sub, &cancel);
            if !cancel.is_cancelled() {
                saved.lock().unwrap_or_else(|e| e.into_inner()).set(&sub, size);
            }
            let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            let should_emit = {
                let mut t = last_emit.lock().unwrap_or_else(|e| e.into_inner());
                if t.elapsed() >= Duration::from_millis(250) {
                    *t = Instant::now();
                    true
                } else {
                    false
                }
            };
            if should_emit && !cancel.is_cancelled() {
                let _ = on_update.send(SpaceTreeDto {
                    root: build_space_tree(&root_path, &index, &saved),
                    scanning: true,
                    scanned: n,
                    total,
                });
            }
        });
        saved.lock().unwrap_or_else(|e| e.into_inner()).flush(true);
        let _ = on_update.send(SpaceTreeDto {
            root: build_space_tree(&root_path, &index, &saved),
            scanning: false,
            scanned: done.load(std::sync::atomic::Ordering::Relaxed),
            total,
        });
        // A whole-drive scan can index millions of folders. The finished tree was just sent and the
        // top-level totals are saved to disk, so give the memory back instead of keeping it all live.
        if !cancel.is_cancelled() && index.len() > MAX_LIVE_DIRS {
            index.clear();
        }
        Ok(())
    })
    .await
}

const SPACE_DEPTH: usize = 4;
const SPACE_MAX_CHILDREN: usize = 16;

#[derive(Default)]
struct TrieNode {
    name: String,
    bytes: Option<u64>,
    files: u64,
    cached: bool,
    children: HashMap<String, TrieNode>,
}

impl TrieNode {
    fn insert_path(&mut self, rel: &str, bytes: u64, files: u64, cached: bool, child_names: &[String]) {
        let mut cur = self;
        if !rel.is_empty() {
            for seg in rel.split('\\') {
                let key = seg.to_lowercase();
                cur = cur.children.entry(key).or_insert_with(|| TrieNode {
                    name: seg.to_string(),
                    ..Default::default()
                });
                if !cached {
                    // Live index entries use exact disk spelling when available.
                    cur.name = seg.to_string();
                }
            }
        }
        if !cached || cur.bytes.is_none() {
            cur.bytes = Some(bytes);
            cur.files = files;
            cur.cached = cached;
        }
        for exact in child_names {
            let key = exact.to_lowercase();
            if let Some(child) = cur.children.get_mut(&key) {
                child.name = exact.clone();
            }
        }
    }

    fn into_dto(self, path: String, root_bytes: u64) -> SpaceNodeDto {
        let mut kids: Vec<SpaceNodeDto> = self
            .children
            .into_values()
            .map(|c| {
                let child_path = if path.ends_with('\\') {
                    format!("{path}{}", c.name)
                } else {
                    format!("{path}\\{}", c.name)
                };
                c.into_dto(child_path, root_bytes)
            })
            .filter(|c| c.bytes > 0)
            .collect();
        kids.sort_by(|a, b| b.bytes.cmp(&a.bytes));

        let child_bytes: u64 = kids.iter().map(|c| c.bytes).sum();
        let child_files: u64 = kids.iter().map(|c| c.files).sum();
        let bytes = self.bytes.unwrap_or(child_bytes).max(child_bytes);
        let files = if self.bytes.is_some() { self.files.max(child_files) } else { child_files };

        let min_slice = (root_bytes / 220).max(1);
        let mut kept = Vec::new();
        let mut other_bytes = 0u64;
        let mut other_files = 0u64;
        for kid in kids {
            if kept.len() < SPACE_MAX_CHILDREN && kid.bytes >= min_slice {
                kept.push(kid);
            } else {
                other_bytes += kid.bytes;
                other_files += kid.files;
            }
        }
        if other_bytes > 0 {
            kept.push(SpaceNodeDto {
                name: "Other".to_string(),
                path: String::new(),
                bytes: other_bytes,
                files: other_files,
                cached: self.cached,
                children: Vec::new(),
            });
        }
        SpaceNodeDto { name: self.name, path, bytes, files, cached: self.cached, children: kept }
    }
}

fn build_space_tree(root: &Path, index: &SizeIndex, saved: &Mutex<Saved>) -> SpaceNodeDto {
    let root_str = root.to_string_lossy().into_owned();
    let root_label = root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| root_str.trim_end_matches('\\').to_string());
    let mut trie = TrieNode { name: root_label, ..Default::default() };

    for (rel, size, subdirs) in index.snapshot_under(root, SPACE_DEPTH) {
        trie.insert_path(&rel, size.bytes, size.files, false, &subdirs);
    }
    {
        let guard = saved.lock().unwrap_or_else(|e| e.into_inner());
        for (rel, size) in guard.under(root, SPACE_DEPTH) {
            trie.insert_path(&rel, size.bytes, size.files, true, &[]);
        }
    }

    // First pass computes root total so the second/threshold check uses true root scale.
    fn sum_bytes(n: &TrieNode) -> u64 {
        let kids: u64 = n.children.values().map(sum_bytes).sum();
        n.bytes.unwrap_or(kids).max(kids)
    }
    let root_total = sum_bytes(&trie);
    trie.into_dto(root_str, root_total)
}

/// Returns already-known subfolder sizes for `dir` from memory and the disk cache without scanning.
#[tauri::command]
pub async fn cached_folder_sizes(app: tauri::AppHandle, dir: String) -> Result<Vec<SizeDto>, String> {
    if dir.is_empty() {
        return Ok(Vec::new());
    }
    let state: State<'_, SizesState> = app.state();
    let index = state.index.clone();
    let saved = state.saved.clone();
    let file = crate::cache_cmd::resolve_cache_dir(&app)?.join(SAVE_FILE);
    crate::off_main(move || {
        let root = PathBuf::from(&dir);
        let mut by_name: HashMap<String, SizeDto> = HashMap::new();
        for (name, size) in index.cached_children(&root) {
            by_name.insert(
                name.to_lowercase(),
                SizeDto { name, bytes: size.bytes, files: size.files, stale: false },
            );
        }
        let mut guard = saved.lock().unwrap_or_else(|e| e.into_inner());
        guard.load(file);
        for (name, size) in guard.children_of(&root) {
            by_name.entry(name.to_lowercase()).or_insert(SizeDto {
                name,
                bytes: size.bytes,
                files: size.files,
                stale: true,
            });
        }
        Ok(by_name.into_values().collect())
    })
    .await
}

/// Streams the recursive size of each subfolder, then keeps pushing changes until the tab asks for
/// something else. A new call for the same tab cancels the previous one; an empty `dir` only cancels.
#[tauri::command]
pub async fn folder_sizes(app: tauri::AppHandle, tab_id: String, dir: String, on_size: Channel<SizeDto>) -> Result<(), String> {
    let cancel = CancelToken::default();
    let state: State<'_, SizesState> = app.state();
    {
        let mut running = state.running.lock().map_err(|e| e.to_string())?;
        if let Some(prev) = running.insert(tab_id, cancel.clone()) {
            prev.cancel();
        }
    }
    if dir.is_empty() {
        return Ok(());
    }
    let index = state.index.clone();
    let saved = state.saved.clone();
    let file = crate::cache_cmd::resolve_cache_dir(&app)?.join(SAVE_FILE);
    crate::off_main(move || {
        saved.lock().unwrap_or_else(|e| e.into_inner()).load(file);
        run(PathBuf::from(dir), cancel, on_size, index, saved)
    })
    .await
}

fn subfolders(dir: &Path) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    octo_core::enumerate_dir(dir, |e| {
        if e.kind == EntryKind::Dir && e.attrs & attrs::REPARSE_POINT == 0 {
            names.push(String::from_utf16_lossy(e.name));
        }
    })
    .map_err(|e| e.to_string())?;
    Ok(names)
}

fn send(on_size: &Channel<SizeDto>, name: &str, size: FolderSize, stale: bool) -> bool {
    on_size.send(SizeDto { name: name.to_string(), bytes: size.bytes, files: size.files, stale }).is_ok()
}

fn run(dir: PathBuf, cancel: CancelToken, on_size: Channel<SizeDto>, index: Arc<SizeIndex>, saved: Arc<Mutex<Saved>>) -> Result<(), String> {
    let names = subfolders(&dir)?;

    // 1. What we already know, at once.
    {
        let saved = saved.lock().unwrap_or_else(|e| e.into_inner());
        for name in &names {
            let path = dir.join(name);
            if let Some(size) = index.total(&path).or_else(|| saved.get(&path)) {
                send(&on_size, name, size, true);
            }
        }
    }

    // 2. Watch first, so nothing that changes during the scan is missed.
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let watcher = start_watcher(&dir, tx);

    // 3. Scan every subfolder and replace the stale numbers.
    names.par_iter().for_each(|name| {
        let path = dir.join(name);
        let size = index.scan(&path, &cancel);
        if !cancel.is_cancelled() {
            saved.lock().unwrap_or_else(|e| e.into_inner()).set(&path, size);
            send(&on_size, name, size, false);
        }
    });
    saved.lock().unwrap_or_else(|e| e.into_inner()).flush(true);
    if !cancel.is_cancelled() {
        index.trim(MAX_LIVE_DIRS, &dir);
    }

    // 4. Keep the numbers live in the background until this tab moves on.
    if let Some(watcher) = watcher {
        std::thread::spawn(move || follow(dir, cancel, on_size, index, saved, rx, watcher));
    }
    Ok(())
}

fn start_watcher(dir: &Path, tx: mpsc::Sender<PathBuf>) -> Option<RecommendedWatcher> {
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res
            && !event.kind.is_access()
        {
            for path in event.paths {
                let _ = tx.send(path);
            }
        }
    })
    .ok()?;
    watcher.watch(dir, RecursiveMode::Recursive).ok()?;
    Some(watcher)
}

/// The name of the folder directly under `root` that contains `path`.
fn child_under(root: &Path, path: &Path) -> Option<String> {
    let (rk, pk) = (key_of(root), key_of(path));
    let rest = pk.strip_prefix(&rk)?.strip_prefix('\\')?;
    if rest.is_empty() {
        return None;
    }
    let depth = key_of(root).split('\\').count();
    let original = path.to_string_lossy().replace('/', "\\");
    original.trim_end_matches('\\').split('\\').nth(depth).map(str::to_string)
}

fn follow(dir: PathBuf, cancel: CancelToken, on_size: Channel<SizeDto>, index: Arc<SizeIndex>, saved: Arc<Mutex<Saved>>, rx: mpsc::Receiver<PathBuf>, _watcher: RecommendedWatcher) {
    let mut pending: HashSet<PathBuf> = HashSet::new();
    let mut first_change: Option<Instant> = None;
    while !cancel.is_cancelled() {
        match rx.recv_timeout(QUIET) {
            Ok(path) => {
                first_change.get_or_insert_with(Instant::now);
                pending.insert(path);
                // Keep collecting while changes keep arriving, but never wait forever.
                if first_change.is_some_and(|t| t.elapsed() < MAX_WAIT) {
                    continue;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if pending.is_empty() {
            saved.lock().unwrap_or_else(|e| e.into_inner()).flush(false);
            continue;
        }
        let changed: Vec<PathBuf> = pending.drain().collect();
        first_change = None;
        apply_changes(&dir, &cancel, &on_size, &index, &saved, &changed);
        saved.lock().unwrap_or_else(|e| e.into_inner()).flush(false);
    }
}

/// Reads the folders the changes happened in, then reports the new total of each affected subfolder.
fn apply_changes(dir: &Path, cancel: &CancelToken, on_size: &Channel<SizeDto>, index: &SizeIndex, saved: &Mutex<Saved>, changed: &[PathBuf]) {
    let affected: HashSet<String> = changed.iter().filter_map(|p| child_under(dir, p)).collect();
    if affected.is_empty() {
        return;
    }
    let dirty: HashSet<PathBuf> = changed.iter().filter_map(|p| index.dirty_dir(p)).collect();
    if dirty.len() > MAX_REFRESH {
        // A huge burst (an unzip, a build): rescanning the touched subfolders is cheaper than thousands of reads.
        affected.par_iter().for_each(|name| {
            index.scan(&dir.join(name), cancel);
        });
    } else {
        for d in &dirty {
            if cancel.is_cancelled() {
                return;
            }
            index.refresh_dir(d, cancel);
        }
    }
    for name in &affected {
        let path = dir.join(name);
        // A subfolder deleted outside the app has no total any more; the list refresh removes its row.
        // Unknown because the index was trimmed (not because the folder is gone): read it again.
        let size = match index.total(&path) {
            Some(size) => size,
            None if path.is_dir() && !cancel.is_cancelled() => {
                index.scan(&path, cancel);
                match index.total(&path) {
                    Some(size) => size,
                    None => continue,
                }
            }
            None => continue,
        };
        saved.lock().unwrap_or_else(|e| e.into_inner()).set(&path, size);
        if !send(on_size, name, size, false) {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_subfolder_a_change_belongs_to() {
        let root = Path::new("C:\\Users\\Me");
        assert_eq!(child_under(root, Path::new("C:\\Users\\Me\\Docs\\a\\b.txt")), Some("Docs".to_string()));
        assert_eq!(child_under(root, Path::new("c:\\users\\me\\Docs")), Some("Docs".to_string()));
        assert_eq!(child_under(root, Path::new("C:\\Users\\Me")), None);
        assert_eq!(child_under(root, Path::new("C:\\Users\\Other\\x")), None);
        assert_eq!(child_under(root, Path::new("C:\\Users\\MeToo\\x")), None);
    }

    #[test]
    fn saved_totals_round_trip_and_prune() {
        let dir = std::env::temp_dir().join(format!("octopolis-size-test-{}", std::process::id()));
        let file = dir.join(SAVE_FILE);
        let mut saved = Saved::default();
        saved.load(file.clone());
        saved.set(Path::new("C:\\A\\"), FolderSize { bytes: 5, files: 2 });
        saved.flush(true);

        let mut again = Saved::default();
        again.load(file);
        assert_eq!(again.get(Path::new("c:\\a")), Some(FolderSize { bytes: 5, files: 2 }));

        again.set(Path::new("C:\\A\\Child"), FolderSize { bytes: 12, files: 1 });
        again.set(Path::new("C:\\A\\Child\\Grand"), FolderSize { bytes: 4, files: 1 });
        assert_eq!(again.children_of(Path::new("C:\\A")), vec![("child".to_string(), FolderSize { bytes: 12, files: 1 })]);

        let index = SizeIndex::default();
        let tree = build_space_tree(Path::new("C:\\A"), &index, &Mutex::new(again));
        assert_eq!(tree.bytes, 12);
        assert_eq!(tree.children.len(), 1);
        assert_eq!(tree.children[0].name, "child");
        assert_eq!(tree.children[0].children[0].name, "grand");
        let _ = std::fs::remove_dir_all(dir);
    }
}
