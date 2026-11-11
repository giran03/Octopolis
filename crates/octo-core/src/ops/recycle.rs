//! Browsing the Recycle Bin: list what's in it, put items back, or delete
//! them for good.

use std::path::PathBuf;

use crate::error::{Error, Result};

/// One item in the Recycle Bin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinItem {
    /// Windows' own identifier for the item, used to restore or purge it.
    pub id: String,
    pub name: String,
    /// Where it was deleted from (its full original path).
    pub original_path: PathBuf,
    /// Milliseconds since 1970.
    pub deleted_ms: i64,
    /// Bytes for a file; None for a folder.
    pub size: Option<u64>,
    pub is_dir: bool,
}

fn trash_err(e: trash::Error) -> Error {
    Error::Trash(e.to_string())
}

#[cfg(windows)]
fn all() -> Result<Vec<trash::TrashItem>> {
    trash::os_limited::list().map_err(trash_err)
}

/// Everything in the Recycle Bin, newest first.
#[cfg(windows)]
pub fn list_bin() -> Result<Vec<BinItem>> {
    let mut items: Vec<BinItem> = all()?
        .into_iter()
        .map(|i| {
            let meta = trash::os_limited::metadata(&i).ok();
            let (size, is_dir) = match meta.map(|m| m.size) {
                Some(trash::TrashItemSize::Bytes(b)) => (Some(b), false),
                Some(trash::TrashItemSize::Entries(_)) => (None, true),
                None => (None, false),
            };
            BinItem {
                id: i.id.to_string_lossy().into_owned(),
                name: i.name.to_string_lossy().into_owned(),
                original_path: i.original_path(),
                deleted_ms: i.time_deleted.saturating_mul(1000),
                size,
                is_dir,
            }
        })
        .collect();
    items.sort_by_key(|i| std::cmp::Reverse(i.deleted_ms));
    Ok(items)
}

#[cfg(windows)]
fn pick(ids: &[String]) -> Result<Vec<trash::TrashItem>> {
    Ok(all()?.into_iter().filter(|i| ids.iter().any(|id| *id == i.id.to_string_lossy())).collect())
}

/// Puts items back where they were deleted from. Fails, restoring nothing,
/// if something with the same name has since been created there.
#[cfg(windows)]
pub fn restore_from_bin(ids: &[String]) -> Result<usize> {
    let items = pick(ids)?;
    let n = items.len();
    trash::os_limited::restore_all(items).map_err(|e| match e {
        trash::Error::RestoreCollision { path, .. } => Error::Trash(format!("\"{}\" already exists, so nothing was restored", path.display())),
        other => trash_err(other),
    })?;
    Ok(n)
}

/// Deletes items from the Recycle Bin for good.
#[cfg(windows)]
pub fn purge_from_bin(ids: &[String]) -> Result<usize> {
    let items = pick(ids)?;
    let n = items.len();
    trash::os_limited::purge_all(items).map_err(trash_err)?;
    Ok(n)
}

/// Empties the whole Recycle Bin.
#[cfg(windows)]
pub fn empty_bin() -> Result<usize> {
    let items = all()?;
    let n = items.len();
    trash::os_limited::purge_all(items).map_err(trash_err)?;
    Ok(n)
}

#[cfg(not(windows))]
pub fn list_bin() -> Result<Vec<BinItem>> {
    Ok(Vec::new())
}
#[cfg(not(windows))]
pub fn restore_from_bin(_: &[String]) -> Result<usize> {
    Ok(0)
}
#[cfg(not(windows))]
pub fn purge_from_bin(_: &[String]) -> Result<usize> {
    Ok(0)
}
#[cfg(not(windows))]
pub fn empty_bin() -> Result<usize> {
    Ok(0)
}
