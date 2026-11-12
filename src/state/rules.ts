// Folder rules: tidy a folder by moving or deleting the files that match name patterns and are old enough.
import { createRoot, createSignal } from "solid-js";
import { loadJson, saveJson } from "./settings";

export interface Rule {
  readonly id: string;
  readonly name: string;
  readonly folder: string;
  /** Name patterns separated by `;`, such as `*.pdf; invoice*`. Empty matches every file. */
  readonly patterns: string;
  readonly olderThanDays: number;
  readonly recursive: boolean;
  readonly action: "move" | "recycle";
  /** Where moved files go (for `move`). */
  readonly dest: string;
  readonly enabled: boolean;
}

const KEY = "octopolis.rules.v1";

export function blankRule(): Rule {
  return { id: `r${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, name: "", folder: "", patterns: "", olderThanDays: 30, recursive: false, action: "move", dest: "", enabled: true };
}

/** Whether a rule has what it needs to run. */
export function ruleProblem(r: Rule): string | null {
  if (!r.folder.trim()) return "Choose the folder to tidy";
  if (r.action === "move" && !r.dest.trim()) return "Choose where the files go";
  if (r.action === "move" && r.dest.trim().toLowerCase() === r.folder.trim().toLowerCase()) return "The destination is the folder itself";
  if (!Number.isFinite(r.olderThanDays) || r.olderThanDays < 0) return "Days must be 0 or more";
  return null;
}

export const rules = createRoot(() => {
  const [list, setList] = createSignal<readonly Rule[]>(loadJson<Rule[]>(KEY, []).filter((r) => r && typeof r.id === "string"));
  const save = (next: readonly Rule[]) => {
    setList(next);
    saveJson(KEY, next);
  };
  return {
    list,
    upsert: (rule: Rule) => save(list().some((r) => r.id === rule.id) ? list().map((r) => (r.id === rule.id ? rule : r)) : [...list(), rule]),
    remove: (id: string) => save(list().filter((r) => r.id !== id)),
    toggle: (id: string) => save(list().map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))),
  };
});
