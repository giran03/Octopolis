// The folder filter box: plain text matches names, and `ext:`, `size:`, `modified:` and `type:` narrow by what a file is.

export interface FilterQuery {
  /** Lower-case text the name must contain ("" = any). */
  readonly text: string;
  /** Extensions without the dot, lower case; empty = any. */
  readonly exts: readonly string[];
  readonly minSize: number | null;
  readonly maxSize: number | null;
  /** Earliest modified time in ms; null = any. */
  readonly since: number | null;
  readonly kind: "file" | "folder" | null;
}

const UNITS: Record<string, number> = { b: 1, kb: 1024, k: 1024, mb: 1024 ** 2, m: 1024 ** 2, gb: 1024 ** 3, g: 1024 ** 3 };

/** "10mb" -> bytes, or null when it is not a size. */
export function parseSize(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|k|mb|m|gb|g)?$/i.exec(text.trim());
  return m ? Math.round(parseFloat(m[1]) * UNITS[(m[2] ?? "b").toLowerCase()]) : null;
}

/** The start of a named period, or null when the word is not one. */
export function sinceOf(word: string, now: number): number | null {
  const d = new Date(now);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  switch (word.toLowerCase()) {
    case "today":
      return day;
    case "yesterday":
      return day - 86_400_000;
    case "week":
      return day - 6 * 86_400_000;
    case "month":
      return new Date(d.getFullYear(), d.getMonth() - 1, d.getDate()).getTime();
    case "year":
      return new Date(d.getFullYear() - 1, d.getMonth(), d.getDate()).getTime();
    default:
      return null;
  }
}

/** Splits the filter text into name text and the operators it carries. Unknown operators stay in the text. */
export function parseFilter(input: string, now = Date.now()): FilterQuery {
  const rest: string[] = [];
  let exts: string[] = [];
  let minSize: number | null = null;
  let maxSize: number | null = null;
  let since: number | null = null;
  let kind: "file" | "folder" | null = null;
  for (const word of input.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(ext|size|modified|type):(.+)$/i.exec(word);
    if (!m) {
      rest.push(word);
      continue;
    }
    const op = m[1].toLowerCase();
    const val = m[2];
    if (op === "ext") exts = val.toLowerCase().split(",").map((e) => e.replace(/^\./, "")).filter(Boolean);
    else if (op === "type" && (val === "file" || val === "folder")) kind = val;
    else if (op === "modified" && sinceOf(val, now) !== null) since = sinceOf(val, now);
    else if (op === "size") {
      const s = /^([<>]=?)?(.+)$/.exec(val);
      const bytes = s ? parseSize(s[2]) : null;
      if (bytes === null) rest.push(word);
      else if (s![1]?.startsWith("<")) maxSize = bytes;
      else minSize = bytes;
    } else rest.push(word);
  }
  return { text: rest.join(" ").toLowerCase(), exts, minSize, maxSize, since, kind };
}

export const hasOperators = (q: FilterQuery) => q.exts.length > 0 || q.minSize !== null || q.maxSize !== null || q.since !== null || q.kind !== null;

/** Whether an item passes the operators (the name text is checked separately). */
export function matchesFilter(q: FilterQuery, item: { name: string; dir: boolean; size: number; mtime: number; ext: string }): boolean {
  if (q.text && !item.name.toLowerCase().includes(q.text)) return false;
  if (q.kind && (q.kind === "folder") !== item.dir) return false;
  if (q.exts.length && (item.dir || !q.exts.includes(item.ext.toLowerCase()))) return false;
  if (q.minSize !== null && (item.dir || item.size < q.minSize)) return false;
  if (q.maxSize !== null && (item.dir || item.size > q.maxSize)) return false;
  if (q.since !== null && item.mtime < q.since) return false;
  return true;
}
