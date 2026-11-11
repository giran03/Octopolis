//! Instant single-item operations.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::names::{unique_path, validate_name};

/// Renames `path` to `new_name` within the same folder. A change of case only
/// (`readme` → `README`) is allowed.
pub fn rename(path: &Path, new_name: &str) -> Result<PathBuf> {
    validate_name(new_name)?;
    let parent = path.parent().ok_or_else(|| Error::InvalidName("a drive cannot be renamed".into()))?;
    let target = parent.join(new_name);
    let same_item = path
        .file_name()
        .is_some_and(|old| old.to_string_lossy().to_lowercase() == new_name.to_lowercase());
    if !same_item && target.symlink_metadata().is_ok() {
        return Err(Error::AlreadyExists(target));
    }
    fs::rename(path, &target).map_err(|e| Error::io(path, e))?;
    Ok(target)
}

/// Creates a folder named `name` in `parent`, numbering it if taken.
pub fn create_folder(parent: &Path, name: &str) -> Result<PathBuf> {
    validate_name(name)?;
    let target = unique_path(parent, name, true);
    fs::create_dir(&target).map_err(|e| Error::io(&target, e))?;
    Ok(target)
}

/// Removes a folder only if it is empty (undo of "new folder").
pub fn remove_empty_dir(path: &Path) -> Result<()> {
    fs::remove_dir(path).map_err(|e| Error::io(path, e))
}

/// Renames many items at once. Names may swap (a to b, b to a) because every
/// item first moves to a temporary name. All-or-nothing: on failure, completed
/// renames are reversed. Returns (old, new) for each item that changed.
pub fn batch_rename(items: &[(PathBuf, String)]) -> Result<Vec<(PathBuf, PathBuf)>> {
    let mut plan: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (path, name) in items {
        validate_name(name)?;
        let parent = path.parent().ok_or_else(|| Error::InvalidName("a drive cannot be renamed".into()))?;
        if path.file_name().is_some_and(|n| n.to_string_lossy() == *name) {
            continue;
        }
        plan.push((path.clone(), parent.join(name)));
    }
    let lower = |p: &Path| p.to_string_lossy().to_lowercase();
    let sources: std::collections::HashSet<String> = plan.iter().map(|(a, _)| lower(a)).collect();
    let mut targets = std::collections::HashSet::new();
    for (_, to) in &plan {
        if !targets.insert(lower(to)) {
            return Err(Error::AlreadyExists(to.clone()));
        }
        if to.symlink_metadata().is_ok() && !sources.contains(&lower(to)) {
            return Err(Error::AlreadyExists(to.clone()));
        }
    }

    let temp = |to: &Path, i: usize| to.with_file_name(format!(".octo-rename-{}-{i}", std::process::id()));
    let mut parked: Vec<(PathBuf, PathBuf)> = Vec::new(); // (original, temp)
    for (i, (from, to)) in plan.iter().enumerate() {
        let t = temp(to, i);
        if let Err(e) = fs::rename(from, &t) {
            for (orig, tmp) in parked.iter().rev() {
                let _ = fs::rename(tmp, orig);
            }
            return Err(Error::io(from, e));
        }
        parked.push((from.clone(), t));
    }
    for (i, (_, to)) in plan.iter().enumerate() {
        if let Err(e) = fs::rename(&parked[i].1, to) {
            // Undo the finished renames, then bring everything home.
            for (j, (_, done)) in plan.iter().enumerate().take(i) {
                let _ = fs::rename(done, &parked[j].1);
            }
            for (orig, tmp) in parked.iter().rev() {
                let _ = fs::rename(tmp, orig);
            }
            return Err(Error::io(to, e));
        }
    }
    Ok(plan)
}
