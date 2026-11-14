// Details-list columns: which are shown, how wide, and how narrow panes drop them.
import type { SortKey } from "./sort";

export type ColumnKey = "modified" | "type" | "size" | "extension" | "attributes" | "commit";

export interface ColumnDef {
  readonly key: ColumnKey;
  readonly label: string;
  /** Default width in pixels. */
  readonly width: number;
  readonly min: number;
  readonly sort?: SortKey;
  readonly align?: "end";
}

export const COLUMN_DEFS: readonly ColumnDef[] = [
  { key: "modified", label: "Date modified", width: 140, min: 90, sort: "modified" },
  { key: "type", label: "Type", width: 120, min: 60, sort: "type" },
  { key: "size", label: "Size", width: 84, min: 56, sort: "size", align: "end" },
  { key: "extension", label: "Extension", width: 80, min: 50, sort: "type" },
  { key: "attributes", label: "Attributes", width: 80, min: 56 },
  { key: "commit", label: "Last commit", width: 190, min: 100 },
];

/** Columns the user can turn on or off (the commit column follows its own setting). */
export const OPTIONAL_COLUMNS: readonly ColumnKey[] = ["modified", "type", "size", "extension", "attributes"];
export const DEFAULT_COLUMNS: readonly ColumnKey[] = ["modified", "type", "size"];
export const NAME_MIN = 160;
const MAX_WIDTH = 600;

export const columnDef = (key: ColumnKey) => COLUMN_DEFS.find((c) => c.key === key)!;

/** Narrow panes drop Type first, then the date, so Size stays visible. */
const NARROW_DROPS: readonly [width: number, key: ColumnKey][] = [
  [640, "type"],
  [420, "modified"],
  [420, "extension"],
  [420, "attributes"],
];

function normalizeColumns(chosen: readonly string[]): ColumnKey[] {
  const seen = new Set<ColumnKey>();
  const out: ColumnKey[] = [];
  for (const k of chosen) {
    if (OPTIONAL_COLUMNS.includes(k as ColumnKey) && !seen.has(k as ColumnKey)) {
      seen.add(k as ColumnKey);
      out.push(k as ColumnKey);
    }
  }
  return out;
}

export function visibleColumns(chosen: readonly string[], paneWidth: number, withCommit: boolean): ColumnKey[] {
  const valid = normalizeColumns(chosen);
  const dropped = new Set(NARROW_DROPS.filter(([w]) => paneWidth > 0 && paneWidth < w).map(([, k]) => k));
  const cols = valid.filter((k) => !dropped.has(k));
  return withCommit && paneWidth >= 640 ? [...cols, "commit"] : cols;
}

export function clampWidth(key: ColumnKey, width: number): number {
  return Math.round(Math.min(MAX_WIDTH, Math.max(columnDef(key).min, width)));
}

/** The CSS grid template: the name column takes the rest of the space. */
export function gridTemplate(cols: readonly ColumnKey[], widths: Readonly<Record<string, number>>): string {
  return [`minmax(${NAME_MIN}px, 1fr)`, ...cols.map((k) => `${clampWidth(k, widths[k] ?? columnDef(k).width)}px`)].join(" ");
}

/** Shows or hides an optional column while preserving the user's custom column order. */
export function toggleColumn(chosen: readonly string[], key: ColumnKey): ColumnKey[] {
  const list = normalizeColumns(chosen);
  if (list.includes(key)) return list.filter((k) => k !== key);
  return [...list, key];
}

/** Moves `fromKey` before or after `toKey` within the active columns list. */
export function moveColumn(chosen: readonly string[], fromKey: ColumnKey, toKey: ColumnKey, place: "before" | "after" = "before"): ColumnKey[] {
  const list = normalizeColumns(chosen);
  if (fromKey === toKey || !list.includes(fromKey) || !list.includes(toKey)) return list;
  const without = list.filter((k) => k !== fromKey);
  const targetIdx = without.indexOf(toKey);
  const insertIdx = place === "after" ? targetIdx + 1 : targetIdx;
  without.splice(insertIdx, 0, fromKey);
  return without;
}

/** Moves an active column one slot left/up (-1) or right/down (+1). */
export function stepColumn(chosen: readonly string[], key: ColumnKey, delta: -1 | 1): ColumnKey[] {
  const list = normalizeColumns(chosen);
  const idx = list.indexOf(key);
  const next = idx + delta;
  if (idx < 0 || next < 0 || next >= list.length) return list;
  const copy = [...list];
  [copy[idx], copy[next]] = [copy[next], copy[idx]];
  return copy;
}

/** Active columns in their current order, followed by any hidden optional columns. */
export function allColumnsInOrder(chosen: readonly string[]): ColumnKey[] {
  const active = normalizeColumns(chosen);
  const on = new Set(active);
  return [...active, ...OPTIONAL_COLUMNS.filter((k) => !on.has(k))];
}

/** "RHSA"-style letters for the attributes column. */
export function attributeLetters(attrs: number): string {
  const READONLY = 0x1;
  const HIDDEN = 0x2;
  const SYSTEM = 0x4;
  const ARCHIVE = 0x20;
  return [attrs & READONLY ? "R" : "", attrs & HIDDEN ? "H" : "", attrs & SYSTEM ? "S" : "", attrs & ARCHIVE ? "A" : ""].join("");
}
