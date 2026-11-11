// Turning the user's per-item choices about name collisions into transfer jobs.

export interface ConflictSide {
  readonly path: string;
  readonly isDir: boolean;
  readonly size: number;
  readonly modifiedMs: number;
}

export interface NameConflict {
  readonly source: ConflictSide;
  readonly target: ConflictSide;
}

/** What to do with one colliding item. "newer" replaces only when the incoming item is newer. */
export type Resolution = "replace" | "skip" | "keepBoth" | "newer";

export interface TransferPlan {
  /** Run with "keep both": free names plus items the user chose to keep both of. */
  readonly keepBoth: readonly string[];
  /** Run with "overwrite": replaced files and merged folders. */
  readonly replace: readonly string[];
  readonly skipped: readonly string[];
}

/** Replacing a folder means merging into it; replacing one kind with another isn't possible. */
export const canReplace = (c: NameConflict) => c.source.isDir === c.target.isDir;

/** The incoming item is strictly newer than the one it would replace. */
export const isNewer = (c: NameConflict) => c.source.modifiedMs > c.target.modifiedMs;

function decide(c: NameConflict, r: Resolution): "replace" | "skip" | "keepBoth" {
  if (r === "newer") return canReplace(c) && isNewer(c) ? "replace" : "skip";
  if (r === "replace" && !canReplace(c)) return "keepBoth";
  return r;
}

/**
 * Splits `sources` by the choices made for conflicting ones (keyed by
 * lower-case source path). Conflicts without a choice use `fallback`.
 */
export function planTransfer(
  sources: readonly string[],
  conflicts: readonly NameConflict[],
  choices: ReadonlyMap<string, Resolution>,
  fallback: Resolution,
): TransferPlan {
  const byPath = new Map(conflicts.map((c) => [c.source.path.toLowerCase(), c]));
  const keepBoth: string[] = [];
  const replace: string[] = [];
  const skipped: string[] = [];
  for (const s of sources) {
    const c = byPath.get(s.toLowerCase());
    if (!c) {
      keepBoth.push(s);
      continue;
    }
    const d = decide(c, choices.get(s.toLowerCase()) ?? fallback);
    (d === "replace" ? replace : d === "skip" ? skipped : keepBoth).push(s);
  }
  return { keepBoth, replace, skipped };
}
