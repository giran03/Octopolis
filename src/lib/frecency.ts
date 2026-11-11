// zoxide-style "frecency": folders you visit often and recently rank first.

export interface Visit {
  readonly rank: number;
  readonly last: number;
}
export type FrecencyDb = Readonly<Record<string, Visit>>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** When total rank passes this, everything is aged and stale entries dropped. */
export const MAX_TOTAL_RANK = 5_000;

const key = (path: string) => path.replace(/\\+$/, "").toLowerCase();

/** Records a visit, returning a new database. Keeps the latest spelling of the path. */
export function recordVisit(db: FrecencyDb, path: string, now: number): FrecencyDb {
  const k = key(path);
  const prev = db[k];
  const next: Record<string, Visit & { path?: string }> = { ...db, [k]: { rank: (prev?.rank ?? 0) + 1, last: now, path } as Visit };
  const total = Object.values(next).reduce((s, v) => s + v.rank, 0);
  if (total <= MAX_TOTAL_RANK) return next;
  const aged: Record<string, Visit> = {};
  for (const [p, v] of Object.entries(next)) {
    const rank = v.rank * 0.9;
    if (rank >= 1) aged[p] = { ...v, rank };
  }
  return aged;
}

export function frecencyScore(v: Visit, now: number): number {
  const age = now - v.last;
  const factor = age < HOUR ? 4 : age < DAY ? 2 : age < WEEK ? 0.5 : 0.25;
  return v.rank * factor;
}

export function forget(db: FrecencyDb, path: string): FrecencyDb {
  const copy = { ...db };
  delete copy[key(path)];
  return copy;
}

/** Display path for an entry (the spelling recorded at the last visit). */
export function pathOf(k: string, v: Visit): string {
  return (v as Visit & { path?: string }).path ?? k;
}

/** Entries sorted by score, best first. */
export function topVisits(db: FrecencyDb, now: number, limit = 200): { path: string; score: number }[] {
  return Object.entries(db)
    .map(([k, v]) => ({ path: pathOf(k, v), score: frecencyScore(v, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
