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
pub use simple::{create_folder, rename};

#[derive(Debug, Clone)]
pub enum Operation {
    Copy { sources: Vec<PathBuf>, dest: PathBuf },
    Move { sources: Vec<PathBuf>, dest: PathBuf },
    Delete { paths: Vec<PathBuf>, permanent: bool },
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
    pub cancelled: bool,
}

/// Shared flag a UI sets to stop a running operation between chunks/items.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// Runs an operation to completion (or cancellation).
pub fn run(
    op: &Operation,
    conflict: Conflict,
    cancel: &CancelToken,
    on_progress: &mut dyn FnMut(&Progress),
) -> Report {
    let mut ctx = Ctx::new(cancel.clone(), on_progress);
    match op {
        Operation::Copy { sources, dest } => transfer::copy(&mut ctx, sources, dest, conflict),
        Operation::Move { sources, dest } => transfer::relocate(&mut ctx, sources, dest, conflict),
        Operation::Delete { paths, permanent } => remove::delete(&mut ctx, paths, *permanent),
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
    pub progress: Progress,
    pub report: Report,
}

impl<'a> Ctx<'a> {
    fn new(cancel: CancelToken, on_progress: &'a mut dyn FnMut(&Progress)) -> Self {
        Self { cancel, on_progress, last_emit: None, progress: Progress::default(), report: Report::default() }
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.is_cancelled()
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
