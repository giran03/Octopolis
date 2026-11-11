// Curated context menu ordering: pinned actions first, optional text filter.

export type Entry<T> = T | "separator";

/** Removes leading, trailing and consecutive separators. */
function tidy<T>(entries: readonly Entry<T>[]): Entry<T>[] {
  const out: Entry<T>[] = [];
  for (const e of entries) {
    if (e === "separator" && (out.length === 0 || out[out.length - 1] === "separator")) continue;
    out.push(e);
  }
  if (out[out.length - 1] === "separator") out.pop();
  return out;
}

export function filterMenu<T extends { label: string }>(entries: readonly Entry<T>[], text: string, pinned: ReadonlySet<string>): Entry<T>[] {
  const needle = text.trim().toLowerCase();
  if (needle) return entries.filter((e): e is T => e !== "separator" && e.label.toLowerCase().includes(needle));
  const top = entries.filter((e): e is T => e !== "separator" && pinned.has(e.label));
  const rest = entries.filter((e) => e === "separator" || !pinned.has(e.label));
  return tidy(top.length ? [...top, "separator", ...rest] : rest);
}
