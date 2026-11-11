//! File operations: copy, move, delete, rename and new folder.
//!
//! Long operations run synchronously on the caller's thread and report
//! progress through a callback; callers put them on a worker thread. Errors on
//! single items are collected and the operation carries on, so one locked file
//! never aborts a whole transfer.

mod paths;
mod remove;
mod simple;
mod transfer;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub use paths::is_within;
pub use remove::restore_recycled;
pub use simple::{batch_rename, create_folder, remove_empty_dir, rename};

#[derive(Debug, Clone)]
pub enum Operation {
    Copy { sources: Vec<PathBuf>, dest: PathBuf },
    Move { sources: Vec<PathBuf>, dest: PathBuf },
    Delete { paths: Vec<PathBuf>, permanent: bool },
    /// Moves each item to an exact destination path (used by undo and redo).
    Relocate { pairs: Vec<(PathBuf, PathBuf)> },
}

/// Transfer behaviour beyond the conflict policy.
#[derive(Debug, Clone, Copy, Default)]
pub struct Options {
    pub conflict: Conflict,
    /// Compare BLAKE3 hashes of source and copy after each file.
    pub verify: bool,
    /// Maximum transfer speed in bytes per second.
    pub limit_bps: Option<u64>,
}

/// What to do when a top-level item already exists at the destination.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Conflict {
    /// Pick a free name such as `report (2).pdf`.
    #[default]
    KeepBoth,
    /// Replace files and merge folders.
    Overwrite,
    Skip,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Progress {
    pub total_bytes: u64,
    pub done_bytes: u64,
    pub total_items: u64,
    pub done_items: u64,
    pub current: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemError {
    pub path: PathBuf,
    pub message: String,
}

#[derive(Debug, Clone, Default)]
pub struct Report {
    pub errors: Vec<ItemError>,
    pub skipped: Vec<PathBuf>,
    /// Top-level paths created at the destination (for selecting them after).
    pub created: Vec<PathBuf>,
    /// (source, destination) of each completed top-level copy or move.
    pub pairs: Vec<(PathBuf, PathBuf)>,
    pub cancelled: bool,
}

/// Shared flags a UI sets to stop or pause a running operation between
/// chunks and items.
#[derive(Debug, Clone, Default)]
pub struct CancelToken {
    cancelled: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
}

impl CancelToken {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::Relaxed);
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }
}

/// Runs an operation with default options.
pub fn run(
    op: &Operation,
    conflict: Conflict,
    cancel: &CancelToken,
    on_progress: &mut dyn FnMut(&Progress),
) -> Report {
    run_with(op, &Options { conflict, ..Options::default() }, cancel, on_progress)
}

/// Runs an operation to completion (or cancellation).
pub fn run_with(
    op: &Operation,
    options: &Options,
    cancel: &CancelToken,
    on_progress: &mut dyn FnMut(&Progress),
) -> Report {
    let mut ctx = Ctx::new(cancel.clone(), *options, on_progress);
    let conflict = options.conflict;
    match op {
        Operation::Copy { sources, dest } => transfer::copy(&mut ctx, sources, dest, conflict),
        Operation::Move { sources, dest } => transfer::relocate(&mut ctx, sources, dest, conflict),
        Operation::Delete { paths, permanent } => remove::delete(&mut ctx, paths, *permanent),
        Operation::Relocate { pairs } => transfer::relocate_exact(&mut ctx, pairs),
    }
    ctx.progress.current = None;
    ctx.emit(true);
    ctx.report.cancelled = cancel.is_cancelled();
    ctx.report
}

const PROGRESS_INTERVAL: Duration = Duration::from_millis(33);

/// Mutable state shared by the operation implementations.
pub(crate) struct Ctx<'a> {
    cancel: CancelToken,
    on_progress: &'a mut dyn FnMut(&Progress),
    last_emit: Option<Instant>,
    /// When transfer accounting started, for the speed limit.
    window: Option<(Instant, u64)>,
    pub options: Options,
    pub progress: Progress,
    pub report: Report,
}

impl<'a> Ctx<'a> {
    fn new(cancel: CancelToken, options: Options, on_progress: &'a mut dyn FnMut(&Progress)) -> Self {
        Self { cancel, on_progress, last_emit: None, window: None, options, progress: Progress::default(), report: Report::default() }
    }

    /// True once cancelled. Blocks here while the operation is paused.
    pub fn cancelled(&mut self) -> bool {
        while self.cancel.is_paused() && !self.cancel.is_cancelled() {
            self.window = None; // paused time must not count against the limit
            std::thread::sleep(Duration::from_millis(40));
        }
        self.cancel.is_cancelled()
    }

    /// Starts speed-limit accounting before the first chunk is counted.
    pub fn begin_window(&mut self) {
        if self.window.is_none() {
            self.window = Some((Instant::now(), self.progress.done_bytes));
        }
    }

    /// Sleeps as needed to keep the transfer under the speed limit.
    pub fn throttle(&mut self) {
        let Some(limit) = self.options.limit_bps.filter(|l| *l > 0) else { return };
        let done = self.progress.done_bytes;
        let (start, base) = *self.window.get_or_insert((Instant::now(), done));
        let target = Duration::from_secs_f64(done.saturating_sub(base) as f64 / limit as f64);
        if let Some(wait) = target.checked_sub(start.elapsed()) {
            std::thread::sleep(wait);
        }
    }

    /// Reports progress, throttled to about 30 updates per second unless forced.
    pub fn emit(&mut self, force: bool) {
        let now = Instant::now();
        let due = self.last_emit.is_none_or(|t| now.duration_since(t) >= PROGRESS_INTERVAL);
        if force || due {
            self.last_emit = Some(now);
            (self.on_progress)(&self.progress);
        }
    }

    /// Makes the next `emit` go through, so a newly started large file shows
    /// up immediately instead of waiting out the throttle window.
    pub fn reset_throttle(&mut self) {
        self.last_emit = None;
    }

    pub fn fail(&mut self, path: impl Into<PathBuf>, err: impl std::fmt::Display) {
        self.report.errors.push(ItemError { path: path.into(), message: err.to_string() });
    }
}

#[cfg(test)]
mod tests;
