import { baseOf, isDir, isHidden, type Listing } from "./listing";
import { extensionOf } from "./paths";

/** "relevance" keeps the order the listing arrived in (search ranking). */
export type SortKey = "name" | "modified" | "type" | "size" | "relevance";
export interface SortSpec {
  readonly key: SortKey;
  /** 1 ascending, -1 descending. */
  readonly dir: 1 | -1;
}

export const DEFAULT_SORT: SortSpec = { key: "name", dir: 1 };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export interface ViewOptions {
  readonly sort: SortSpec;
  readonly showHidden: boolean;
  /** Case-insensitive substring filter on names (empty = no filter). */
  readonly filter?: string;
  /** Recursive folder sizes by lower-case name; folders sort by these when known. */
  readonly dirSizes?: ReadonlyMap<string, number> | null;
}

/**
 * Builds the visible order: an array of entry indices, folders first, sorted
 * by the chosen column with the name as a tie-breaker.
 */
/** A folder's computed size, or -1 while unknown (so unknown folders group together). */
function folderSize(l: Listing, i: number, opts: ViewOptions): number {
  return opts.dirSizes?.get(l.names[i].toLowerCase()) ?? -1;
}

export function buildView(l: Listing, opts: ViewOptions): Uint32Array {
  const needle = opts.filter?.trim().toLowerCase() ?? "";
  const picked: number[] = [];
  for (let i = 0; i < l.count; i++) {
    if (!opts.showHidden && isHidden(l, i)) continue;
    if (needle && !l.names[i].toLowerCase().includes(needle)) continue;
    picked.push(i);
  }

  const { key, dir } = opts.sort;
  if (key === "relevance") return Uint32Array.from(picked);
  const byName = (a: number, b: number) => collator.compare(l.names[a], l.names[b]);
  const exts = key === "type" ? picked.map((i) => (isDir(l, i) ? "" : extensionOf(baseOf(l.names[i])))) : null;
  const extOf = new Map<number, string>();
  if (exts) picked.forEach((i, n) => extOf.set(i, exts[n]));

  picked.sort((a, b) => {
    const da = isDir(l, a);
    if (da !== isDir(l, b)) return da ? -1 : 1;
    let c = 0;
    switch (key) {
      case "modified":
        c = l.mtimes[a] - l.mtimes[b];
        break;
      case "size":
        c = da ? folderSize(l, a, opts) - folderSize(l, b, opts) : l.sizes[a] - l.sizes[b];
        break;
      case "type":
        c = collator.compare(extOf.get(a)!, extOf.get(b)!);
        break;
      case "name":
        break;
    }
    return (c || byName(a, b)) * dir;
  });
  return Uint32Array.from(picked);
}

export function toggleSort(current: SortSpec, key: SortKey): SortSpec {
  if (current.key === key) return { key, dir: current.dir === 1 ? -1 : 1 };
  // Dates and sizes are most useful newest/largest first.
  return { key, dir: key === "modified" || key === "size" ? -1 : 1 };
}
