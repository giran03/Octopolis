// Pure list-selection and keyboard-navigation rules.
import { extensionOf as fileExtension } from "./paths";

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

/** Every visible entry that isn't selected now. */
export function invertSelection(view: Uint32Array, current: ReadonlySet<number>): ReadonlySet<number> {
  const out = new Set<number>();
  for (const e of view) if (!current.has(e)) out.add(e);
  return out;
}

/** Visible entries whose name passes `test`. */
export function selectWhere(view: Uint32Array, names: readonly string[], test: (name: string) => boolean): ReadonlySet<number> {
  const out = new Set<number>();
  for (const e of view) if (test(names[e])) out.add(e);
  return out;
}

/** Visible entries passing `test(entry)`. */
export function selectEntriesWhere(view: Uint32Array, test: (entry: number) => boolean): ReadonlySet<number> {
  const out = new Set<number>();
  for (const e of view) if (test(e)) out.add(e);
  return out;
}

const baseOfName = (name: string) => name.slice(Math.max(name.lastIndexOf("\\"), name.lastIndexOf("/")) + 1);

/** Lower-case extension of the last path segment, or "" for none (".gitignore" has none). */
export const extensionOf = (name: string): string => fileExtension(baseOfName(name));

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

/**
 * Builds a name test from user text: `re:<regex>` for a regular expression,
 * otherwise one or more `;`-separated wildcard patterns (`*.jpg; IMG_????.*`).
 * A pattern without wildcards matches names containing it. Throws on a bad regex.
 */
export function namePattern(text: string): (name: string) => boolean {
  const trimmed = text.trim();
  if (trimmed.toLowerCase().startsWith("re:")) {
    const re = new RegExp(trimmed.slice(3), "i");
    return (name) => re.test(baseOfName(name));
  }
  const parts = trimmed
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => globToRegExp(/[*?]/.test(p) ? p : `*${p}*`));
  if (parts.length === 0) return () => false;
  return (name) => parts.some((re) => re.test(baseOfName(name)));
}

/**
 * Builds an entry matcher supporting `re:<regex>`, `type:dir` / `type:folder`,
 * `type:file`, and `;`-separated wildcard/substring patterns (`*.png; type:dir`).
 */
export function entryPattern(text: string): (name: string, dir: boolean) => boolean {
  const trimmed = text.trim();
  if (trimmed.toLowerCase().startsWith("re:")) {
    const re = new RegExp(trimmed.slice(3), "i");
    return (name) => re.test(baseOfName(name));
  }
  const tests = trimmed
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p): ((name: string, dir: boolean) => boolean) => {
      const low = p.toLowerCase();
      if (low === "type:dir" || low === "type:folder") return (_name, dir) => dir;
      if (low === "type:file") return (_name, dir) => !dir;
      const re = globToRegExp(/[*?]/.test(p) ? p : `*${p}*`);
      return (name) => re.test(baseOfName(name));
    });
  if (tests.length === 0) return () => false;
  return (name, dir) => tests.some((fn) => fn(name, dir));
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
  if (n === 0 || want === "") return -1;
  const validFrom = from >= 0 && from < n;
  const start = prefix.length === 1 ? (validFrom ? (from + 1) % n : 0) : validFrom ? from : 0;
  for (let k = 0; k < n; k++) {
    const pos = (start + k) % n;
    if (baseOfName(names[view[pos]]).toLowerCase().startsWith(want)) return pos;
  }
  return -1;
}

export interface TypeAheadState {
  readonly prefix: string;
  readonly at: number;
  readonly context: string;
}

export const EMPTY_TYPE_AHEAD: TypeAheadState = { prefix: "", at: 0, context: "" };

/**
 * Advances the type-ahead buffer for a single printable key.
 * Pressing the same single letter repeatedly within `resetMs` keeps a 1-char
 * prefix so `typeAhead` cycles through every matching item in order.
 */
export function nextTypeAhead(
  state: TypeAheadState,
  key: string,
  now: number,
  resetMs: number,
  context = "",
): TypeAheadState | null {
  const expired = state.prefix === "" || now - state.at > resetMs || state.context !== context;
  if (expired && key === " ") return null;
  const prefix =
    expired
      ? key
      : state.prefix.length === 1 && key.toLowerCase() === state.prefix.toLowerCase()
        ? key
        : state.prefix + key;
  return { prefix, at: now, context };
}

export interface TypeAheadMatchInfo {
  readonly index: number;
  readonly total: number;
}

/** 1-based match position and total matches for `prefix` (capped on huge folders). */
export function typeAheadMatchInfo(
  names: readonly string[],
  view: Uint32Array,
  pos: number,
  prefix: string,
): TypeAheadMatchInfo {
  const want = prefix.toLowerCase();
  const n = view.length;
  if (n === 0 || want === "" || n > 10_000) return { index: 0, total: 0 };
  let total = 0;
  let index = 0;
  for (let i = 0; i < n; i++) {
    if (baseOfName(names[view[i]]).toLowerCase().startsWith(want)) {
      total++;
      if (i === pos) index = total;
    }
  }
  return { index, total };
}

/** View positions of list rows that a vertical band (content pixels) touches. */
export function rowsInBand(length: number, rowHeight: number, y1: number, y2: number): [number, number] | null {
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  const first = Math.max(0, Math.floor(top / rowHeight));
  const last = Math.min(length - 1, Math.floor((bottom - 0.001) / rowHeight));
  return length === 0 || last < first ? null : [first, last];
}

/** View positions of grid cells (laid out `columns` per row) that a rectangle touches. */
export function cellsInRect(length: number, columns: number, cellW: number, cellH: number, x1: number, y1: number, x2: number, y2: number): number[] {
  const [left, right] = [Math.min(x1, x2), Math.max(x1, x2)];
  const [top, bottom] = [Math.min(y1, y2), Math.max(y1, y2)];
  const c0 = Math.max(0, Math.floor(left / cellW));
  const c1 = Math.min(columns - 1, Math.floor((right - 0.001) / cellW));
  const r0 = Math.max(0, Math.floor(top / cellH));
  const r1 = Math.floor((bottom - 0.001) / cellH);
  const out: number[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const pos = r * columns + c;
      if (pos < length) out.push(pos);
    }
  }
  return out;
}

/** The selection while dragging a box: what was selected before (when adding) plus the boxed entries. */
export function marqueeSelection(view: Uint32Array, base: ReadonlySet<number>, positions: readonly number[]): ReadonlySet<number> {
  const out = new Set(base);
  for (const p of positions) if (p >= 0 && p < view.length) out.add(view[p]);
  return out;
}
