// Pure helpers for the sidebar's pinned folders.
import { baseName, samePath } from "./paths";

export interface Pin {
  readonly path: string;
  readonly label: string;
}

export const MIN_SIDEBAR_WIDTH = 188;
export const MAX_SIDEBAR_WIDTH = 380;
export const DEFAULT_SIDEBAR_WIDTH = 240;

export const clampSidebarWidth = (w: number) => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(w)));

export const isPinned = (pins: readonly Pin[], path: string) => pins.some((p) => samePath(p.path, path));

/** Adds a pin at the end, or removes it when already pinned. */
export function togglePin(pins: readonly Pin[], path: string): Pin[] {
  if (isPinned(pins, path)) return pins.filter((p) => !samePath(p.path, path));
  return [...pins, { path, label: baseName(path) || path }];
}

/** Moves a pin up (-1) or down (+1), leaving the list unchanged at either end. */
export function movePin(pins: readonly Pin[], path: string, delta: -1 | 1): Pin[] {
  const from = pins.findIndex((p) => samePath(p.path, path));
  const to = from + delta;
  if (from < 0 || to < 0 || to >= pins.length) return [...pins];
  const next = [...pins];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function renamePin(pins: readonly Pin[], path: string, label: string): Pin[] {
  const clean = label.trim();
  return pins.map((p) => (samePath(p.path, path) ? { ...p, label: clean || baseName(path) || path } : p));
}

/** Pins `paths` (skipping ones already pinned) so the first lands at `index`. */
export function insertPins(pins: readonly Pin[], paths: readonly string[], index: number): Pin[] {
  const fresh: Pin[] = [];
  for (const path of paths) {
    if (!isPinned(pins, path) && !fresh.some((p) => samePath(p.path, path))) fresh.push({ path, label: baseName(path) || path });
  }
  const at = Math.min(Math.max(index, 0), pins.length);
  return [...pins.slice(0, at), ...fresh, ...pins.slice(at)];
}

/** Moves a pin so it sits before the pin currently at `index` (pins.length = the end). */
export function reorderPin(pins: readonly Pin[], path: string, index: number): Pin[] {
  const from = pins.findIndex((p) => samePath(p.path, path));
  if (from < 0) return [...pins];
  const moved = pins[from];
  const rest = pins.filter((_, i) => i !== from);
  const at = Math.min(Math.max(index > from ? index - 1 : index, 0), rest.length);
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}
