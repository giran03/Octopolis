//! Copy and move.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use super::paths::{is_within, same_volume};
use super::{Conflict, Ctx};
use crate::names::unique_path;

/// Files below this size go through `fs::copy` (CopyFileExW on Windows) in one
/// call; bigger ones are copied in chunks so progress and cancel stay live.
const CHUNKED_THRESHOLD: u64 = 8 * 1024 * 1024;
const CHUNK: usize = 4 * 1024 * 1024;
/// Win32 ERROR_NOT_SAME_DEVICE, returned by rename across volumes.
const ERROR_NOT_SAME_DEVICE: i32 = 17;

pub fn copy(ctx: &mut Ctx<'_>, sources: &[PathBuf], dest: &Path, conflict: Conflict) {
    measure(ctx, sources);
    for src in sources {
        if ctx.cancelled() {
            return;
        }
        let Some(target) = resolve_target(ctx, src, dest, conflict, false) else { continue };
        let before = ctx.report.errors.len();
        copy_tree(ctx, src, &target, conflict);
        if ctx.report.errors.len() == before && !ctx.cancelled() {
            ctx.report.created.push(target);
        }
    }
}

pub fn relocate(ctx: &mut Ctx<'_>, sources: &[PathBuf], dest: &Path, conflict: Conflict) {
    let cross: Vec<PathBuf> = sources.iter().filter(|s| !same_volume(s, dest)).cloned().collect();
    measure(ctx, &cross);
    ctx.progress.total_items += (sources.len() - cross.len()) as u64;

    for src in sources {
        if ctx.cancelled() {
            return;
        }
        if src.parent().is_some_and(|p| is_within(p, dest) && is_within(dest, p)) {
            ctx.report.skipped.push(src.clone()); // already in the destination
            ctx.progress.done_items += 1;
            continue;
        }
        let Some(target) = resolve_target(ctx, src, dest, conflict, true) else { continue };
        ctx.progress.current = Some(src.clone());
        // On Windows `fs::rename` is MoveFileExW(MOVEFILE_REPLACE_EXISTING): an
        // existing file target is replaced atomically, never deleted first.
        match fs::rename(src, &target) {
            Ok(()) => {
                ctx.progress.done_items += 1;
                ctx.report.created.push(target);
                ctx.emit(false);
            }
            // Folders can't be renamed over each other; merging them is only
            // allowed when the user chose to overwrite.
            Err(e) if is_cross_device(&e) || (conflict == Conflict::Overwrite && target.is_dir()) => {
                let before = ctx.report.errors.len();
                copy_tree(ctx, src, &target, conflict);
                if ctx.report.errors.len() == before && !ctx.cancelled() {
                    super::remove::remove_permanently(ctx, src);
                    ctx.report.created.push(target);
                }
            }
            Err(e) => ctx.fail(src, crate::Error::io(src, e)),
        }
    }
}

fn is_cross_device(e: &io::Error) -> bool {
    e.raw_os_error() == Some(ERROR_NOT_SAME_DEVICE) || e.kind() == io::ErrorKind::CrossesDevices
}


/// Decides where `src` lands inside `dest`, applying the conflict policy.
/// Returns `None` (after recording why) when the item must not be transferred.
fn resolve_target(ctx: &mut Ctx<'_>, src: &Path, dest: &Path, conflict: Conflict, moving: bool) -> Option<PathBuf> {
    let Some(name) = src.file_name() else {
        ctx.fail(src, "cannot transfer a drive root");
        return None;
    };
    if src.is_dir() && is_within(dest, src) {
        ctx.fail(src, crate::Error::IntoItself(src.into()));
        return None;
    }
    let target = dest.join(name);
    let exists = target.symlink_metadata().is_ok();
    let is_self = is_within(&target, src) && is_within(src, &target);
    match (exists, conflict) {
        (false, _) => Some(target),
        // Copying onto itself always keeps both, like Explorer does.
        (true, _) if is_self && !moving => Some(unique_path(dest, &name.to_string_lossy(), src.is_dir())),
        (true, Conflict::KeepBoth) => Some(unique_path(dest, &name.to_string_lossy(), src.is_dir())),
        (true, Conflict::Overwrite) => Some(target),
        (true, Conflict::Skip) => {
            ctx.report.skipped.push(src.into());
            None
        }
    }
}

/// Adds the size and item count of `sources` to the progress totals.
fn measure(ctx: &mut Ctx<'_>, sources: &[PathBuf]) {
    fn walk(p: &Path, bytes: &mut u64, items: &mut u64) {
        let Ok(meta) = p.symlink_metadata() else { return };
        *items += 1;
        if meta.is_dir() && !meta.is_symlink() {
            for child in fs::read_dir(p).into_iter().flatten().flatten() {
                walk(&child.path(), bytes, items);
            }
        } else {
            *bytes += meta.len();
        }
    }
    let (mut bytes, mut items) = (0, 0);
    for s in sources {
        walk(s, &mut bytes, &mut items);
    }
    ctx.progress.total_bytes += bytes;
    ctx.progress.total_items += items;
    ctx.emit(true);
}

fn copy_tree(ctx: &mut Ctx<'_>, src: &Path, dst: &Path, conflict: Conflict) {
    if ctx.cancelled() {
        return;
    }
    let meta = match src.symlink_metadata() {
        Ok(m) => m,
        Err(e) => return ctx.fail(src, crate::Error::io(src, e)),
    };
    ctx.progress.current = Some(src.into());
    if meta.is_symlink() {
        ctx.progress.done_items += 1;
        return ctx.fail(src, "links and junctions are not copied yet");
    }
    if !meta.is_dir() {
        if dst.exists() && conflict != Conflict::Overwrite {
            ctx.report.skipped.push(src.into());
        } else if let Err(e) = copy_file(ctx, src, dst, meta.len()) {
            ctx.fail(src, crate::Error::io(src, e));
        }
        ctx.progress.done_items += 1;
        return ctx.emit(false);
    }
    if let Err(e) = fs::create_dir_all(dst) {
        return ctx.fail(dst, crate::Error::io(dst, e));
    }
    ctx.progress.done_items += 1;
    let children = match fs::read_dir(src) {
        Ok(rd) => rd,
        Err(e) => return ctx.fail(src, crate::Error::io(src, e)),
    };
    for child in children {
        match child {
            Ok(c) => copy_tree(ctx, &c.path(), &dst.join(c.file_name()), conflict),
            Err(e) => ctx.fail(src, crate::Error::io(src, e)),
        }
    }
}

fn copy_file(ctx: &mut Ctx<'_>, src: &Path, dst: &Path, len: u64) -> io::Result<()> {
    if len < CHUNKED_THRESHOLD {
        fs::copy(src, dst)?;
        ctx.progress.done_bytes += len;
        return Ok(());
    }
    // Write next to the destination and swap it in only when complete, so a
    // cancelled or failed overwrite leaves the existing file untouched.
    let tmp = temp_sibling(dst);
    let result = copy_chunked(ctx, src, &tmp);
    if result.is_err() || ctx.cancelled() {
        let _ = fs::remove_file(&tmp);
        return result;
    }
    fs::rename(&tmp, dst).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// `dir\.name.octo-partial` beside `dst`, on the same volume so the final
/// rename is atomic.
fn temp_sibling(dst: &Path) -> PathBuf {
    let name = dst.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    dst.with_file_name(format!(".{name}.octo-partial"))
}

fn copy_chunked(ctx: &mut Ctx<'_>, src: &Path, dst: &Path) -> io::Result<()> {
    let mut reader = File::open(src)?;
    let meta = reader.metadata()?;
    let mut writer = File::create(dst)?;
    writer.set_len(meta.len())?; // preallocate to reduce fragmentation
    let mut buf = vec![0u8; CHUNK];
    ctx.reset_throttle();
    loop {
        if ctx.cancelled() {
            return Ok(());
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        ctx.progress.done_bytes += n as u64;
        ctx.emit(false);
    }
    writer.flush()?;
    if let Ok(modified) = meta.modified() {
        let _ = writer.set_modified(modified);
    }
    drop(writer);
    fs::set_permissions(dst, meta.permissions())
}
