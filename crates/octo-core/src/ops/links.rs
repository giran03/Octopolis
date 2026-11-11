//! Symbolic links, junctions and hard links: copying them as links (instead
//! of failing) and "Paste as link".

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::names::unique_path;

/// Windows ERROR_PRIVILEGE_NOT_HELD, returned when symbolic links need Developer Mode.
const ERROR_PRIVILEGE_NOT_HELD: i32 = 1314;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    /// Works for files and folders; Windows needs Developer Mode or admin rights.
    Symbolic,
    /// Folders only; no special rights needed.
    Junction,
    /// Files only, same drive; no special rights needed.
    Hard,
}

fn explain(path: &Path, e: std::io::Error) -> Error {
    if e.raw_os_error() == Some(ERROR_PRIVILEGE_NOT_HELD) {
        return Error::io(path, std::io::Error::other("symbolic links need Developer Mode (Windows Settings › System › For developers) or administrator rights"));
    }
    Error::io(path, e)
}

/// True for a junction (a folder mount point), as opposed to a symbolic link.
pub fn is_junction(path: &Path) -> bool {
    #[cfg(windows)]
    {
        junction::exists(path).unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

fn make(kind: LinkKind, target: &Path, link: &Path, target_is_dir: bool) -> Result<()> {
    match kind {
        LinkKind::Hard => std::fs::hard_link(target, link).map_err(|e| explain(link, e)),
        #[cfg(windows)]
        LinkKind::Junction => junction::create(target, link).map_err(|e| explain(link, e)),
        #[cfg(windows)]
        LinkKind::Symbolic if target_is_dir => std::os::windows::fs::symlink_dir(target, link).map_err(|e| explain(link, e)),
        #[cfg(windows)]
        LinkKind::Symbolic => std::os::windows::fs::symlink_file(target, link).map_err(|e| explain(link, e)),
        #[cfg(not(windows))]
        _ => {
            let _ = target_is_dir;
            std::os::unix::fs::symlink(target, link).map_err(|e| explain(link, e))
        }
    }
}

/// Copies a link as a link: `dst` becomes a new link to the same target.
/// Relative symbolic links stay relative.
pub fn recreate(src: &Path, dst: &Path) -> Result<()> {
    let target = std::fs::read_link(src).map_err(|e| Error::io(src, e))?;
    if is_junction(src) {
        return make(LinkKind::Junction, &target, dst, true);
    }
    // A link's own metadata says whether it was made as a folder link.
    #[cfg(windows)]
    let target_is_dir = {
        use std::os::windows::fs::FileTypeExt;
        src.symlink_metadata().map(|m| m.file_type().is_symlink_dir()).unwrap_or(false)
    };
    #[cfg(not(windows))]
    let target_is_dir = src.is_dir();
    make(LinkKind::Symbolic, &target, dst, target_is_dir)
}

/// Creates a link to `target` inside `dest_dir`, named like the target and
/// numbered if taken. Returns the link's path.
pub fn create_link(kind: LinkKind, target: &Path, dest_dir: &Path) -> Result<PathBuf> {
    let meta = target.metadata().map_err(|e| Error::io(target, e))?;
    let name = target.file_name().ok_or_else(|| Error::io(target, std::io::Error::other("a drive can't be linked this way")))?;
    match (kind, meta.is_dir()) {
        (LinkKind::Junction, false) => return Err(Error::io(target, std::io::Error::other("junctions can only point to folders"))),
        (LinkKind::Hard, true) => return Err(Error::io(target, std::io::Error::other("hard links can only point to files"))),
        _ => {}
    }
    let link = unique_path(dest_dir, &name.to_string_lossy(), meta.is_dir());
    make(kind, target, &link, meta.is_dir())?;
    Ok(link)
}
