// Builds the offline guide: guide/ (shell, css, js, content fragments) + data read from the app's own sources
// (commands, themes, palette modes, changelog) -> one self-contained public/octopolis-guide.html.
// Run with: node scripts/build-guide.mjs   (the dev, build and check scripts run it first)
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");

/** The text of the bracketed literal that follows `marker` in `src` (strings and comments are skipped). */
export function extractLiteral(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`guide: "${marker}" not found`);
  let i = src.indexOf("=", at + marker.length - 1);
  while (/\s/.test(src[i + 1])) i++;
  i++;
  const open = src[i];
  const close = { "[": "]", "{": "}", "(": ")" }[open];
  if (!close) throw new Error(`guide: no literal after "${marker}"`);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === "`") {
      for (j++; j < src.length && src[j] !== c; j++) if (src[j] === "\\") j++;
    } else if (c === "/" && src[j + 1] === "/") {
      while (j < src.length && src[j] !== "\n") j++;
    } else if (c === "/" && src[j + 1] === "*") {
      j = src.indexOf("*/", j + 2) + 1;
    } else if (c === open) depth++;
    else if (c === close && --depth === 0) return src.slice(i, j + 1);
  }
  throw new Error(`guide: unterminated literal after "${marker}"`);
}

/** Splits an array literal's text into its top-level `{ ... }` object texts. */
function topObjects(arrayText) {
  const out = [];
  let depth = 0, start = -1;
  for (let j = 1; j < arrayText.length - 1; j++) {
    const c = arrayText[j];
    if (c === '"' || c === "'" || c === "`") {
      for (j++; j < arrayText.length && arrayText[j] !== c; j++) if (arrayText[j] === "\\") j++;
    } else if (c === "/" && arrayText[j + 1] === "/") {
      while (j < arrayText.length && arrayText[j] !== "\n") j++;
    } else if (c === "{" || c === "(" || c === "[") {
      if (c === "{" && depth === 0) start = j;
      depth++;
    } else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (c === "}" && depth === 0) out.push(arrayText.slice(start, j + 1));
    }
  }
  return out;
}

const strings = (list) => [...list.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));

/** Every command of src/commands.ts: id, title, category and default (and Vim) keys. */
export function parseCommands(src) {
  return topObjects(extractLiteral(src, "export const COMMANDS: readonly Command[] =")).map((o) => {
    const id = /\bid:\s*"([^"]+)"/.exec(o)?.[1];
    const title = /\btitle:\s*"((?:[^"\\]|\\.)*)"/.exec(o)?.[1]?.replace(/\\(.)/g, "$1");
    const category = /\bcategory:\s*"([^"]+)"/.exec(o)?.[1];
    if (!id || !title || !category) throw new Error(`guide: cannot read a command: ${o.slice(0, 80)}`);
    const keys = /(?<![A-Za-z])keys:\s*\[([^\]]*)\]/.exec(o)?.[1];
    const vim = /\bvimKeys:\s*\[([^\]]*)\]/.exec(o)?.[1];
    return { id, title, category, keys: keys ? strings(keys) : [], vimKeys: vim ? strings(vim) : [], hidden: /\bhidden:\s*true/.test(o) };
  });
}

const evalLiteral = (text) => new Function(`return (${text});`)();

/** The built-in themes with every token filled in (a theme that leaves one out wears Midnight's), and their families. */
export function parseThemes(themesSrc, toolsSrc) {
  const midnight = evalLiteral(extractLiteral(toolsSrc, "export const MIDNIGHT_TOKENS:"));
  const themes = evalLiteral(extractLiteral(themesSrc, "export const BUILT_IN_THEMES:")).map((t) => ({
    name: t.name, scheme: t.scheme, family: t.family, tokens: { ...midnight, ...t.tokens },
  }));
  const families = evalLiteral(extractLiteral(themesSrc, "export const THEME_FAMILIES:"));
  return { themes, families };
}

export const parseModes = (src) => evalLiteral(extractLiteral(src, "export const MODE_PREFIXES:")).map(({ prefix, label, hint }) => ({ prefix, label, hint }));

export function constant(src, name) {
  const m = new RegExp(`export const ${name}\\s*=\\s*([\\d_]+)`).exec(src);
  if (!m) throw new Error(`guide: constant ${name} not found`);
  return Number(m[1].replace(/_/g, ""));
}

const plain = (s) => s.replace(/`/g, "").replace(/\*\*/g, "").trim();

/** CHANGELOG.md -> [{ version, date, sections: [{ type, entries: [{ title, body }] }] }]. */
export function parseChangelog(md) {
  const releases = [];
  let rel = null, sec = null, last = null;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^##\s+\[([^\]]+)\](?:\s*-\s*(.+))?$/.exec(line))) {
      rel = { version: m[1], date: m[2] || "", sections: [] };
      releases.push(rel);
      sec = last = null;
    } else if ((m = /^###\s+(.+)$/.exec(line)) && rel) {
      sec = { type: m[1].trim(), entries: [] };
      rel.sections.push(sec);
      last = null;
    } else if ((m = /^-\s+(.+)$/.exec(line)) && sec) {
      last = { text: m[1] };
      sec.entries.push(last);
    } else if (last && /^\s+\S/.test(line)) last.text += " " + line.trim();
  }
  for (const r of releases) {
    for (const s of r.sections) {
      s.entries = s.entries.map(({ text }) => {
        const clean = plain(text);
        const cut = /^(.+?[.!?])(\s+(?=[A-Z(`])|$)/.exec(clean);
        const title = cut ? cut[1].replace(/\.$/, "") : clean.replace(/\.$/, "");
        const body = cut ? clean.slice(cut[0].length).trim() : "";
        return { title, body };
      });
    }
    r.sections = r.sections.filter((s) => s.entries.length);
  }
  return releases.filter((r) => r.sections.length);
}

const read = (p) => readFileSync(join(ROOT, p), "utf8");
const BS = String.fromCharCode(92);
const UNSAFE = new RegExp("[<" + String.fromCharCode(0x2028, 0x2029) + "]", "g");
/** JSON for a <script type="application/json"> block: < and the line separators are written as escapes. */
const escJson = (v) => JSON.stringify(v).replace(UNSAFE, (c) => BS + "u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

/** Fragments in guide/content, in file-name order, with their nav entries. */
export function readContent(dir = join(ROOT, "guide", "content")) {
  return readdirSync(dir).filter((f) => f.endsWith(".html")).sort().map((f) => {
    const html = readFileSync(join(dir, f), "utf8");
    const m = /<section\s+id="([^"]+)"[^>]*data-title="([^"]*)"[^>]*data-group="([^"]*)"[^>]*>/.exec(html);
    if (!m) throw new Error(`guide: ${f} must start with <section id=… data-title=… data-group=…>`);
    return { file: f, html, id: m[1], title: m[2], group: m[3] };
  });
}

export function buildNav(sections) {
  const groups = [];
  for (const s of sections) {
    let g = groups.find((x) => x.name === s.group);
    if (!g) groups.push((g = { name: s.group, items: [] }));
    g.items.push(s);
  }
  return groups.map((g) => `<h6>${g.name}</h6>` + g.items.map((s) => `<a href="#${s.id}">${s.title}</a>`).join("")).join("");
}

export function build() {
  const commandsSrc = read("src/commands.ts");
  const data = {
    version: JSON.parse(read("package.json")).version,
    commands: parseCommands(commandsSrc),
    ...parseThemes(read("src/lib/themes.ts"), read("src/lib/themeTools.ts")),
    modes: parseModes(read("src/lib/paletteLogic.ts")),
    changelog: parseChangelog(read("CHANGELOG.md")),
  };
  const autoSrc = read("src/lib/autoView.ts");
  const vars = {
    version: data.version,
    commands: String(data.commands.length),
    themes: String(data.themes.length),
    bento_limit: constant(autoSrc, "BENTO_LIMIT").toLocaleString("en-US"),
    huge_folder: constant(autoSrc, "HUGE_FOLDER").toLocaleString("en-US"),
  };
  const fill = (s) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`guide: unknown placeholder {{${k}}}`);
    return vars[k];
  });
  const modeRows = data.modes.map((m) => `<tr><td class="k"><code>${m.prefix}</code></td><td><b>${m.label}</b></td><td>${m.hint}</td></tr>`).join("");
  const sections = readContent();
  const content = sections.map((s) => fill(s.html).replace("<!--@modes-->", modeRows)).join("\n");

  const g = (f) => readFileSync(join(ROOT, "guide", f), "utf8");
  const script = g("guide.js");
  if (script.includes("</script")) throw new Error("guide: guide.js must not contain </script");
  const html = fill(g("guide.html"))
    .replace("<!--@ICONS-->", () => g("icons.svg"))
    .replace("<!--@NAV-->", () => buildNav(sections))
    .replace("<!--@CONTENT-->", () => content)
    .replace("/*@STYLE*/", () => g("guide.css"))
    .replace("/*@DATA*/", () => escJson(data))
    .replace("/*@SCRIPT*/", () => script);
  return { html, data, sections };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { html, sections } = build();
  const out = join(ROOT, "public", "octopolis-guide.html");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`guide: ${sections.length} sections, ${(html.length / 1024).toFixed(0)} KB -> public/octopolis-guide.html`);
}
