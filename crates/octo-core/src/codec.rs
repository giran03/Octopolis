//! Binary listing format sent to the UI over a raw IPC channel.
//!
//! Little-endian. Every field keeps 2-byte alignment so the UI can view names
//! as a `Uint16Array` without copying.
//!
//! ```text
//! batch  := count:u32 flags:u32 entry*count
//! entry  := attrs:u32 size:f64 modified_ms:f64 name_len:u16 kind:u8 pad:u8 name:u16*name_len
//! ```
//! `size` and `modified_ms` are f64 because JS numbers are f64 and both values
//! stay exact below 2^53.

use crate::entry::RawEntry;

pub const HEADER_LEN: usize = 8;
pub const ENTRY_FIXED_LEN: usize = 24;
/// Set on the last batch of a listing.
pub const FLAG_FINAL: u32 = 1;

/// Accumulates entries into one encoded batch.
pub struct BatchEncoder {
    buf: Vec<u8>,
    count: u32,
}

impl BatchEncoder {
    pub fn with_capacity(bytes: usize) -> Self {
        let mut buf = Vec::with_capacity(bytes.max(HEADER_LEN));
        buf.extend_from_slice(&[0u8; HEADER_LEN]);
        Self { buf, count: 0 }
    }

    pub fn len(&self) -> u32 {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    pub fn push(&mut self, e: &RawEntry<'_>) {
        // Names longer than u16::MAX units cannot occur on NTFS (limit 255).
        let name = &e.name[..e.name.len().min(u16::MAX as usize)];
        self.buf.extend_from_slice(&e.attrs.to_le_bytes());
        self.buf.extend_from_slice(&(e.size as f64).to_le_bytes());
        self.buf.extend_from_slice(&(e.modified_ms as f64).to_le_bytes());
        self.buf.extend_from_slice(&(name.len() as u16).to_le_bytes());
        self.buf.push(e.kind as u8);
        self.buf.push(0);
        for unit in name {
            self.buf.extend_from_slice(&unit.to_le_bytes());
        }
        self.count += 1;
    }

    /// Writes the header and returns the encoded bytes, leaving the encoder
    /// empty and ready for the next batch.
    pub fn finish(&mut self, final_batch: bool) -> Vec<u8> {
        let flags = if final_batch { FLAG_FINAL } else { 0 };
        self.buf[0..4].copy_from_slice(&self.count.to_le_bytes());
        self.buf[4..8].copy_from_slice(&flags.to_le_bytes());
        let capacity = self.buf.capacity();
        self.count = 0;
        std::mem::replace(&mut self.buf, {
            let mut next = Vec::with_capacity(capacity);
            next.extend_from_slice(&[0u8; HEADER_LEN]);
            next
        })
    }
}

/// Decodes a batch. The UI has its own decoder; this one exists for tests and
/// for Rust consumers of the format.
pub fn decode(bytes: &[u8]) -> Option<(Vec<crate::Entry>, bool)> {
    let rd_u32 = |o: usize| bytes.get(o..o + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()));
    let rd_f64 = |o: usize| bytes.get(o..o + 8).map(|b| f64::from_le_bytes(b.try_into().unwrap()));
    let rd_u16 = |o: usize| bytes.get(o..o + 2).map(|b| u16::from_le_bytes(b.try_into().unwrap()));

    let count = rd_u32(0)? as usize;
    let final_batch = rd_u32(4)? & FLAG_FINAL != 0;
    let mut off = HEADER_LEN;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let attrs = rd_u32(off)?;
        let size = rd_f64(off + 4)?;
        let modified = rd_f64(off + 12)?;
        let len = rd_u16(off + 20)? as usize;
        let kind = match *bytes.get(off + 22)? {
            1 => crate::EntryKind::Dir,
            _ => crate::EntryKind::File,
        };
        off += ENTRY_FIXED_LEN;
        let units: Vec<u16> = (0..len).map(|i| rd_u16(off + i * 2)).collect::<Option<_>>()?;
        off += len * 2;
        out.push(crate::Entry {
            name: String::from_utf16_lossy(&units),
            kind,
            attrs,
            size: size as u64,
            modified_ms: modified as i64,
        });
    }
    (off == bytes.len()).then_some((out, final_batch))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EntryKind;

    fn raw<'a>(name: &'a [u16], kind: EntryKind, size: u64) -> RawEntry<'a> {
        RawEntry { name, kind, attrs: 0x20, size, modified_ms: 1_700_000_000_123 }
    }

    #[test]
    fn round_trips_entries_and_final_flag() {
        let a: Vec<u16> = "readme.md".encode_utf16().collect();
        let b: Vec<u16> = "日本語 フォルダ 🐙".encode_utf16().collect();
        let mut enc = BatchEncoder::with_capacity(256);
        enc.push(&raw(&a, EntryKind::File, 42));
        enc.push(&raw(&b, EntryKind::Dir, 0));
        let bytes = enc.finish(true);

        let (entries, final_batch) = decode(&bytes).expect("valid batch");
        assert!(final_batch);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "readme.md");
        assert_eq!(entries[0].size, 42);
        assert_eq!(entries[0].modified_ms, 1_700_000_000_123);
        assert_eq!(entries[1].name, "日本語 フォルダ 🐙");
        assert_eq!(entries[1].kind, EntryKind::Dir);
    }

    #[test]
    fn keeps_two_byte_alignment_for_names() {
        let a: Vec<u16> = "abc".encode_utf16().collect();
        let mut enc = BatchEncoder::with_capacity(64);
        enc.push(&raw(&a, EntryKind::File, 1));
        enc.push(&raw(&a, EntryKind::File, 2));
        let bytes = enc.finish(false);
        assert_eq!(bytes.len() % 2, 0);
        assert_eq!((HEADER_LEN + ENTRY_FIXED_LEN) % 2, 0);
    }

    #[test]
    fn finish_resets_for_next_batch() {
        let a: Vec<u16> = "x".encode_utf16().collect();
        let mut enc = BatchEncoder::with_capacity(64);
        enc.push(&raw(&a, EntryKind::File, 1));
        let first = enc.finish(false);
        assert!(enc.is_empty());
        let second = enc.finish(true);
        assert_eq!(decode(&first).unwrap().0.len(), 1);
        let (empty, final_batch) = decode(&second).unwrap();
        assert!(empty.is_empty() && final_batch);
    }

    #[test]
    fn rejects_truncated_input() {
        let a: Vec<u16> = "name".encode_utf16().collect();
        let mut enc = BatchEncoder::with_capacity(64);
        enc.push(&raw(&a, EntryKind::File, 1));
        let bytes = enc.finish(true);
        assert!(decode(&bytes[..bytes.len() - 1]).is_none());
    }
}
