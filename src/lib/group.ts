// Group by: which group each item falls into, in the order the groups are shown.
import { categoryOf, type FileCategory } from "./format";
import { baseOf, isDir, type Listing } from "./listing";

export type GroupKey = "none" | "type" | "modified" | "size" | "name";

export const GROUP_KEYS: readonly GroupKey[] = ["none", "type", "modified", "size", "name"];
export const GROUP_TITLES: Readonly<Record<GroupKey, string>> = {
  none: "None",
  type: "Type",
  modified: "Date modified",
  size: "Size",
  name: "Name",
};

export interface Group {
  /** Position among the groups (lower first). */
  readonly order: number;
  readonly label: string;
}

const TYPE_ORDER: readonly [FileCategory, string][] = [
  ["folder", "Folders"],
  ["doc", "Documents"],
  ["image", "Pictures"],
  ["audio", "Music"],
  ["video", "Videos"],
  ["code", "Code"],
  ["archive", "Archives"],
  ["exe", "Programs"],
  ["file", "Other files"],
];

const SIZES: readonly [number, string][] = [
  [0, "Empty"],
  [10 * 1024, "Tiny (under 10 KB)"],
  [1024 * 1024, "Small (under 1 MB)"],
  [100 * 1024 * 1024, "Medium (under 100 MB)"],
  [1024 * 1024 * 1024, "Large (under 1 GB)"],
];

const DAY = 24 * 60 * 60 * 1000;

/** Start of the calendar day containing `ms`. */
const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/** Date buckets, newest first. `now` is passed in so a whole listing uses one clock. */
function dateGroup(mtime: number, now: number): Group {
  const today = startOfDay(now);
  if (mtime >= today) return { order: 0, label: "Today" };
  if (mtime >= today - DAY) return { order: 1, label: "Yesterday" };
  if (mtime >= today - 6 * DAY) return { order: 2, label: "Earlier this week" };
  if (mtime >= today - 30 * DAY) return { order: 3, label: "Earlier this month" };
  if (mtime >= new Date(now).setMonth(0, 1) && mtime > 0) return { order: 4, label: "Earlier this year" };
  if (mtime > 0) return { order: 5, label: "Older" };
  return { order: 6, label: "Unknown date" };
}

function sizeGroup(bytes: number): Group {
  for (let i = 0; i < SIZES.length; i++) if (bytes <= 0 ? i === 0 : bytes < SIZES[i][0]) return { order: i, label: SIZES[i][1] };
  return { order: SIZES.length, label: "Huge (1 GB or more)" };
}

function nameGroup(name: string): Group {
  const c = baseOf(name).charAt(0).toUpperCase();
  // Letters group by letter; digits and symbols together, first.
  return /[A-Z]/.test(c) ? { order: c.charCodeAt(0) - 64, label: c } : { order: 0, label: "0–9 and symbols" };
}

/** The group an entry belongs to. Folders always form their own first group, as they do when sorting. */
export function groupOf(l: Listing, i: number, key: GroupKey, now: number): Group {
  if (key === "none") return { order: 0, label: "" };
  if (isDir(l, i)) return { order: -1, label: "Folders" };
  switch (key) {
    case "type": {
      const cat = categoryOf(baseOf(l.names[i]), false);
      const at = Math.max(1, TYPE_ORDER.findIndex(([c]) => c === cat));
      return { order: at, label: TYPE_ORDER[at][1] };
    }
    case "modified":
      return dateGroup(l.mtimes[i], now);
    case "size":
      return sizeGroup(l.sizes[i]);
    case "name":
      return nameGroup(l.names[i]);
  }
}

/** Where each group begins in `view`, with its label and item count. */
export function groupStarts(l: Listing, view: ArrayLike<number>, key: GroupKey, now: number): Map<number, { label: string; count: number }> {
  const starts = new Map<number, { label: string; count: number }>();
  if (key === "none") return starts;
  let current: { label: string; count: number } | null = null;
  let currentOrder = Number.NaN;
  for (let pos = 0; pos < view.length; pos++) {
    const g = groupOf(l, view[pos], key, now);
    if (!current || g.order !== currentOrder || g.label !== current.label) {
      current = { label: g.label, count: 0 };
      currentOrder = g.order;
      starts.set(pos, current);
    }
    current.count++;
  }
  return starts;
}
