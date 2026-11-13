// Folder rules: the saved list. The model and its checks are in lib/rules.ts.
import { createRoot, createSignal } from "solid-js";
import { ui } from "./ui";
import { newRuleId, parseRules, type Rule } from "../lib/rules";
import { loadJson, saveJson } from "./settings";

const KEY = "octopolis.rules.v1";

export const rules = createRoot(() => {
  const [list, setList] = createSignal<readonly Rule[]>(parseRules(loadJson<unknown>(KEY, [])));
  const save = (next: readonly Rule[]) => {
    setList(next);
    saveJson(KEY, next);
  };
  // A rule picked from the command palette: the dialog opens on its preview.
  let pendingRun: string | null = null;
  return {
    list,
    save,
    /** Opens Folder rules on the preview of one rule. */
    requestRun: (id: string) => {
      pendingRun = id;
      ui.setRulesOpen(true);
    },
    /** The rule the dialog should preview as it opens, once. */
    takePendingRun: () => {
      const id = pendingRun;
      pendingRun = null;
      return id;
    },
    /** Adds a rule (giving it an id when it has none) or replaces the one with its id. */
    upsert: (rule: Rule) => {
      const r = rule.id ? rule : { ...rule, id: newRuleId() };
      save(list().some((x) => x.id === r.id) ? list().map((x) => (x.id === r.id ? r : x)) : [...list(), r]);
    },
    patch: (id: string, change: Partial<Rule>) => save(list().map((r) => (r.id === id ? { ...r, ...change } : r))),
    remove: (id: string) => save(list().filter((r) => r.id !== id)),
    recordRun: (id: string, count: number) => save(list().map((r) => (r.id === id ? { ...r, lastRun: { at: Date.now(), count } } : r))),
  };
});
