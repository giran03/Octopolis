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
