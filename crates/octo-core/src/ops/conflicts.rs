//! Pre-flight check for name collisions before a copy or move, so the user
//! can decide per item instead of the engine silently renaming.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::paths::is_within;

/// One side of a collision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Side {
    pub path: PathBuf,
    pub is_dir: bool,
    /// Bytes for a file; 0 for a folder.
    pub size: u64,
    /// Milliseconds since the Unix epoch; 0 if unknown.
    pub modified_ms: i64,
}

/// A source whose name is already taken in the destination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameConflict {
    pub source: Side,
    pub target: Side,
}

fn side(path: PathBuf) -> Option<Side> {
    let meta = path.symlink_metadata().ok()?;
    let modified_ms = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64);
    Some(Side { is_dir: meta.is_dir(), size: if meta.is_dir() { 0 } else { meta.len() }, modified_ms, path })
}

/// Sources that would collide with an existing item in `dest`. Items already
/// in `dest` (copying onto itself, moving to the same folder) are left out:
/// the engine handles those without asking.
pub fn find_conflicts(sources: &[PathBuf], dest: &Path) -> Vec<NameConflict> {
    sources
        .iter()
        .filter_map(|src| {
            let name = src.file_name()?;
            let target = dest.join(name);
            if is_within(&target, src) && is_within(src, &target) {
                return None;
            }
            let target = side(target)?;
            let source = side(src.clone())?;
            Some(NameConflict { source, target })
        })
        .collect()
}
