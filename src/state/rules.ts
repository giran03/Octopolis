// Folder rules: the saved list and background scheduler. The model and its checks are in lib/rules.ts.
import { createRoot, createSignal } from "solid-js";
import { ops } from "./ops";
import { ui } from "./ui";
import { ruleMatches } from "../lib/ipc";
import {
  DEFAULT_SCHEDULE,
  groupByDestination,
  isRuleDue,
  isScheduleExpired,
  newRuleId,
  parseRules,
  ruleProblem,
  ruleQuery,
  type Rule,
} from "../lib/rules";
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
  let schedulerStarted = false;
  const lastCheck = new Map<string, number>();

  const recordRun = (id: string, count: number) =>
    save(list().map((r) => (r.id === id ? { ...r, lastRun: { at: Date.now(), count } } : r)));

  const executeScheduled = async (r: Rule) => {
    if (ruleProblem(r) !== null) return;
    const now = Date.now();
    lastCheck.set(r.id, now);
    try {
      const matches = await ruleMatches(r.folder, ruleQuery(r));
      if (matches.length > 0) {
        if (r.schedule.actionMode === "preview") {
          ui.toast(`Rule "${r.name}" matched ${matches.length} file${matches.length === 1 ? "" : "s"}`, {
            label: "Preview…",
            onClick: () => {
              pendingRun = r.id;
              ui.setRulesOpen(true);
            },
          });
        } else {
          if (r.action === "move") {
            for (const g of groupByDestination(r, matches)) {
              await ops.transfer("move", g.files.map((m) => m.path), g.dest);
            }
          } else {
            ops.remove(matches.map((m) => m.path), false);
          }
          recordRun(r.id, matches.length);
          ui.toast(`Scheduled rule "${r.name}" ran on ${matches.length} file${matches.length === 1 ? "" : "s"}`);
        }
      }
      // Advance bounded schedules (run-count or duration limits).
      const s = r.schedule;
      if (s.limitKind === "runs") {
        const left = Math.max(0, (s.runsRemaining ?? s.limitValue) - 1);
        const nextSchedule = left === 0 ? { ...s, mode: "manual" as const, limitKind: "forever" as const, runsRemaining: null } : { ...s, runsRemaining: left };
        save(list().map((x) => (x.id === r.id ? { ...x, schedule: nextSchedule } : x)));
      } else if (s.limitKind === "duration" && s.untilAt !== null && Date.now() >= s.untilAt) {
        save(list().map((x) => (x.id === r.id ? { ...x, schedule: { ...DEFAULT_SCHEDULE, actionMode: s.actionMode } } : x)));
      }
    } catch {
      // Folder may be offline/missing; retry on the next scheduled tick.
    }
  };

  const tick = () => {
    const now = Date.now();
    for (const r of list()) {
      if (!r.enabled) continue;
      if (isScheduleExpired(r.schedule, now)) {
        save(list().map((x) => (x.id === r.id ? { ...x, schedule: { ...DEFAULT_SCHEDULE, actionMode: r.schedule.actionMode } } : x)));
        continue;
      }
      if (isRuleDue(r, now, lastCheck.get(r.id) ?? null)) void executeScheduled(r);
    }
  };

  const startScheduler = () => {
    if (schedulerStarted) return;
    schedulerStarted = true;
    setTimeout(() => {
      for (const r of list()) {
        if (r.enabled && r.schedule.mode === "startup") void executeScheduled(r);
      }
    }, 3000);
    setInterval(tick, 30_000);
  };

  return {
    list,
    save,
    startScheduler,
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
    recordRun,
  };
});
