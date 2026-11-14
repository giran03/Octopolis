// Folder rules: the model, its checks, and reading/writing the shareable JSON. Pure; the dialog and the store use it.
import { baseName } from "./paths";

export type RuleAction = "move" | "recycle";
export type ScheduleMode = "manual" | "interval" | "daily" | "weekly" | "monthly" | "startup";
export type IntervalUnit = "minutes" | "hours" | "days";
export type ScheduleLimitKind = "forever" | "runs" | "duration";
export type ScheduleActionMode = "auto" | "preview";

export interface RuleSchedule {
  readonly mode: ScheduleMode;
  readonly every: number;
  readonly unit: IntervalUnit;
  /** 24-hour `HH:MM` for daily, weekly, and monthly schedules. */
  readonly time: string;
  /** 0 (Sun) .. 6 (Sat) for weekly schedules. */
  readonly weekday: number;
  /** 1..31 for monthly schedules. */
  readonly monthDay: number;
  readonly limitKind: ScheduleLimitKind;
  /** Run count (when `limitKind === "runs"`) or duration count (when `limitKind === "duration"`). */
  readonly limitValue: number;
  readonly limitUnit: "hours" | "days";
  /** Remaining runs when `limitKind === "runs"`. */
  readonly runsRemaining: number | null;
  /** Epoch ms deadline when `limitKind === "duration"`. */
  readonly untilAt: number | null;
  readonly actionMode: ScheduleActionMode;
}

export interface Rule {
  readonly id: string;
  readonly name: string;
  readonly folder: string;
  /** Name patterns separated by `;`, such as `*.pdf; invoice*`. Empty matches every file. */
  readonly patterns: string;
  /** Not changed for at least this many days. */
  readonly olderThanDays: number;
  /** When set, also changed within this many days (a window with `olderThanDays`). */
  readonly newerThanDays: number | null;
  /** Only files at least this big, in MB (0: any size). */
  readonly minSizeMb: number;
  readonly recursive: boolean;
  readonly action: RuleAction;
  /** Where moved files go. May hold {year}, {month} and {ext}, filled in from each file. */
  readonly dest: string;
  readonly enabled: boolean;
  /** When the rule last ran from here, and on how many files. */
  readonly lastRun: { readonly at: number; readonly count: number } | null;
  readonly schedule: RuleSchedule;
}

/** What the file finder is asked for. */
export interface RuleQuery {
  readonly patterns: string;
  readonly olderThanDays: number;
  readonly newerThanDays: number | null;
  readonly minSizeMb: number;
  readonly recursive: boolean;
}

export const DEST_TOKENS: readonly { token: string; hint: string }[] = [
  { token: "{year}", hint: "The year the file was last changed, such as 2026" },
  { token: "{month}", hint: "The month it was last changed, such as 03" },
  { token: "{ext}", hint: "Its extension in lowercase, such as pdf" },
];
const TOKEN_NAMES = new Set(DEST_TOKENS.map((t) => t.token.slice(1, -1)));

export function newRuleId(): string {
  return `r${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export const DEFAULT_SCHEDULE: RuleSchedule = {
  mode: "manual",
  every: 1,
  unit: "days",
  time: "09:00",
  weekday: 1,
  monthDay: 1,
  limitKind: "forever",
  limitValue: 3,
  limitUnit: "days",
  runsRemaining: null,
  untilAt: null,
  actionMode: "auto",
};

export const NEW_RULE: Omit<Rule, "id"> = { name: "", folder: "", patterns: "", olderThanDays: 30, newerThanDays: null, minSizeMb: 0, recursive: false, action: "move", dest: "", enabled: true, lastRun: null, schedule: DEFAULT_SCHEDULE };

export const blankRule = (): Rule => ({ ...NEW_RULE, id: newRuleId() });

const wholeDays = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

/** Whether a rule has what it needs to run, as a message to show, or null. */
export function ruleProblem(r: Rule): string | null {
  if (!r.folder.trim()) return "Choose the folder to tidy";
  if (r.action === "move") {
    if (!r.dest.trim()) return "Choose where the files go";
    const bad = [...r.dest.matchAll(/\{([^{}]*)\}/g)].find((m) => !TOKEN_NAMES.has(m[1]));
    if (bad) return `${bad[0]} isn't something a destination can use (try {year}, {month} or {ext})`;
    if (r.dest.trim().replace(/[\\/]+$/, "").toLowerCase() === r.folder.trim().replace(/[\\/]+$/, "").toLowerCase()) return "The destination is the folder itself";
  }
  if (!Number.isFinite(r.olderThanDays) || r.olderThanDays < 0) return "Days must be 0 or more";
  if (r.newerThanDays !== null && (!Number.isFinite(r.newerThanDays) || r.newerThanDays < r.olderThanDays)) return "The newest age can't be lower than the oldest";
  if (!Number.isFinite(r.minSizeMb) || r.minSizeMb < 0) return "The size must be 0 or more";
  return null;
}

/** What the finder is asked for: whole days and a clean number for the size. */
export function ruleQuery(r: Rule): RuleQuery {
  return {
    patterns: r.patterns,
    olderThanDays: wholeDays(r.olderThanDays),
    newerThanDays: r.newerThanDays === null ? null : wholeDays(r.newerThanDays),
    minSizeMb: Number.isFinite(r.minSizeMb) ? Math.max(0, r.minSizeMb) : 0,
    recursive: r.recursive,
  };
}

const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** "*.pdf in Downloads, 30+ days old, over 5 MB → Recycle Bin" */
export function ruleSummary(r: Rule): string {
  const age = r.newerThanDays !== null ? `${r.olderThanDays}–${days(r.newerThanDays)} old` : r.olderThanDays > 0 ? `not changed for ${days(r.olderThanDays)}` : "any age";
  const parts = [`${r.patterns.trim() || "All files"} in ${baseName(r.folder) || r.folder || "…"}`, age];
  if (r.minSizeMb > 0) parts.push(`at least ${r.minSizeMb} MB`);
  if (r.recursive) parts.push("with subfolders");
  return `${parts.join(", ")} → ${r.action === "move" ? r.dest.trim() || "…" : "Recycle Bin"}`;
}

/** The destination for one file: {year}, {month} and {ext} filled in from when it was last changed. */
export function expandDest(dest: string, name: string, modifiedMs: number): string {
  const d = new Date(modifiedMs);
  const dot = name.lastIndexOf(".");
  const values: Record<string, string> = {
    year: String(d.getFullYear()),
    month: String(d.getMonth() + 1).padStart(2, "0"),
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[<>:"/\\|?*]/g, "") || "none" : "none",
  };
  return dest.trim().replace(/\{(year|month|ext)\}/g, (_, k: string) => values[k]);
}

/** Matched files grouped by where they go, in the order the places first appear. */
export function groupByDestination<T extends { path: string; modifiedMs: number }>(rule: Rule, matches: readonly T[]): { dest: string; files: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const m of matches) {
    const dest = expandDest(rule.dest, baseName(m.path), m.modifiedMs);
    const list = groups.get(dest);
    if (list) list.push(m);
    else groups.set(dest, [m]);
  }
  return [...groups].map(([dest, files]) => ({ dest, files }));
}

const num = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : 0);

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export const SCHEDULE_PRESETS: readonly { label: string; patch: Partial<RuleSchedule> }[] = [
  { label: "Manual", patch: { mode: "manual", limitKind: "forever", runsRemaining: null, untilAt: null } },
  { label: "On startup", patch: { mode: "startup", limitKind: "forever", runsRemaining: null, untilAt: null } },
  { label: "Every 15 min", patch: { mode: "interval", every: 15, unit: "minutes" } },
  { label: "Every hour", patch: { mode: "interval", every: 1, unit: "hours" } },
  { label: "Every 6 hours", patch: { mode: "interval", every: 6, unit: "hours" } },
  { label: "Daily 09:00", patch: { mode: "daily", time: "09:00" } },
  { label: "Weekly (Mon)", patch: { mode: "weekly", weekday: 1, time: "09:00" } },
  { label: "Monthly (1st)", patch: { mode: "monthly", monthDay: 1, time: "09:00" } },
];

export function intervalMs(every: number, unit: IntervalUnit): number {
  const n = Math.max(1, Math.floor(every || 1));
  const mult = unit === "minutes" ? 60_000 : unit === "hours" ? 3_600_000 : 86_400_000;
  return n * mult;
}

function parseTimeParts(time: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  const hh = m ? Math.min(23, Math.max(0, Number(m[1]))) : 9;
  const mm = m ? Math.min(59, Math.max(0, Number(m[2]))) : 0;
  return [hh, mm];
}

/** Human-readable label for a rule's schedule. */
export function scheduleSummary(s: RuleSchedule): string {
  if (s.mode === "manual") return "Manual";
  let base = "";
  if (s.mode === "startup") base = "On startup";
  else if (s.mode === "interval") {
    const unit = s.every === 1 ? s.unit.slice(0, -1) : s.unit;
    base = `Every ${s.every} ${unit}`;
  } else if (s.mode === "daily") base = `Daily at ${s.time}`;
  else if (s.mode === "weekly") base = `Weekly (${WEEKDAYS[s.weekday] ?? "Mon"} ${s.time})`;
  else if (s.mode === "monthly") base = `Monthly (day ${s.monthDay} at ${s.time})`;

  if (s.limitKind === "runs") {
    const left = s.runsRemaining ?? s.limitValue;
    base += ` · ${left} run${left === 1 ? "" : "s"}`;
  } else if (s.limitKind === "duration") {
    const u = s.limitValue === 1 ? s.limitUnit.slice(0, -1) : s.limitUnit;
    base += ` · for ${s.limitValue} ${u}`;
  }
  return base;
}

/** Whether a scheduled rule has exhausted its configured run count or duration window. */
export function isScheduleExpired(s: RuleSchedule, now: number): boolean {
  if (s.mode === "manual" || s.mode === "startup") return false;
  if (s.limitKind === "runs" && s.runsRemaining !== null && s.runsRemaining <= 0) return true;
  if (s.limitKind === "duration" && s.untilAt !== null && now >= s.untilAt) return true;
  return false;
}

/** Computes the next wall-clock timestamp when a rule is due, or null for manual/startup/expired. */
export function nextRuleRunAt(s: RuleSchedule, now: number, lastAt: number | null): number | null {
  if (s.mode === "manual" || s.mode === "startup" || isScheduleExpired(s, now)) return null;
  if (s.mode === "interval") {
    const step = intervalMs(s.every, s.unit);
    return lastAt !== null ? lastAt + step : now + step;
  }
  const [hh, mm] = parseTimeParts(s.time);
  const base = new Date(lastAt ?? now);
  if (s.mode === "daily") {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh, mm, 0, 0);
    if (d.getTime() <= (lastAt ?? now - 1)) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (s.mode === "weekly") {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh, mm, 0, 0);
    const diff = (s.weekday - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + diff);
    if (d.getTime() <= (lastAt ?? now - 1)) d.setDate(d.getDate() + 7);
    return d.getTime();
  }
  // monthly
  const y = base.getFullYear();
  const m = base.getMonth();
  const clampDay = (yr: number, mo: number) => Math.min(Math.max(1, s.monthDay), new Date(yr, mo + 1, 0).getDate());
  let d = new Date(y, m, clampDay(y, m), hh, mm, 0, 0);
  if (d.getTime() <= (lastAt ?? now - 1)) d = new Date(y, m + 1, clampDay(y, m + 1), hh, mm, 0, 0);
  return d.getTime();
}

export function isRuleDue(r: Rule, now: number, lastCheckAt: number | null): boolean {
  if (!r.enabled || r.schedule.mode === "manual" || r.schedule.mode === "startup") return false;
  if (isScheduleExpired(r.schedule, now)) return false;
  const ref = Math.max(r.lastRun?.at ?? 0, lastCheckAt ?? 0) || null;
  const next = nextRuleRunAt(r.schedule, now, ref);
  return next !== null && now >= next;
}

export function parseSchedule(raw: unknown): RuleSchedule {
  if (!raw || typeof raw !== "object") return DEFAULT_SCHEDULE;
  const o = raw as Record<string, unknown>;
  const mode: ScheduleMode = o.mode === "interval" || o.mode === "daily" || o.mode === "weekly" || o.mode === "monthly" || o.mode === "startup" ? o.mode : "manual";
  const unit: IntervalUnit = o.unit === "minutes" || o.unit === "hours" || o.unit === "days" ? o.unit : "days";
  const time = typeof o.time === "string" && /^\d{1,2}:\d{2}$/.test(o.time.trim()) ? o.time.trim().padStart(5, "0") : "09:00";
  const limitKind: ScheduleLimitKind = o.limitKind === "runs" || o.limitKind === "duration" ? o.limitKind : "forever";
  const limitUnit: "hours" | "days" = o.limitUnit === "hours" ? "hours" : "days";
  const actionMode: ScheduleActionMode = o.actionMode === "preview" ? "preview" : "auto";
  return {
    mode,
    every: Math.max(1, Math.min(999, Math.floor(num(o.every, 999)) || 1)),
    unit,
    time,
    weekday: Math.min(6, Math.max(0, Math.floor(num(o.weekday, 6)))),
    monthDay: Math.min(31, Math.max(1, Math.floor(num(o.monthDay, 31)) || 1)),
    limitKind,
    limitValue: Math.max(1, Math.min(999, Math.floor(num(o.limitValue, 999)) || 1)),
    limitUnit,
    runsRemaining: typeof o.runsRemaining === "number" && Number.isFinite(o.runsRemaining) ? Math.max(0, Math.floor(o.runsRemaining)) : null,
    untilAt: typeof o.untilAt === "number" && Number.isFinite(o.untilAt) ? o.untilAt : null,
    actionMode,
  };
}

/** One rule from stored or imported data; older saves (name, folder, patterns, age, action, dest) still load. */
export function parseRule(a: unknown): Rule | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  if (typeof o.folder !== "string") return null;
  const last = o.lastRun && typeof o.lastRun === "object" ? (o.lastRun as Record<string, unknown>) : null;
  return {
    id: typeof o.id === "string" && o.id ? o.id : newRuleId(),
    name: (typeof o.name === "string" ? o.name.trim() : "").slice(0, 80) || "Untitled rule",
    folder: o.folder.trim().slice(0, 500),
    patterns: typeof o.patterns === "string" ? o.patterns.slice(0, 300) : "",
    olderThanDays: wholeDays(num(o.olderThanDays, 36500)),
    newerThanDays: typeof o.newerThanDays === "number" && Number.isFinite(o.newerThanDays) ? wholeDays(Math.min(o.newerThanDays, 36500)) : null,
    minSizeMb: num(o.minSizeMb, 1_000_000),
    recursive: o.recursive === true,
    action: o.action === "recycle" ? "recycle" : "move",
    dest: typeof o.dest === "string" ? o.dest.trim().slice(0, 500) : "",
    enabled: typeof o.enabled === "boolean" ? o.enabled : true,
    lastRun: last && typeof last.at === "number" && typeof last.count === "number" ? { at: last.at, count: wholeDays(last.count) } : null,
    schedule: parseSchedule(o.schedule),
  };
}

export function parseRules(raw: unknown): Rule[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Rule[] = [];
  for (const item of raw) {
    const r = parseRule(item);
    if (!r) continue;
    // A repeated id (a copied or damaged entry) gets a new one.
    out.push(seen.has(r.id) ? { ...r, id: newRuleId() } : r);
    seen.add(out[out.length - 1].id);
  }
  return out.slice(0, 200);
}

/** The shareable JSON for a list of rules. Ids and run history stay out, so an import never clashes with existing ones. */
export function rulesToJson(list: readonly Rule[]): string {
  return JSON.stringify(list.map(({ id: _id, lastRun: _last, ...rest }) => rest), null, 2);
}

/** Rules from pasted or loaded JSON (one rule or a list), with fresh ids. Throws a readable message. */
export function parseRulesText(text: string): Rule[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That is not valid JSON");
  }
  const list = parseRules((Array.isArray(raw) ? raw : [raw]).map((r) => (r && typeof r === "object" ? { ...(r as object), id: "", lastRun: null } : r)));
  if (list.length === 0) throw new Error("No usable rule in that (each needs a folder)");
  return list;
}

/** A name not already used (case-insensitive): "Old PDFs", then "Old PDFs 2"… */
export function uniqueRuleName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!used.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
}

/** "3 days ago" for a time in the past. */
export function sinceText(at: number, now: number): string {
  const d = Math.floor((now - at) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  return d < 60 ? `${d} days ago` : `${Math.floor(d / 30)} months ago`;
}
