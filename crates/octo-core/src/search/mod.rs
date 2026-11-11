//! Recursive search: build an index of a folder tree, then filter and rank it.
//!
//! ```text
//! index  = usn::build (NTFS journal, needs admin) or walk::build (parallel scan)
//! query  = query::parse("report ext:pdf size:>1mb dm:week")
//! result = rank::run(&index, &query, limit)
//! ```

pub mod index;
pub mod query;
pub mod rank;
pub mod usn;
pub mod walk;

use std::path::Path;
use std::sync::atomic::AtomicU64;

pub use index::Index;
pub use query::{Query, QueryError};
pub use rank::{Hit, SearchResult};

use crate::error::Result;
use crate::ops::CancelToken;

/// How an index was built.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexMode {
    /// Read from the NTFS change journal (whole volume, very fast).
    Usn,
    /// Parallel directory walk.
    Walk,
}

/// Builds an index for `root`, using the NTFS journal when `root` is a drive
/// root that this process may read raw (administrator), else a parallel walk.
/// `scanned` is bumped as items are found, so callers can show progress.
pub fn build_index(root: &Path, cancel: &CancelToken, scanned: &AtomicU64) -> Result<(Index, IndexMode)> {
    if usn::is_volume_root(root)
        && let Ok(index) = usn::build(root, cancel, scanned)
    {
        return Ok((index, IndexMode::Usn));
    }
    walk::build(root, cancel, scanned).map(|i| (i, IndexMode::Walk))
}
