// The view and sort each folder was last shown with, most recent first.
import type { SortKey, SortSpec } from "./sort";

export type ViewMode = "details" | "grid" | "columns";

export interface FolderView {
  readonly mode: ViewMode;
  readonly sort: SortSpec;
}

export type FolderViews = readonly (readonly [key: string, view: FolderView])[];

/** Folders remembered at most; the least recently changed are forgotten first. */
export const MAX_FOLDER_VIEWS = 500;

export const folderKey = (path: string) => path.replace(/\\+$/, "").toLowerCase();

export function viewFor(all: FolderViews, path: string): FolderView | null {
  const key = folderKey(path);
  return all.find(([k]) => k === key)?.[1] ?? null;
}

/** Records `view` for `path`, moving it to the front. */
export function rememberView(all: FolderViews, path: string, view: FolderView, max = MAX_FOLDER_VIEWS): FolderViews {
  const key = folderKey(path);
  return [[key, view] as const, ...all.filter(([k]) => k !== key)].slice(0, max);
}

const MODES: readonly ViewMode[] = ["details", "grid", "columns"];
const KEYS: readonly SortKey[] = ["name", "modified", "type", "size"];

/** Keeps only well-formed entries from stored JSON. */
export function parseFolderViews(raw: unknown): FolderViews {
  if (!Array.isArray(raw)) return [];
  const out: [string, FolderView][] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || typeof item[0] !== "string") continue;
    const v = item[1] as Partial<FolderView> | undefined;
    const sort = v?.sort as Partial<SortSpec> | undefined;
    if (!v || !MODES.includes(v.mode as ViewMode) || !sort || !KEYS.includes(sort.key as SortKey) || (sort.dir !== 1 && sort.dir !== -1)) continue;
    out.push([item[0], { mode: v.mode as ViewMode, sort: { key: sort.key as SortKey, dir: sort.dir } }]);
  }
  return out.slice(0, MAX_FOLDER_VIEWS);
}
