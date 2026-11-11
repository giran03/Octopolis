// Comparing two folders side by side (two panes).
import { baseOf, isDir, type Listing } from "./listing";

/** How an item in one folder relates to the item of the same name in the other. */
export type CompareStatus = "only" | "newer" | "older" | "differs" | "same";

/** FAT and network drives round times to 2 seconds; closer than this counts as equal. */
export const TIME_TOLERANCE_MS = 2000;

function index(l: Listing): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < l.count; i++) out.set(baseOf(l.names[i]).toLowerCase(), i);
  return out;
}

function status(a: Listing, i: number, b: Listing, j: number | undefined): CompareStatus {
  if (j === undefined) return "only";
  if (isDir(a, i) || isDir(b, j)) return "same"; // folders aren't compared inside
  const dt = a.mtimes[i] - b.mtimes[j];
  if (dt > TIME_TOLERANCE_MS) return "newer";
  if (dt < -TIME_TOLERANCE_MS) return "older";
  return a.sizes[i] === b.sizes[j] ? "same" : "differs";
}

/** Status of every item in `a` relative to `b`, by lower-case name. */
export function compareListings(a: Listing, b: Listing): Map<string, CompareStatus> {
  const other = index(b);
  const out = new Map<string, CompareStatus>();
  for (let i = 0; i < a.count; i++) {
    const key = baseOf(a.names[i]).toLowerCase();
    out.set(key, status(a, i, b, other.get(key)));
  }
  return out;
}

/** Items worth copying to the other side: missing there, or newer here. */
export const isDifference = (s: CompareStatus | undefined) => s === "only" || s === "newer" || s === "differs";

export function countStatuses(m: ReadonlyMap<string, CompareStatus>): Record<CompareStatus, number> {
  const out: Record<CompareStatus, number> = { only: 0, newer: 0, older: 0, differs: 0, same: 0 };
  for (const s of m.values()) out[s]++;
  return out;
}
