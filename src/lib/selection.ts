// Pure list-selection and keyboard-navigation rules.

export interface Mods {
  readonly ctrl: boolean;
  readonly shift: boolean;
}

export interface SelectResult {
  readonly selection: ReadonlySet<number>;
  readonly anchor: number;
}

/** Applies a click (or keyboard move) at view position `pos`. */
export function selectAt(view: Uint32Array, current: ReadonlySet<number>, anchor: number, pos: number, mods: Mods): SelectResult {
  if (pos < 0 || pos >= view.length) return { selection: current, anchor };
  if (mods.shift) {
    const [lo, hi] = anchor <= pos ? [anchor, pos] : [pos, anchor];
    const range = new Set(mods.ctrl ? current : []);
    for (let p = Math.max(0, lo); p <= Math.min(hi, view.length - 1); p++) range.add(view[p]);
    return { selection: range, anchor };
  }
  if (mods.ctrl) {
    const next = new Set(current);
    const entry = view[pos];
    if (next.has(entry)) next.delete(entry);
    else next.add(entry);
    return { selection: next, anchor: pos };
  }
  return { selection: new Set([view[pos]]), anchor: pos };
}

export function selectAll(view: Uint32Array): ReadonlySet<number> {
  return new Set(view);
}

export type NavKey = "ArrowUp" | "ArrowDown" | "Home" | "End" | "PageUp" | "PageDown";
export const NAV_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/** New focus position after a navigation key, clamped to the list. */
export function moveFocus(length: number, pos: number, key: NavKey, pageRows: number): number {
  if (length === 0) return 0;
  const step = Math.max(1, pageRows - 1);
  const next = {
    ArrowUp: pos - 1,
    ArrowDown: pos + 1,
    Home: 0,
    End: length - 1,
    PageUp: pos - step,
    PageDown: pos + step,
  }[key];
  return Math.min(Math.max(next, 0), length - 1);
}

/**
 * Finds the next view position whose name starts with `prefix`, searching
 * from `from` and wrapping around. A one-letter prefix starts after `from`
 * so repeated presses cycle through matches. Returns -1 if nothing matches.
 */
export function typeAhead(names: readonly string[], view: Uint32Array, from: number, prefix: string): number {
  const want = prefix.toLowerCase();
  const n = view.length;
  const start = prefix.length === 1 ? from + 1 : from;
  for (let k = 0; k < n; k++) {
    const pos = (start + k) % n;
    if (names[view[pos]].toLowerCase().startsWith(want)) return pos;
  }
  return -1;
}
