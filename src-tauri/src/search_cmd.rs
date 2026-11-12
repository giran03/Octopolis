//! Recursive search over a cached index per root folder.
//!
//! The first search under a root builds its index (with progress); later
//! keystrokes reuse it. A recursive watcher marks an index stale when files
//! change; a stale index is rebuilt on the next search once it is older than
//! `REBUILD_AFTER`, or immediately when the user refreshes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use octo_core::codec::BatchEncoder;
use octo_core::ops::CancelToken;
use octo_core::search::{self, Index, IndexMode, query, rank};
use octo_core::{EntryKind, RawEntry};
use serde::Serialize;
use tauri::Manager;
use tauri::ipc::{Channel, InvokeResponseBody};

const MAX_CACHED_ROOTS: usize = 2;
/// Built indexes may use this much memory together; the least recently used ones are dropped beyond it.
const MAX_INDEX_BYTES: u64 = 384 * 1024 * 1024;
/// An index (and its watcher) nobody searched in this long is dropped. Rebuilding takes seconds.
const IDLE_EVICT: Duration = Duration::from_secs(10 * 60);
const SWEEP_EVERY: Duration = Duration::from_secs(60);
const REBUILD_AFTER: Duration = Duration::from_secs(30);
const RESULT_LIMIT: usize = 100_000;
/// Sizes unknown to the NTFS journal are looked up for this many top hits.
const SIZE_LOOKUPS: usize = 2_000;
const BATCH: u32 = 8192;
const PROGRESS_EVERY: Duration = Duration::from_millis(150);

struct Built {
    index: Index,
    mode: IndexMode,
    built_at: Instant,
}

struct Slot {
    built: Mutex<Option<Arc<Built>>>,
    stale: Arc<AtomicBool>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    last_used: Mutex<Instant>,
}

impl Slot {
    fn bytes(&self) -> u64 {
        self.built.try_lock().ok().and_then(|b| b.as_ref().map(|b| b.index.heap_bytes())).unwrap_or(0)
    }
}

/// Starts the background sweeper that frees idle search indexes.
pub fn start_idle_sweeper(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(SWEEP_EVERY);
        app.state::<SearchState>().sweep_idle();
    });
}

#[derive(Default)]
pub struct SearchState {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
    /// The running search per tab, cancelled when the tab starts another.
    running: Mutex<HashMap<String, CancelToken>>,
}

impl SearchState {
    pub fn cached_count(&self) -> usize {
        self.slots.lock().map(|s| s.len()).unwrap_or(0)
    }

    /// Approximate memory held by the built indexes.
    pub fn cached_bytes(&self) -> u64 {
        let Ok(slots) = self.slots.lock() else { return 0 };
        slots.values().map(|s| s.bytes()).sum()
    }

    /// Drops indexes nobody searched in for a while, along with their folder watchers.
    pub fn sweep_idle(&self) {
        if let Ok(mut slots) = self.slots.lock() {
            slots.retain(|_, s| s.last_used.lock().map(|t| t.elapsed() < IDLE_EVICT).unwrap_or(false));
        }
    }

    /// Drops least recently used indexes (never `keep`) until the total fits the memory budget.
    fn enforce_budget(&self, keep: &str) {
        let Ok(mut slots) = self.slots.lock() else { return };
        while slots.values().map(|s| s.bytes()).sum::<u64>() > MAX_INDEX_BYTES {
            let victim = slots
                .iter()
                .filter(|(k, _)| k.as_str() != keep)
                .min_by_key(|(_, s)| s.last_used.lock().map(|t| *t).unwrap_or_else(|_| Instant::now()))
                .map(|(k, _)| k.clone());
            match victim {
                Some(k) => slots.remove(&k),
                None => break,
            };
        }
    }

    pub fn clear_cache(&self) {
        if let Ok(mut running) = self.running.lock() {
            for (_, tok) in running.drain() {
                tok.cancel();
            }
        }
        if let Ok(mut slots) = self.slots.lock() {
            slots.clear();
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSummary {
    matched: usize,
    shown: usize,
    indexed: usize,
    mode: &'static str,
    /// Set when this search had to (re)build the index.
    index_ms: Option<f64>,
    elapsed_ms: f64,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn search(
    app: tauri::AppHandle,
    tab_id: String,
    root: PathBuf,
    query: String,
    rebuild: bool,
    on_batch: Channel<InvokeResponseBody>,
    on_progress: Channel<u64>,
) -> Result<SearchSummary, String> {
    let mut q = query::parse(&query).map_err(|e| e.to_string())?;
    // Tags live in their own index, outside the folder index.
    if let Some(tag) = q.tag.clone() {
        q.tagged = Some(std::sync::Arc::new(crate::tools_cmd::with_tags(&app, |t| (t.keys_with_tag(&tag), false))?));
    }
    let cancel = CancelToken::default();
    {
        let state = app.state::<SearchState>();
        let mut running = state.running.lock().map_err(|e| e.to_string())?;
        if let Some(prev) = running.insert(tab_id, cancel.clone()) {
            prev.cancel();
        }
    }
    crate::off_main(move || {
        let started = Instant::now();
        let slot = slot_for(&app, &root)?;
        let (built, index_ms) = ensure_index(&slot, &root, rebuild, &on_progress)?;
        if index_ms.is_some() {
            app.state::<SearchState>().enforce_budget(&root.to_string_lossy().to_lowercase());
        }
        let result = rank::run(&built.index, &q, RESULT_LIMIT, &cancel);
        if cancel.is_cancelled() {
            return Err("cancelled".into());
        }
        stream_hits(&built.index, &result.hits, &on_batch)?;
        Ok(SearchSummary {
            matched: result.matched,
            shown: result.hits.len(),
            indexed: built.index.len(),
            mode: match built.mode {
                IndexMode::Usn => "usn",
                IndexMode::Walk => "walk",
            },
            index_ms,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        })
    })
    .await
}

#[tauri::command]
pub fn cancel_search(state: tauri::State<'_, SearchState>, tab_id: String) -> Result<(), String> {
    if let Some(token) = state.running.lock().map_err(|e| e.to_string())?.remove(&tab_id) {
        token.cancel();
    }
    Ok(())
}

fn slot_for(app: &tauri::AppHandle, root: &Path) -> Result<Arc<Slot>, String> {
    let state = app.state::<SearchState>();
    let mut slots = state.slots.lock().map_err(|e| e.to_string())?;
    let key = root.to_string_lossy().to_lowercase();
    if let Some(slot) = slots.get(&key) {
        *slot.last_used.lock().map_err(|e| e.to_string())? = Instant::now();
        return Ok(slot.clone());
    }
    if slots.len() >= MAX_CACHED_ROOTS {
        // Drop the least recently used index to bound memory.
        let oldest = slots
            .iter()
            .min_by_key(|(_, s)| s.last_used.lock().map(|t| *t).unwrap_or_else(|_| Instant::now()))
            .map(|(k, _)| k.clone());
        if let Some(k) = oldest {
            slots.remove(&k);
        }
    }
    let slot = Arc::new(Slot {
        built: Mutex::new(None),
        stale: Arc::new(AtomicBool::new(false)),
        watcher: Mutex::new(None),
        last_used: Mutex::new(Instant::now()),
    });
    slots.insert(key, slot.clone());
    Ok(slot)
}

fn ensure_index(
    slot: &Slot,
    root: &Path,
    rebuild: bool,
    on_progress: &Channel<u64>,
) -> Result<(Arc<Built>, Option<f64>), String> {
    // Holding the lock while building makes concurrent searches on the same
    // root wait for one build instead of starting their own.
    let mut built = slot.built.lock().map_err(|e| e.to_string())?;
    if let Some(b) = built.as_ref() {
        let expired = slot.stale.load(Ordering::Relaxed) && b.built_at.elapsed() > REBUILD_AFTER;
        if !rebuild && !expired {
            return Ok((b.clone(), None));
        }
    }
    // Watch first and clear the flag first, so changes during the build count.
    start_watcher(slot, root);
    slot.stale.store(false, Ordering::Relaxed);
    let started = Instant::now();
    // The build serves every search on this root, so a newer keystroke
    // cancelling an older search must not abort it.
    let build_token = CancelToken::default();
    let scanned = AtomicU64::new(0);
    let done = AtomicBool::new(false);
    let result = std::thread::scope(|s| {
        s.spawn(|| {
            while !done.load(Ordering::Relaxed) {
                let _ = on_progress.send(scanned.load(Ordering::Relaxed));
                std::thread::sleep(PROGRESS_EVERY);
            }
        });
        let r = search::build_index(root, &build_token, &scanned);
        done.store(true, Ordering::Relaxed);
        r
    });
    let (index, mode) = result.map_err(|e| e.to_string())?;
    let fresh = Arc::new(Built { index, mode, built_at: Instant::now() });
    *built = Some(fresh.clone());
    Ok((fresh, Some(started.elapsed().as_secs_f64() * 1000.0)))
}

fn start_watcher(slot: &Slot, root: &Path) {
    let Ok(mut guard) = slot.watcher.lock() else { return };
    if guard.is_some() {
        return;
    }
    let stale = slot.stale.clone();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok_and(|e| !e.kind.is_access()) {
            stale.store(true, Ordering::Relaxed);
        }
    });
    if let Ok(mut w) = watcher
        && w.watch(root, RecursiveMode::Recursive).is_ok()
    {
        *guard = Some(w);
    }
}

/// Sends hits as listing batches whose names are paths relative to the root.
fn stream_hits(index: &Index, hits: &[rank::Hit], channel: &Channel<InvokeResponseBody>) -> Result<(), String> {
    let mut enc = BatchEncoder::with_capacity(256 * 1024);
    let mut units: Vec<u16> = Vec::with_capacity(260);
    for (n, hit) in hits.iter().enumerate() {
        let i = hit.index as usize;
        let mut size = index.sizes[i];
        if size == u64::MAX {
            size = if n < SIZE_LOOKUPS { std::fs::metadata(index.full_path(hit.index)).map_or(0, |m| m.len()) } else { 0 };
        }
        units.clear();
        units.extend(index.rel_path(hit.index).encode_utf16());
        enc.push(&RawEntry {
            name: &units,
            kind: index.kinds[i],
            attrs: index.attrs[i],
            size: if index.kinds[i] == EntryKind::Dir { 0 } else { size },
            modified_ms: index.modified_ms[i],
        });
        if enc.len() >= BATCH {
            channel.send(InvokeResponseBody::Raw(enc.finish(false))).map_err(|e| e.to_string())?;
        }
    }
    channel.send(InvokeResponseBody::Raw(enc.finish(true))).map_err(|e| e.to_string())
}
