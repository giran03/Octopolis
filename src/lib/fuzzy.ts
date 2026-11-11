// Small fuzzy matcher for the palette (folders, commands). Characters of the
// query must appear in order; matches at word starts, consecutive runs and in
// the last path segment score higher.

export interface FuzzyMatch {
  readonly score: number;
  /** Indices in the target that matched, for highlighting. */
  readonly positions: readonly number[];
}

const SEPARATORS = new Set(["\\", "/", " ", "_", "-", ".", ":"]);
const MAX_STARTS = 12;

function isBoundary(target: string, i: number): boolean {
  if (i === 0) return true;
  const prev = target[i - 1];
  if (SEPARATORS.has(prev)) return true;
  // camelCase hump: aB
  return prev === prev.toLowerCase() && target[i] !== target[i].toLowerCase();
}

function matchFrom(query: string, target: string, lower: string, start: number): FuzzyMatch | null {
  const q = query.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let ti = start;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === " ") continue;
    // Prefer the next boundary occurrence within reach over a plain one.
    let at = lower.indexOf(ch, ti);
    if (at < 0) return null;
    if (at !== prev + 1) {
      const limit = Math.min(lower.length, at + 24);
      for (let k = at; k < limit; k++) {
        if (lower[k] === ch && isBoundary(target, k)) {
          at = k;
          break;
        }
      }
    }
    score += 16;
    if (isBoundary(target, at)) score += 10;
    if (at === prev + 1) score += 14;
    if (target[at] === query[qi]) score += 2;
    if (prev >= 0) score -= Math.min(at - prev - 1, 12);
    positions.push(at);
    prev = at;
    ti = at + 1;
  }
  if (positions.length === 0) return null;
  // Matches inside the final path segment are what people usually mean.
  const lastSep = Math.max(target.lastIndexOf("\\"), target.lastIndexOf("/"));
  if (positions[0] > lastSep) score += 20;
  // Shorter targets win ties.
  score -= target.length * 0.05;
  return { score, positions };
}

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.trim();
  if (!q) return { score: 0, positions: [] };
  const lower = target.toLowerCase();
  const first = q[0].toLowerCase();
  let best: FuzzyMatch | null = null;
  let from = 0;
  for (let n = 0; n < MAX_STARTS; n++) {
    const start = lower.indexOf(first, from);
    if (start < 0) break;
    const m = matchFrom(q, target, lower, start);
    if (!m) break; // later starts can only match less
    if (!best || m.score > best.score) best = m;
    from = start + 1;
  }
  return best;
}

/** Ranks `items` by `text(item)`, dropping non-matches. */
export function fuzzyRank<T>(query: string, items: readonly T[], text: (t: T) => string, boost?: (t: T) => number): { item: T; match: FuzzyMatch }[] {
  const out: { item: T; match: FuzzyMatch; total: number }[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, text(item));
    if (match) out.push({ item, match, total: match.score + (boost?.(item) ?? 0) });
  }
  out.sort((a, b) => b.total - a.total);
  return out;
}
