//! Octopolis core engine: directory enumeration, the binary listing codec,
//! file operations and shell helpers. Nothing in here depends on the UI layer.

pub mod archive;
pub mod codec;
pub mod entry;
pub mod enumerate;
pub mod error;
pub mod git;
pub mod lock;
pub mod meta;
pub mod names;
pub mod ops;
pub mod preview;
pub mod search;
pub mod shell;
pub mod sizes;
pub mod thumbs;

pub use entry::{Entry, EntryKind, RawEntry};
pub use enumerate::{enumerate_dir, list_dir};
pub use error::{Error, Result};
