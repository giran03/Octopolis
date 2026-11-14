//! Octopolis core engine: directory enumeration, the binary listing codec,
//! file operations and shell helpers. Nothing in here depends on the UI layer.

pub mod archive;
pub mod cleanup;
pub mod clipboard;
pub mod codec;
pub mod compress;
pub mod dupes;
pub mod editors;
pub mod imgtools;
pub mod rules;
pub mod syscleanup;
pub mod entry;
pub mod enumerate;
pub mod fonts;
pub mod error;
pub mod explorer_mode;
pub mod failsafe;
pub mod git;
pub mod hotkey;
pub mod lock;
pub mod meta;
pub mod names;
pub mod network;
pub mod ops;
pub mod preview;
pub mod props;
pub mod search;
pub mod shell;
pub mod size_index;
pub mod sizes;
pub mod tags;
pub mod thumbs;
pub mod webdrop;

pub use entry::{Entry, EntryKind, RawEntry};
pub use enumerate::{enumerate_dir, list_dir};
pub use error::{Error, Result};
