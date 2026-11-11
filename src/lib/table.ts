// CSV / TSV / JSON Lines parsing for the inspector's table preview.

export const MAX_TABLE_ROWS = 10_000;
const MAX_JSON_COLUMNS = 60;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export interface Table {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** More rows exist than were parsed. */
  readonly truncated: boolean;
}

/** Splits delimited text into rows, honouring quotes ("a, b", doubled "" inside quotes). */
export function parseDelimited(text: string, delim: string, maxRows = MAX_TABLE_ROWS + 1): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => {
    row.push(cell);
    cell = "";
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  for (; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else cell += c;
  }
  if (rows.length < maxRows && (cell !== "" || row.length > 0)) endRow();
  return rows;
}

/** Tab for .tsv/.tab; otherwise whichever of `,` `;` `|` or tab splits the first line most. */
export function delimiterFor(name: string, text: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "tsv" || ext === "tab") return "\t";
  const end = text.search(/\r|\n/);
  const first = end < 0 ? text : text.slice(0, end);
  let best = ",";
  let most = 0;
  for (const d of [",", ";", "|", "\t"]) {
    const n = first.split(d).length - 1;
    if (n > most) [best, most] = [d, n];
  }
  return best;
}

const cellText = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** One JSON value per line. Object keys become columns (first-seen order); other values go in a "value" column. */
export function parseJsonl(text: string): Table {
  const header: string[] = [];
  const known = new Set<string>();
  const records: Record<string, unknown>[] = [];
  let truncated = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (records.length >= MAX_TABLE_ROWS) {
      truncated = true;
      break;
    }
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      v = { "(not JSON)": line };
    }
    const obj = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
    for (const k of Object.keys(obj)) {
      if (!known.has(k) && header.length < MAX_JSON_COLUMNS) {
        known.add(k);
        header.push(k);
      }
    }
    records.push(obj);
  }
  return { header, rows: records.map((r) => header.map((k) => cellText(r[k]))), truncated };
}

/** Parses a table file by its name. The first delimited row is the header. */
export function toTable(name: string, text: string): Table {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "jsonl" || ext === "ndjson") return parseJsonl(text);
  const [head = [], ...rest] = parseDelimited(text, delimiterFor(name, text));
  const truncated = rest.length > MAX_TABLE_ROWS;
  const rows = truncated ? rest.slice(0, MAX_TABLE_ROWS) : rest;
  const width = rows.slice(0, 200).reduce((w, r) => Math.max(w, r.length), head.length);
  const header = Array.from({ length: width }, (_, i) => head[i] || `Column ${i + 1}`);
  return { header, rows, truncated };
}

const NUMBER = /^\s*-?(\d+([.,]\d+)?|\.\d+)(e[+-]?\d+)?\s*$/i;
const num = (s: string) => Number(s.replace(",", "."));

/** Rows sorted by a column: by value when both cells are numbers, otherwise natural text order. Empty cells go last. */
export function sortRows(rows: readonly (readonly string[])[], col: number, desc: boolean): (readonly string[])[] {
  const dir = desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = a[col] ?? "";
    const y = b[col] ?? "";
    if (!x || !y) return x === y ? 0 : x ? -1 : 1;
    if (NUMBER.test(x) && NUMBER.test(y)) return (num(x) - num(y)) * dir;
    return collator.compare(x, y) * dir;
  });
}
