// User-defined commands run on the selection, with placeholders for paths.
export type ActionMode = "hidden" | "console";
export type ActionShell = "cmd" | "powershell";
export type ActionTarget = "any" | "files" | "folders";

export interface CustomAction {
  /** Stable identity, so a shortcut or rename never loses track of the action. */
  readonly id: string;
  readonly name: string;
  /**
   * Command line. Placeholders: {path} {paths} {dir} {parent} {name} {stem} {ext} {pslist} {list}
   * {pickfolder} and {prompt:Label}.
   */
  readonly command: string;
  /** Lower-case extensions it applies to (empty: every file and folder). */
  readonly extensions: readonly string[];
  readonly mode: ActionMode;
  /** Switched off, an action stays in the list but is hidden from menus and shortcuts. */
  readonly enabled: boolean;
  readonly shell: ActionShell;
  readonly target: ActionTarget;
  /** Fewest items it needs (0: none needed). */
  readonly minItems: number;
  /** Most items it accepts (0: no limit). */
  readonly maxItems: number;
  /** Wildcard patterns for names, separated by ; or , (empty: any name). */
  readonly namePattern: string;
  /** Folder to run in; empty runs in the folder being viewed. */
  readonly workDir: string;
  readonly elevate: boolean;
  /** Show the finished command and ask before running it. */
  readonly confirm: boolean;
  /** Reload the folder when the action finishes. */
  readonly refresh: boolean;
  /** Run once for each selected item instead of once for all of them. */
  readonly each: boolean;
}

export const NEW_ACTION: CustomAction = {
  id: "",
  name: "",
  command: "",
  extensions: [],
  mode: "hidden",
  enabled: true,
  shell: "cmd",
  target: "any",
  minItems: 0,
  maxItems: 0,
  namePattern: "",
  workDir: "",
  elevate: false,
  confirm: false,
  refresh: true,
  each: false,
};

export interface Item {
  readonly name: string;
  readonly isDir: boolean;
}

export function newActionId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);
}

/** Wraps a path for the command line. A trailing backslash would swallow the closing quote, so it gets a dot. */
function quotePath(p: string, shell: ActionShell): string {
  if (shell === "powershell") return `'${p.replace(/'/g, "''")}'`;
  return `"${p.endsWith("\\") ? `${p}.` : p}"`;
}

const baseName = (p: string) => p.slice(p.lastIndexOf("\\") + 1);
const parentOf = (p: string) => {
  const i = p.lastIndexOf("\\");
  return i > 2 ? p.slice(0, i) : i === 2 ? p.slice(0, 3) : p;
};
const stemOf = (name: string) => (name.lastIndexOf(".") > 0 ? name.slice(0, name.lastIndexOf(".")) : name);
const extOf = (name: string) => (name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".") + 1) : "");

const PROMPT = /\{prompt:([^{}\r\n]{1,40})\}/g;

/** What a command needs asked or made before it can run. */
export function placeholderNeeds(template: string): { prompts: string[]; pickFolder: boolean; list: boolean } {
  const prompts = [...new Set([...template.matchAll(PROMPT)].map((m) => m[1].trim()))];
  return { prompts, pickFolder: template.includes("{pickfolder}"), list: template.includes("{list}") };
}

export interface ExpandOptions {
  readonly shell?: ActionShell;
  /** Answers to {prompt:Label}, by label. */
  readonly prompts?: Readonly<Record<string, string>>;
  /** The folder chosen for {pickfolder}. */
  readonly folder?: string;
  /** The temp file holding every selected path, for {list}. */
  readonly list?: string;
}

/**
 * Fills the placeholders. Paths are quoted ({path} is the first item, {paths} all of them, {pslist} a
 * comma-separated PowerShell list); {name}, {stem}, {ext} and prompt answers are left bare so they can sit
 * inside quotes (PowerShell single quotes are doubled for them).
 */
export function expandCommand(template: string, paths: readonly string[], dir: string, opts: ExpandOptions = {}): string {
  const shell = opts.shell ?? "cmd";
  const q = (p: string) => quotePath(p, shell);
  const bare = (s: string) => (shell === "powershell" ? s.replace(/'/g, "''") : s);
  const first = paths[0] ?? dir;
  const name = baseName(first);
  const values: Record<string, string> = {
    path: q(first),
    paths: paths.length ? paths.map(q).join(" ") : q(dir),
    pslist: (paths.length ? paths : [dir]).map((p) => quotePath(p, "powershell")).join(","),
    dir: q(dir),
    parent: q(parentOf(first)),
    name: bare(name),
    stem: bare(stemOf(name)),
    ext: bare(extOf(name)),
    list: q(opts.list ?? ""),
    pickfolder: q(opts.folder ?? ""),
  };
  return template
    .replace(PROMPT, (_, label: string) => bare((opts.prompts?.[label.trim()] ?? "").replace(/[\r\n]+/g, " ")))
    .replace(/\{(path|paths|pslist|dir|parent|name|stem|ext|list|pickfolder)\}/g, (_, k: string) => values[k]);
}

/** "*.log; report?.txt" → a matcher for one name (case-insensitive). */
export function wildcardMatcher(patterns: string): (name: string) => boolean {
  const list = patterns.split(/[;,]/).map((p) => p.trim()).filter(Boolean);
  if (list.length === 0) return () => true;
  const regs = list.map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i"));
  return (name) => regs.some((r) => r.test(name));
}

/** Whether an action fits the selected items. */
export function actionApplies(a: CustomAction, items: readonly Item[]): boolean {
  if (!a.enabled) return false;
  const n = items.length;
  if (n < a.minItems || (a.maxItems > 0 && n > a.maxItems)) return false;
  if (n === 0) return a.extensions.length === 0 && a.target !== "files" && !a.namePattern.trim();
  if (a.target === "files" && items.some((i) => i.isDir)) return false;
  if (a.target === "folders" && items.some((i) => !i.isDir)) return false;
  if (a.extensions.length > 0 && !items.every((i) => !i.isDir && a.extensions.includes(extOf(i.name).toLowerCase()))) return false;
  const match = wildcardMatcher(a.namePattern);
  return items.every((i) => match(i.name));
}

/** "mp4, .MOV;mkv" → ["mp4", "mov", "mkv"]. */
export function parseExtensions(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((e) => e.trim().replace(/^\./, "").toLowerCase()).filter(Boolean))];
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(100000, Math.max(0, Math.floor(v))) : 0);

/** One action from stored or imported data; older saves (name, command, extensions, mode only) still load. */
export function parseAction(a: unknown): CustomAction | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  if (typeof o.name !== "string" || !o.name.trim() || typeof o.command !== "string" || !o.command.trim()) return null;
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    id: typeof o.id === "string" && o.id ? o.id : newActionId(),
    name: o.name.trim().slice(0, 80),
    command: o.command.slice(0, 4000),
    extensions: Array.isArray(o.extensions) ? parseExtensions(o.extensions.filter((e): e is string => typeof e === "string").join(" ")) : [],
    mode: o.mode === "console" ? "console" : "hidden",
    enabled: bool(o.enabled, true),
    shell: o.shell === "powershell" ? "powershell" : "cmd",
    target: o.target === "files" || o.target === "folders" ? o.target : "any",
    minItems: count(o.minItems),
    maxItems: count(o.maxItems),
    namePattern: typeof o.namePattern === "string" ? o.namePattern.slice(0, 200) : "",
    workDir: typeof o.workDir === "string" ? o.workDir.trim().slice(0, 500) : "",
    elevate: bool(o.elevate, false),
    confirm: bool(o.confirm, false),
    refresh: bool(o.refresh, true),
    each: bool(o.each, false),
  };
}

export function parseActions(raw: unknown): CustomAction[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CustomAction[] = [];
  for (const item of raw) {
    const a = parseAction(item);
    if (!a) continue;
    // A repeated id (a copied or damaged entry) gets a new one.
    out.push(seen.has(a.id) ? { ...a, id: newActionId() } : a);
    seen.add(out[out.length - 1].id);
  }
  return out.slice(0, 200);
}

/** The shareable JSON for a list of actions. Ids stay out, so an import never clashes with existing ones. */
export function actionsToJson(list: readonly CustomAction[]): string {
  return JSON.stringify(list.map(({ id: _id, ...rest }) => rest), null, 2);
}

/** Actions from pasted or loaded JSON (one action or a list), with fresh ids. Throws a readable message. */
export function parseActionsText(text: string): CustomAction[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That is not valid JSON");
  }
  const list = parseActions((Array.isArray(raw) ? raw : [raw]).map((a) => (a && typeof a === "object" ? { ...(a as object), id: "" } : a)));
  if (list.length === 0) throw new Error("No usable action in that (each needs a name and a command)");
  return list;
}

/** A name not already used (case-insensitive): "Zip", then "Zip 2"… */
export function uniqueActionName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!used.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
}

const CMD_BUILTINS = new Set(["start", "echo", "dir", "copy", "move", "del", "erase", "type", "cd", "chdir", "md", "mkdir", "rd", "rmdir", "ren", "rename", "set", "if", "for", "call", "cls", "title", "pushd", "popd", "ver", "vol", "mklink", "assoc", "ftype", "path", "pause", "rem", "color", "date", "time", "exit", "goto", "setlocal", "endlocal", "(", "@echo"]);

/** The program a command starts with, when it is worth checking that it exists (not a shell built-in or cmdlet). */
export function leadingProgram(command: string, shell: ActionShell): string | null {
  const t = command.trim();
  if (!t || shell === "powershell") return null;
  const m = t.match(/^"([^"]+)"|^(\S+)/);
  const prog = (m?.[1] ?? m?.[2] ?? "").trim();
  if (!prog || prog.startsWith("%") || prog.includes("{")) return null;
  return CMD_BUILTINS.has(prog.toLowerCase()) ? null : prog;
}

/** True when a path or filename points to a Windows batch script (.bat or .cmd). */
export function isBatchPath(pathOrName: string): boolean {
  return /\.(bat|cmd)$/i.test(pathOrName.trim());
}

/** Builds a runnable CustomAction from a .bat/.cmd file path. */
export function batchActionFromPath(filePath: string): Omit<CustomAction, "id"> {
  const normalized = filePath.trim().replace(/\//g, "\\");
  const name = stemOf(baseName(normalized)) || "Batch script";
  const dir = normalized.includes("\\") ? parentOf(normalized) : "";
  return {
    ...NEW_ACTION,
    name: name.slice(0, 80),
    command: `call ${quotePath(normalized, "cmd")}`,
    shell: "cmd",
    mode: "console",
    workDir: dir,
    refresh: true,
    enabled: true,
  };
}

/** Builds a runnable CustomAction from an externally dropped .bat/.cmd file's name and text content. */
export function batchActionFromText(fileName: string, content: string): Omit<CustomAction, "id"> {
  const name = stemOf(baseName(fileName.trim().replace(/\//g, "\\"))) || "Batch script";
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^@?echo\s+(off|on)$/i.test(l) && !/^rem(?:\s|$)/i.test(l) && !l.startsWith("::"));
  const command = lines.join(" & ").slice(0, 4000);
  return {
    ...NEW_ACTION,
    name: name.slice(0, 80),
    command: command || "echo (empty batch file)",
    shell: "cmd",
    mode: "console",
    refresh: true,
    enabled: true,
  };
}
