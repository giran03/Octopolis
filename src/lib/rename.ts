// Batch rename: template rendering and a preview with conflict detection.

export type CaseMode = "keep" | "lower" | "upper" | "title";

export interface RenameSpec {
  /** e.g. "{name}{ext}", "IMG_{n:4}{ext}", "{exif:date} {exif:camera}{ext}". */
  readonly template: string;
  readonly find: string;
  readonly replace: string;
  readonly regex: boolean;
  readonly caseMode: CaseMode;
  readonly start: number;
}

export interface RenameItem {
  readonly name: string;
  readonly isDir: boolean;
  readonly modifiedMs: number;
  /** Metadata tags, e.g. "exif:date" or "id3:artist". */
  readonly tags: Readonly<Record<string, string>>;
}

export type RowStatus = "unchanged" | "ok" | "conflict" | "invalid";

export interface RenameRow {
  readonly oldName: string;
  readonly newName: string;
  readonly status: RowStatus;
  readonly reason?: string;
}

export const DEFAULT_SPEC: RenameSpec = { template: "{name}{ext}", find: "", replace: "", regex: false, caseMode: "keep", start: 1 };

export function splitExt(name: string, isDir: boolean): [stem: string, ext: string] {
  if (isDir) return [name, ""];
  const i = name.lastIndexOf(".");
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function formatDate(ms: number, pattern: string): string {
  const d = new Date(ms);
  return pattern
    .replace("YYYY", String(d.getFullYear()))
    .replace("MM", pad2(d.getMonth() + 1))
    .replace("DD", pad2(d.getDate()))
    .replace("HH", pad2(d.getHours()))
    .replace("mm", pad2(d.getMinutes()))
    .replace("ss", pad2(d.getSeconds()));
}

function applyCase(s: string, mode: CaseMode): string {
  switch (mode) {
    case "lower":
      return s.toLowerCase();
    case "upper":
      return s.toUpperCase();
    case "title":
      return s.toLowerCase().replace(/(^|[\s_.-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
    case "keep":
      return s;
  }
}

function replaceText(name: string, spec: RenameSpec): string {
  if (!spec.find) return name;
  if (spec.regex) return name.replace(new RegExp(spec.find, "g"), spec.replace);
  return name.split(spec.find).join(spec.replace);
}

/** Renders one new name. Throws on an invalid regular expression. */
export function renderName(spec: RenameSpec, item: RenameItem, index: number): string {
  const replaced = replaceText(item.name, spec);
  const [stem, ext] = splitExt(replaced, item.isDir);
  const number = spec.start + index;
  const out = spec.template.replace(/\{([^{}]+)\}/g, (whole, token: string) => {
    if (token === "name") return stem;
    if (token === "ext") return ext;
    if (token === "n") return String(number);
    if (token.startsWith("n:")) return String(number).padStart(Number(token.slice(2)) || 1, "0");
    if (token === "date") return formatDate(item.modifiedMs, "YYYY-MM-DD");
    if (token.startsWith("date:")) return formatDate(item.modifiedMs, token.slice(5));
    if (token.includes(":")) return item.tags[token] ?? "";
    return whole; // not a token: keep the literal text
  });
  return applyCase(out, spec.caseMode);
}

const FORBIDDEN = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function nameProblem(name: string): string | null {
  if (!name.trim()) return "Name is empty";
  if (FORBIDDEN.test(name)) return "Contains a character Windows does not allow";
  if (/[. ]$/.test(name)) return "Cannot end with a dot or a space";
  if (RESERVED.test(name.split(".")[0].trimEnd())) return "Reserved Windows name";
  return null;
}

/**
 * Builds the preview. `names` holds the proposed name per item (rendered or
 * edited by hand). `existing` holds every name currently in the folder.
 */
export function planRenames(items: readonly RenameItem[], names: readonly string[], existing: ReadonlySet<string>): RenameRow[] {
  const sources = new Set(items.map((i) => i.name.toLowerCase()));
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n.toLowerCase(), (counts.get(n.toLowerCase()) ?? 0) + 1);
  return items.map((item, i) => {
    const newName = names[i];
    const lower = newName.toLowerCase();
    if (newName === item.name) return { oldName: item.name, newName, status: "unchanged" };
    const problem = nameProblem(newName);
    if (problem) return { oldName: item.name, newName, status: "invalid", reason: problem };
    if ((counts.get(lower) ?? 0) > 1) return { oldName: item.name, newName, status: "conflict", reason: "Same name as another item" };
    if (existing.has(lower) && !sources.has(lower)) return { oldName: item.name, newName, status: "conflict", reason: "Already exists in this folder" };
    return { oldName: item.name, newName, status: "ok" };
  });
}

export function renderAll(spec: RenameSpec, items: readonly RenameItem[]): string[] {
  return items.map((item, i) => renderName(spec, item, i));
}
