// Pure helpers for the command palette: mode prefixes, the inline calculator and unit conversion,
// remembered command use, and path typing.

export type PaletteMode = "go" | "commands" | "search" | "tabs" | "pins" | "shell" | "settings" | "guide" | "help";

export const MODE_PREFIXES: readonly { prefix: string; mode: PaletteMode; label: string; hint: string }[] = [
  { prefix: ">", mode: "commands", label: "Commands", hint: "Run a command" },
  { prefix: "/", mode: "search", label: "Search", hint: "Search subfolders of this folder" },
  { prefix: "@", mode: "tabs", label: "Tabs", hint: "Jump to an open tab" },
  { prefix: "#", mode: "pins", label: "Pinned", hint: "Jump to a pinned folder" },
  { prefix: "!", mode: "shell", label: "Shell", hint: "Run a command in this folder" },
  { prefix: ",", mode: "settings", label: "Settings", hint: "Jump to a setting or tab" },
  { prefix: ";", mode: "guide", label: "Guide", hint: "Search the Octopolis guide" },
  { prefix: "?", mode: "help", label: "Help", hint: "Show these prefixes" },
];

export const MODE_LABELS: Record<PaletteMode, string> = {
  go: "Go to",
  commands: "Commands",
  search: "Search",
  tabs: "Tabs",
  pins: "Pinned",
  shell: "Shell",
  settings: "Settings",
  guide: "Guide",
  help: "Help",
};

/** Splits the typed text into the mode its first character selects and the rest. */
export function parseQuery(text: string): { mode: PaletteMode; query: string } {
  const hit = MODE_PREFIXES.find((m) => text.startsWith(m.prefix));
  if (hit) return { mode: hit.mode, query: text.slice(1) };
  return { mode: "go", query: text };
}

// ---------- calculator ----------

const FUNCTIONS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, ln: Math.log, log: Math.log10,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** Evaluates + - * / % ^ ( ) with decimals, pi, e and a few functions. Null when it is not a calculation. */
export function evalExpression(text: string): number | null {
  const src = text.replace(/,/g, ".").replace(/×/g, "*").replace(/÷/g, "/").trim();
  if (!src || !/[0-9]/.test(src) && !/\b(pi|e)\b/i.test(src)) return null;
  // Only a calculation looks like this: otherwise a folder named "2024" would turn into a number.
  if (!/[-+*/%^()]|\b(sqrt|abs|round|floor|ceil|sin|cos|tan|ln|log)\b/i.test(src)) return null;
  if (!/^[0-9a-z.+\-*/%^()\s]+$/i.test(src)) return null;
  let i = 0;
  const peek = () => src[i];
  const skip = () => { while (src[i] === " ") i++; };
  const fail = (): never => { throw new Error("syntax"); };
  function number(): number {
    skip();
    const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (m) { i += m[0].length; return parseFloat(m[0]); }
    const w = /^[a-z]+/i.exec(src.slice(i));
    if (!w) return fail();
    const name = w[0].toLowerCase();
    i += name.length;
    if (name in CONSTANTS) return CONSTANTS[name];
    const fn = FUNCTIONS[name];
    if (!fn) return fail();
    skip();
    if (peek() !== "(") return fail();
    return fn(primary());
  }
  function primary(): number {
    skip();
    if (peek() === "(") {
      i++;
      const v = sum();
      skip();
      if (peek() !== ")") return fail();
      i++;
      return v;
    }
    if (peek() === "-") { i++; return -primary(); }
    if (peek() === "+") { i++; return primary(); }
    return number();
  }
  function power(): number {
    const base = primary();
    skip();
    if (peek() === "^") { i++; return Math.pow(base, power()); }
    return base;
  }
  function product(): number {
    let v = power();
    for (;;) {
      skip();
      const op = peek();
      if (op === "*") { i++; v *= power(); }
      else if (op === "/") { i++; v /= power(); }
      else if (op === "%") { i++; v %= power(); }
      else return v;
    }
  }
  function sum(): number {
    let v = product();
    for (;;) {
      skip();
      const op = peek();
      if (op === "+") { i++; v += product(); }
      else if (op === "-") { i++; v -= product(); }
      else return v;
    }
  }
  try {
    const v = sum();
    skip();
    return i === src.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toLocaleString("en-US");
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-6)) return n.toExponential(6);
  return parseFloat(n.toPrecision(10)).toLocaleString("en-US", { maximumFractionDigits: 10 });
}

// ---------- unit conversion ----------

type Table = { readonly base: string; readonly units: Record<string, number> };
const TABLES: readonly Table[] = [
  // File sizes follow Windows: 1 KB is 1024 bytes.
  { base: "size", units: { b: 1, byte: 1, bytes: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3, tb: 1024 ** 4, tib: 1024 ** 4, pb: 1024 ** 5 } },
  { base: "length", units: { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, inch: 0.0254, inches: 0.0254, ft: 0.3048, foot: 0.3048, feet: 0.3048, yd: 0.9144, mi: 1609.344, mile: 1609.344, miles: 1609.344 } },
  { base: "mass", units: { mg: 0.001, g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237, lbs: 453.59237 } },
  { base: "time", units: { ms: 0.001, s: 1, sec: 1, min: 60, h: 3600, hr: 3600, d: 86400, day: 86400, days: 86400, w: 604800, week: 604800, weeks: 604800 } },
];

/** "5 mb in kb" → "5,120 KB". Null when the text is not a conversion between known units. */
export function convertUnits(text: string): string | null {
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*([a-z]+)\s+(?:in|to|as|into)\s+([a-z]+)\s*$/i.exec(text);
  if (!m) return null;
  const amount = parseFloat(m[1].replace(",", "."));
  const from = m[2].toLowerCase();
  const to = m[3].toLowerCase();
  // Temperatures are not a plain ratio.
  const temp = (u: string) => ({ c: "c", f: "f", k: "k", celsius: "c", fahrenheit: "f", kelvin: "k" } as Record<string, string>)[u];
  if (temp(from) && temp(to)) {
    const c = temp(from) === "c" ? amount : temp(from) === "f" ? (amount - 32) / 1.8 : amount - 273.15;
    const out = temp(to) === "c" ? c : temp(to) === "f" ? c * 1.8 + 32 : c + 273.15;
    return `${formatNumber(out)} °${temp(to)!.toUpperCase()}`;
  }
  for (const t of TABLES) {
    if (from in t.units && to in t.units) {
      return `${formatNumber((amount * t.units[from]) / t.units[to])} ${t.base === "size" ? to.toUpperCase() : to}`;
    }
  }
  return null;
}

/** What the calculator shows for the text, or null when it is neither a sum nor a conversion. */
export function calculate(text: string): { result: string; copy: string } | null {
  const conv = convertUnits(text);
  if (conv) return { result: conv, copy: conv };
  const v = evalExpression(text);
  if (v === null) return null;
  return { result: formatNumber(v), copy: String(parseFloat(v.toPrecision(12))) };
}

// ---------- remembered use ----------

export interface UseRecord {
  readonly n: number;
  readonly last: number;
}
export type UseDb = Readonly<Record<string, UseRecord>>;

const DAY = 86_400_000;
const MAX_USE_ENTRIES = 300;

export function recordUse(db: UseDb, id: string, now: number): UseDb {
  const next: Record<string, UseRecord> = { ...db, [id]: { n: (db[id]?.n ?? 0) + 1, last: now } };
  const keys = Object.keys(next);
  if (keys.length <= MAX_USE_ENTRIES) return next;
  keys.sort((a, b) => next[a].last - next[b].last);
  for (const k of keys.slice(0, keys.length - MAX_USE_ENTRIES)) delete next[k];
  return next;
}

/** How much a command's past use should lift it: more uses and recent use count for more. */
export function useBoost(rec: UseRecord | undefined, now: number): number {
  if (!rec) return 0;
  const age = now - rec.last;
  const recent = age < DAY ? 12 : age < 7 * DAY ? 6 : 2;
  return Math.min(rec.n, 20) * 1.2 + recent;
}

/** Ids of the most recently used, newest first. */
export function recentIds(db: UseDb, limit: number): string[] {
  return Object.entries(db).sort((a, b) => b[1].last - a[1].last).slice(0, limit).map(([id]) => id);
}

export function parseUseDb(raw: unknown): UseDb {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, UseRecord> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const r = v as Partial<UseRecord> | null;
    if (r && Number.isFinite(r.n) && Number.isFinite(r.last)) out[id] = { n: r.n!, last: r.last! };
  }
  return out;
}

// ---------- paths ----------

/** The folder to list and the part being typed, for completing "C:\Users\Jo". */
export function splitTyped(value: string): { parent: string; partial: string } {
  const v = value.replace(/\//g, "\\");
  const at = v.lastIndexOf("\\");
  if (at < 0) return { parent: "", partial: v };
  return { parent: at === 2 && /^[a-z]:/i.test(v) ? v.slice(0, 3) : v.slice(0, at), partial: v.slice(at + 1) };
}

/** Expands a leading ~ and %NAME% variables using what is known; unknown ones stay as typed. */
export function expandTyped(value: string, home: string | null, env: Readonly<Record<string, string>> = {}): string {
  let v = value.trim();
  if (home && (v === "~" || v.startsWith("~\\") || v.startsWith("~/"))) v = home + v.slice(1);
  return v.replace(/%([^%\\/]+)%/g, (all, name: string) => env[name.toUpperCase()] ?? all);
}

/** Splits a path into its folder part (shown dimmed) and its last name. */
export function splitLabel(path: string): { dir: string; name: string } {
  const trimmed = path.replace(/\\+$/, "");
  const at = trimmed.lastIndexOf("\\");
  if (at < 0) return { dir: "", name: path };
  return { dir: trimmed.slice(0, at + 1), name: trimmed.slice(at + 1) || path };
}

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : `${Math.round(d / 30)} mo ago`;
}

/** Wraps an index into 0..length-1. */
export const wrapIndex = (i: number, length: number) => (length <= 0 ? 0 : ((i % length) + length) % length);
