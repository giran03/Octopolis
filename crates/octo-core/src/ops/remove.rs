//! Delete to the Recycle Bin or permanently.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::Ctx;

pub fn delete(ctx: &mut Ctx<'_>, paths: &[PathBuf], permanent: bool) {
    ctx.progress.total_items = paths.len() as u64;
    ctx.emit(true);
    if permanent {
        for p in paths {
            if ctx.cancelled() {
                return;
            }
            remove_permanently(ctx, p);
            ctx.progress.done_items += 1;
            ctx.emit(false);
        }
        return;
    }
    // One shell call for the whole batch is far faster than one per item.
    if trash::delete_all(paths).is_ok() {
        ctx.progress.done_items = paths.len() as u64;
        return;
    }
    // Something failed: retry item by item to find out which ones.
    for p in paths {
        if ctx.cancelled() {
            return;
        }
        if p.symlink_metadata().is_ok()
            && let Err(e) = trash::delete(p)
        {
            ctx.fail(p, crate::Error::Trash(e.to_string()));
        }
        ctx.progress.done_items += 1;
        ctx.emit(false);
    }
}

/// Deletes a file or folder tree. Entries that fail are reported one by one
/// and the rest of the tree is still removed. Links (symlinks, junctions) are
/// removed as links; their targets are never touched.
pub fn remove_permanently(ctx: &mut Ctx<'_>, path: &Path) {
    ctx.progress.current = Some(path.into());
    remove_tree(ctx, path);
}

fn remove_tree(ctx: &mut Ctx<'_>, path: &Path) {
    let meta = match path.symlink_metadata() {
        Ok(m) => m,
        Err(e) => return ctx.fail(path, crate::Error::io(path, e)),
    };
    if meta.is_dir() && !meta.is_symlink() {
        match fs::read_dir(path) {
            Ok(children) => {
                for child in children {
                    match child {
                        Ok(c) => remove_tree(ctx, &c.path()),
                        Err(e) => ctx.fail(path, crate::Error::io(path, e)),
                    }
                }
            }
            Err(e) => return ctx.fail(path, crate::Error::io(path, e)),
        }
    }
    let remove = || if meta.is_dir() { fs::remove_dir(path) } else { fs::remove_file(path) };
    if let Err(e) = remove_clearing_readonly(path, &meta, remove) {
        // A folder whose children failed is already reported through them.
        if !(meta.is_dir() && e.kind() == io::ErrorKind::DirectoryNotEmpty) {
            ctx.fail(path, crate::Error::io(path, e));
        }
    }
}

/// Runs `remove`; if it was refused because this one entry is read-only,
/// clears the flag and retries, restoring the flag if the retry also fails.
fn remove_clearing_readonly(path: &Path, meta: &fs::Metadata, remove: impl Fn() -> io::Result<()>) -> io::Result<()> {
    let err = match remove() {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    // set_permissions follows links, so never use it on one.
    if err.kind() != io::ErrorKind::PermissionDenied || !meta.permissions().readonly() || meta.is_symlink() {
        return Err(err);
    }
    let original = meta.permissions();
    let mut writable = original.clone();
    #[allow(clippy::permissions_set_readonly_false)]
    writable.set_readonly(false);
    fs::set_permissions(path, writable)?;
    remove().inspect_err(|_| {
        let _ = fs::set_permissions(path, original);
    })
}

/// Puts recently recycled items back. Returns how many were restored.
#[cfg(windows)]
pub fn restore_recycled(paths: &[PathBuf]) -> crate::Result<usize> {
    let mut items = trash::os_limited::list().map_err(|e| crate::Error::Trash(e.to_string()))?;
    // Newest first, so the most recent deletion of a path is the one restored.
    items.sort_by_key(|i| std::cmp::Reverse(i.time_deleted));
    let mut picked = Vec::new();
    for p in paths {
        let want = p.to_string_lossy().to_lowercase();
        if let Some(at) = items.iter().position(|i| i.original_path().to_string_lossy().to_lowercase() == want) {
            picked.push(items.remove(at));
        }
    }
    let n = picked.len();
    trash::os_limited::restore_all(picked).map_err(|e| crate::Error::Trash(e.to_string()))?;
    Ok(n)
}

#[cfg(not(windows))]
pub fn restore_recycled(_: &[PathBuf]) -> crate::Result<usize> {
    Ok(0)
}
