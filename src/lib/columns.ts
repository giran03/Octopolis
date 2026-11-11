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

export function visibleColumns(chosen: readonly string[], paneWidth: number, withCommit: boolean): ColumnKey[] {
  const valid = chosen.filter((k): k is ColumnKey => OPTIONAL_COLUMNS.includes(k as ColumnKey));
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

/** Shows or hides an optional column, keeping the default order. */
export function toggleColumn(chosen: readonly string[], key: ColumnKey): ColumnKey[] {
  const on = new Set(chosen.filter((k): k is ColumnKey => OPTIONAL_COLUMNS.includes(k as ColumnKey)));
  if (on.has(key)) on.delete(key);
  else on.add(key);
  return OPTIONAL_COLUMNS.filter((k) => on.has(k));
}

/** "RHSA"-style letters for the attributes column. */
export function attributeLetters(attrs: number): string {
  const READONLY = 0x1;
  const HIDDEN = 0x2;
  const SYSTEM = 0x4;
  const ARCHIVE = 0x20;
  return [attrs & READONLY ? "R" : "", attrs & HIDDEN ? "H" : "", attrs & SYSTEM ? "S" : "", attrs & ARCHIVE ? "A" : ""].join("");
}
