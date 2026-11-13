// Folder rules: the model, its checks, and reading/writing the shareable JSON. Pure; the dialog and the store use it.
import { baseName } from "./paths";

export type RuleAction = "move" | "recycle";

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

export const NEW_RULE: Omit<Rule, "id"> = { name: "", folder: "", patterns: "", olderThanDays: 30, newerThanDays: null, minSizeMb: 0, recursive: false, action: "move", dest: "", enabled: true, lastRun: null };

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
