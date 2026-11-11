// Decoder for the binary listing batches produced by octo-core's codec.
// Layout (little-endian, 2-byte aligned):
//   batch := count:u32 flags:u32 entry*count
//   entry := attrs:u32 size:f64 modified:f64 nameLen:u16 kind:u8 pad:u8 name:u16*nameLen

export const KIND_FILE = 0;
export const KIND_DIR = 1;
const HEADER_LEN = 8;
const ENTRY_FIXED_LEN = 24;
const FLAG_FINAL = 1;

export const ATTR_READONLY = 0x1;
export const ATTR_HIDDEN = 0x2;
export const ATTR_SYSTEM = 0x4;
export const ATTR_REPARSE = 0x400;

/**
 * A directory listing in struct-of-arrays form. The arrays are append-only
 * while a listing streams in; each published snapshot exposes a `count`, so
 * an older snapshot is always a valid prefix of a newer one.
 */
export interface Listing {
  readonly path: string;
  readonly count: number;
  readonly names: readonly string[];
  readonly kinds: readonly number[];
  readonly sizes: readonly number[];
  readonly mtimes: readonly number[];
  readonly attrs: readonly number[];
}

export interface ListingBuilder {
  readonly path: string;
  names: string[];
  kinds: number[];
  sizes: number[];
  mtimes: number[];
  attrs: number[];
}

export function createBuilder(path: string): ListingBuilder {
  return { path, names: [], kinds: [], sizes: [], mtimes: [], attrs: [] };
}

export function snapshot(b: ListingBuilder): Listing {
  return { ...b, count: b.names.length };
}

export function emptyListing(path: string): Listing {
  return snapshot(createBuilder(path));
}

/** Appends one batch to the builder. Returns true for the final batch. */
export function decodeBatch(buffer: ArrayBuffer, into: ListingBuilder): boolean {
  const view = new DataView(buffer);
  if (buffer.byteLength < HEADER_LEN) throw new Error("listing batch is truncated");
  const count = view.getUint32(0, true);
  const flags = view.getUint32(4, true);
  let off = HEADER_LEN;
  for (let i = 0; i < count; i++) {
    if (off + ENTRY_FIXED_LEN > buffer.byteLength) throw new Error("listing batch is truncated");
    const attrs = view.getUint32(off, true);
    const size = view.getFloat64(off + 4, true);
    const mtime = view.getFloat64(off + 12, true);
    const len = view.getUint16(off + 20, true);
    const kind = view.getUint8(off + 22);
    off += ENTRY_FIXED_LEN;
    if (off + len * 2 > buffer.byteLength) throw new Error("listing batch is truncated");
    // Offsets are always even, so the name can be viewed in place.
    const units = new Uint16Array(buffer, off, len);
    off += len * 2;
    into.names.push(String.fromCharCode.apply(null, units as unknown as number[]));
    into.kinds.push(kind);
    into.sizes.push(size);
    into.mtimes.push(mtime);
    into.attrs.push(attrs);
  }
  return (flags & FLAG_FINAL) !== 0;
}

export function isDir(l: Listing, i: number): boolean {
  return l.kinds[i] === KIND_DIR;
}

export function isHidden(l: Listing, i: number): boolean {
  return (l.attrs[i] & ATTR_HIDDEN) !== 0 || l.names[i].startsWith(".");
}

/** Finds an entry index by name (case-insensitive, like NTFS). */
export function indexOfName(l: Listing, name: string): number {
  const want = name.toLowerCase();
  for (let i = 0; i < l.count; i++) if (l.names[i].toLowerCase() === want) return i;
  return -1;
}
