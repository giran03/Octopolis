//! Octopolis core engine: directory enumeration, the binary listing codec,
//! file operations and shell helpers. Nothing in here depends on the UI layer.

pub mod codec;
pub mod entry;
pub mod enumerate;
pub mod error;
pub mod names;
pub mod ops;
pub mod search;
pub mod shell;

pub use entry::{Entry, EntryKind, RawEntry};
pub use enumerate::{enumerate_dir, list_dir};
pub use error::{Error, Result};
