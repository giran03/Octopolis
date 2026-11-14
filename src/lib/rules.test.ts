import { describe, expect, it } from "vitest";
import { RULE_PRESETS, presetFolderIds, resolvePreset } from "./rulePresets";
import {
  blankRule,
  DEFAULT_SCHEDULE,
  expandDest,
  groupByDestination,
  isRuleDue,
  isScheduleExpired,
  nextRuleRunAt,
  parseRules,
  parseRulesText,
  ruleProblem,
  ruleQuery,
  rulesToJson,
  ruleSummary,
  scheduleSummary,
  sinceText,
  uniqueRuleName,
  type Rule,
} from "./rules";

const rule = (over: Partial<Rule> = {}): Rule => ({ ...blankRule(), folder: "C:\\Users\\Me\\Downloads", dest: "D:\\Archive", ...over });
const FOLDERS = { downloads: "C:\\Users\\Me\\Downloads", documents: "C:\\Users\\Me\\Documents", pictures: "C:\\Users\\Me\\Pictures", desktop: "C:\\Users\\Me\\Desktop" };

describe("rule problems", () => {
  it("accepts a complete rule", () => expect(ruleProblem(rule())).toBeNull());
  it("asks for a folder and a destination", () => {
    expect(ruleProblem(rule({ folder: " " }))).toMatch(/folder to tidy/);
    expect(ruleProblem(rule({ dest: "" }))).toMatch(/where the files go/);
    expect(ruleProblem(rule({ action: "recycle", dest: "" }))).toBeNull();
  });
  it("refuses the folder itself, even with a trailing slash or other case", () => {
    expect(ruleProblem(rule({ dest: "c:\\users\\me\\downloads\\" }))).toMatch(/folder itself/);
  });
  it("checks tokens, ages and size", () => {
    expect(ruleProblem(rule({ dest: "D:\\{day}" }))).toMatch(/\{day\}/);
    expect(ruleProblem(rule({ dest: "D:\\{year}\\{month}\\{ext}" }))).toBeNull();
    expect(ruleProblem(rule({ olderThanDays: -1 }))).toMatch(/0 or more/);
    expect(ruleProblem(rule({ olderThanDays: 30, newerThanDays: 10 }))).toMatch(/newest/);
    expect(ruleProblem(rule({ minSizeMb: -5 }))).toMatch(/size/);
  });
});

describe("rule query and summary", () => {
  it("sends whole days and a clean size", () => {
    expect(ruleQuery(rule({ olderThanDays: 29.9, newerThanDays: 60.2, minSizeMb: 1.5 }))).toMatchObject({ olderThanDays: 29, newerThanDays: 60, minSizeMb: 1.5 });
    expect(ruleQuery(rule({ olderThanDays: Number.NaN, minSizeMb: Number.NaN }))).toMatchObject({ olderThanDays: 0, minSizeMb: 0 });
  });
  it("reads as a sentence", () => {
    expect(ruleSummary(rule({ patterns: "*.pdf", olderThanDays: 1, action: "recycle" }))).toBe("*.pdf in Downloads, not changed for 1 day → Recycle Bin");
    expect(ruleSummary(rule({ minSizeMb: 5, recursive: true }))).toBe("All files in Downloads, not changed for 30 days, at least 5 MB, with subfolders → D:\\Archive");
  });
});

describe("destinations", () => {
  const ms = new Date(2026, 2, 9).getTime();
  it("fills in year, month and extension", () => {
    expect(expandDest("D:\\{year}\\{month}\\{ext}", "Trip.JPG", ms)).toBe("D:\\2026\\03\\jpg");
    expect(expandDest("D:\\{ext}", "README", ms)).toBe("D:\\none");
  });
  it("groups files by where they go", () => {
    const r = rule({ dest: "D:\\{year}" });
    const g = groupByDestination(r, [
      { path: "C:\\a.png", modifiedMs: ms },
      { path: "C:\\b.png", modifiedMs: new Date(2025, 0, 1).getTime() },
      { path: "C:\\c.png", modifiedMs: ms },
    ]);
    expect(g.map((x) => [x.dest, x.files.length])).toEqual([["D:\\2026", 2], ["D:\\2025", 1]]);
  });
});

describe("storing and sharing", () => {
  it("loads older saves and repairs damaged ones", () => {
    const old = { id: "a", name: "Old", folder: "C:\\x", patterns: "*.pdf", olderThanDays: 30, recursive: false, action: "move", dest: "D:\\y", enabled: true };
    const [r] = parseRules([old, null, 5, { name: "no folder" }, { ...old, olderThanDays: "x", minSizeMb: -3 }]);
    expect(r).toMatchObject({ id: "a", newerThanDays: null, minSizeMb: 0, lastRun: null });
    expect(parseRules([old, old, { ...old, olderThanDays: 99999999 }]).map((x) => x.id).filter((id, i, all) => all.indexOf(id) === i)).toHaveLength(3);
    expect(parseRules("nope")).toEqual([]);
    expect(parseRules(Array.from({ length: 300 }, () => old))).toHaveLength(200);
  });
  it("round-trips through JSON without ids or history", () => {
    const list = [rule({ name: "A", lastRun: { at: 5, count: 3 } }), rule({ name: "B", action: "recycle", newerThanDays: 90, olderThanDays: 30 })];
    const json = rulesToJson(list);
    expect(json).not.toMatch(/"id"|lastRun/);
    const back = parseRulesText(json);
    expect(back.map((r) => r.name)).toEqual(["A", "B"]);
    expect(back[1]).toMatchObject({ action: "recycle", newerThanDays: 90 });
    expect(new Set(back.map((r) => r.id)).size).toBe(2);
    expect(back[0].lastRun).toBeNull();
  });
  it("explains a bad import", () => {
    expect(() => parseRulesText("{oops")).toThrow(/not valid JSON/);
    expect(() => parseRulesText("[1, 2]")).toThrow(/No usable rule/);
    expect(parseRulesText(JSON.stringify(rule({ name: "Solo" })))).toHaveLength(1);
  });
  it("makes names unique", () => {
    expect(uniqueRuleName("Old PDFs", ["old pdfs", "Old PDFs 2"])).toBe("Old PDFs 3");
    expect(uniqueRuleName("New", ["Other"])).toBe("New");
  });
  it("says how long ago", () => {
    const now = Date.UTC(2026, 5, 1);
    expect(sinceText(now - 3600_000, now)).toBe("today");
    expect(sinceText(now - 86_400_000 * 1.5, now)).toBe("yesterday");
    expect(sinceText(now - 86_400_000 * 12, now)).toBe("12 days ago");
    expect(sinceText(now - 86_400_000 * 90, now)).toBe("3 months ago");
  });
});

describe("presets", () => {
  it("have unique names and real descriptions", () => {
    const names = RULE_PRESETS.map((p) => p.rule.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const p of RULE_PRESETS) expect(p.description.length).toBeGreaterThan(20);
  });
  it("become valid rules once the folders are known", () => {
    for (const p of RULE_PRESETS) {
      const r = resolvePreset(p, FOLDERS);
      expect(r, p.rule.name).not.toBeNull();
      expect(ruleProblem({ ...r!, id: "x" }), p.rule.name).toBeNull();
      expect(JSON.stringify(r)).not.toMatch(/\{(downloads|documents|pictures|desktop)\}/);
    }
  });
  it("are left out when a folder is unknown", () => {
    expect(resolvePreset(RULE_PRESETS[0], {})).toBeNull();
    expect(presetFolderIds(RULE_PRESETS.find((p) => p.rule.name === "Old PDFs to Documents")!).sort()).toEqual(["documents", "downloads"]);
  });
  it("are safe: only the Recycle Bin, never delete for good, nothing fresh", () => {
    for (const p of RULE_PRESETS) {
      expect(["move", "recycle"]).toContain(p.rule.action);
      expect(p.rule.olderThanDays, p.rule.name).toBeGreaterThanOrEqual(3);
      expect(p.rule.enabled).toBe(true);
    }
  });
  it("round-trip through the shareable JSON", () => {
    const rules = RULE_PRESETS.map((p) => ({ ...resolvePreset(p, FOLDERS)!, id: "x" }));
    expect(parseRulesText(rulesToJson(rules))).toHaveLength(RULE_PRESETS.length);
  });
});

describe("schedules", () => {
  it("defaults to manual and summarizes intervals and limits", () => {
    expect(scheduleSummary(DEFAULT_SCHEDULE)).toBe("Manual");
    expect(scheduleSummary({ ...DEFAULT_SCHEDULE, mode: "interval", every: 15, unit: "minutes" })).toBe("Every 15 minutes");
    expect(scheduleSummary({ ...DEFAULT_SCHEDULE, mode: "daily", time: "09:00", limitKind: "runs", limitValue: 3, runsRemaining: 2 })).toBe("Daily at 09:00 · 2 runs");
    expect(scheduleSummary({ ...DEFAULT_SCHEDULE, mode: "interval", every: 1, unit: "hours", limitKind: "duration", limitValue: 24, limitUnit: "hours" })).toBe("Every 1 hour · for 24 hours");
  });

  it("computes next run times and due state", () => {
    const base = new Date(2026, 10, 14, 8, 30, 0).getTime();
    const daily = { ...DEFAULT_SCHEDULE, mode: "daily" as const, time: "09:00" };
    expect(nextRuleRunAt(daily, base, null)).toBe(new Date(2026, 10, 14, 9, 0, 0).getTime());
    expect(isRuleDue(rule({ schedule: daily }), new Date(2026, 10, 14, 9, 1, 0).getTime(), base)).toBe(true);
    expect(isRuleDue(rule({ schedule: daily }), new Date(2026, 10, 14, 8, 45, 0).getTime(), base)).toBe(false);

    const interval = { ...DEFAULT_SCHEDULE, mode: "interval" as const, every: 30, unit: "minutes" as const };
    expect(isRuleDue(rule({ schedule: interval, lastRun: { at: base, count: 1 } }), base + 31 * 60_000, null)).toBe(true);
    expect(isRuleDue(rule({ schedule: interval, lastRun: { at: base, count: 1 } }), base + 10 * 60_000, null)).toBe(false);
  });

  it("detects expired run-count and duration limits", () => {
    expect(isScheduleExpired({ ...DEFAULT_SCHEDULE, mode: "interval", limitKind: "runs", runsRemaining: 0 }, 1000)).toBe(true);
    expect(isScheduleExpired({ ...DEFAULT_SCHEDULE, mode: "interval", limitKind: "duration", untilAt: 1000 }, 1500)).toBe(true);
    expect(isScheduleExpired({ ...DEFAULT_SCHEDULE, mode: "interval", limitKind: "duration", untilAt: 2000 }, 1500)).toBe(false);
  });
});
