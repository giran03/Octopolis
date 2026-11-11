// Totals for a multi-item selection, shown in the inspector.
import { categoryOf, type FileCategory } from "./format";

export interface SummaryItem {
  readonly name: string;
  readonly dir: boolean;
  /** Undefined for a folder whose size isn't known yet. */
  readonly size: number | undefined;
  readonly modified: number;
}

export interface SelectionSummary {
  readonly count: number;
  readonly files: number;
  readonly folders: number;
  readonly bytes: number;
  /** Folders whose size is missing from `bytes`. */
  readonly unsized: number;
  /** Item counts per kind, largest first. */
  readonly kinds: readonly (readonly [FileCategory, number])[];
  readonly oldest: number;
  readonly newest: number;
}

export function summarize(items: readonly SummaryItem[]): SelectionSummary {
  let files = 0;
  let bytes = 0;
  let unsized = 0;
  let oldest = Infinity;
  let newest = 0;
  const kinds = new Map<FileCategory, number>();
  for (const it of items) {
    if (!it.dir) files++;
    if (it.size === undefined) unsized++;
    else bytes += it.size;
    if (it.modified > 0) {
      oldest = Math.min(oldest, it.modified);
      newest = Math.max(newest, it.modified);
    }
    const kind = categoryOf(it.name, it.dir);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  return {
    count: items.length,
    files,
    folders: items.length - files,
    bytes,
    unsized,
    kinds: [...kinds].sort((a, b) => b[1] - a[1]),
    oldest: oldest === Infinity ? 0 : oldest,
    newest,
  };
}

/** Picks every copy but the one to keep in each duplicate group (files listed newest first). */
export function extrasToRemove(groups: readonly { readonly files: readonly (readonly [string, number])[] }[], keep: "newest" | "oldest"): Set<string> {
  const out = new Set<string>();
  for (const g of groups) g.files.forEach(([path], i) => (keep === "newest" ? i > 0 : i < g.files.length - 1) && out.add(path));
  return out;
}
