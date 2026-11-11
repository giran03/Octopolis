#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum EntryKind {
    File = 0,
    Dir = 1,
}

/// A borrowed directory entry straight from the OS buffer. Names stay in
/// UTF-16 so they can be copied into the IPC buffer without re-encoding.
#[derive(Debug, Clone, Copy)]
pub struct RawEntry<'a> {
    pub name: &'a [u16],
    pub kind: EntryKind,
    /// Win32 `FILE_ATTRIBUTE_*` bits (0 on non-Windows platforms).
    pub attrs: u32,
    pub size: u64,
    /// Last write time in milliseconds since the Unix epoch.
    pub modified_ms: i64,
}

/// An owned directory entry, used by Rust callers and tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub kind: EntryKind,
    pub attrs: u32,
    pub size: u64,
    pub modified_ms: i64,
}

impl Entry {
    pub fn is_dir(&self) -> bool {
        self.kind == EntryKind::Dir
    }
}

impl From<RawEntry<'_>> for Entry {
    fn from(raw: RawEntry<'_>) -> Self {
        Self {
            name: String::from_utf16_lossy(raw.name),
            kind: raw.kind,
            attrs: raw.attrs,
            size: raw.size,
            modified_ms: raw.modified_ms,
        }
    }
}

pub mod attrs {
    pub const READONLY: u32 = 0x1;
    pub const HIDDEN: u32 = 0x2;
    pub const SYSTEM: u32 = 0x4;
    pub const DIRECTORY: u32 = 0x10;
    pub const REPARSE_POINT: u32 = 0x400;
}
