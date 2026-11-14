// Custom theme tools: color maths, palette generation, readability checks and sharing.
import { BUILT_IN_THEMES, isColor, parseTheme, THEME_FAMILIES, type Theme, type ThemeToken } from "./themes";

/** The colors the app starts with (Midnight). A theme that leaves a token out falls back to these. */
export const MIDNIGHT_TOKENS: Readonly<Record<ThemeToken, string>> = {
  bg: "#101216", surface: "#161920", "surface-2": "#1c2029", "surface-3": "#242935", border: "#262b36", "border-strong": "#343a48",
  text: "#e3e6ed", "text-muted": "#8b93a5", "text-faint": "#5d6576", accent: "#6d8cff", danger: "#f06b6b", "g-folder": "#e7b955", ok: "#5ec98a",
  "tag-jpg": "#f59e0b", "tag-png": "#38bdf8", "tag-gif": "#c084fc", "tag-webp": "#34d399", "tag-svg": "#f472b6", "tag-avif": "#2dd4bf",
  "tag-mp4": "#fb7185", "tag-mov": "#fb923c", "tag-webm": "#a3e635", "tag-mkv": "#818cf8", "tag-other": "#94a3b8",
};

export const TOKEN_INFO: readonly { group: string; items: readonly { token: ThemeToken; label: string; hint: string }[] }[] = [
  { group: "Surfaces", items: [
    { token: "bg", label: "Background", hint: "Behind everything" },
    { token: "surface", label: "Panels", hint: "Sidebar, tabs, toolbar" },
    { token: "surface-2", label: "Raised", hint: "Hover and menus" },
    { token: "surface-3", label: "Highest", hint: "Pressed and selected" },
  ] },
  { group: "Lines", items: [
    { token: "border", label: "Border", hint: "Dividers" },
    { token: "border-strong", label: "Strong border", hint: "Inputs and focus rings" },
  ] },
  { group: "Text", items: [
    { token: "text", label: "Text", hint: "Names and titles" },
    { token: "text-muted", label: "Muted text", hint: "Details and hints" },
    { token: "text-faint", label: "Faint text", hint: "Placeholders and disabled" },
  ] },
  { group: "Colors", items: [
    { token: "accent", label: "Accent", hint: "Selection and highlights" },
    { token: "danger", label: "Danger", hint: "Delete and errors" },
    { token: "g-folder", label: "Folders", hint: "Folder icons" },
    { token: "ok", label: "Success", hint: "Done and ticked states" },
  ] },
  { group: "Media tags", items: [
    { token: "tag-jpg", label: "JPG / JPEG", hint: "JPEG photos in Bento" },
    { token: "tag-png", label: "PNG", hint: "PNG images in Bento" },
    { token: "tag-gif", label: "GIF", hint: "Animated GIFs in Bento" },
    { token: "tag-webp", label: "WEBP", hint: "WebP images in Bento" },
    { token: "tag-svg", label: "SVG", hint: "Vector graphics in Bento" },
    { token: "tag-avif", label: "AVIF / HEIC", hint: "Modern image formats in Bento" },
    { token: "tag-mp4", label: "MP4 / M4V", hint: "MP4 videos in Bento" },
    { token: "tag-mov", label: "MOV", hint: "QuickTime videos in Bento" },
    { token: "tag-webm", label: "WEBM", hint: "WebM videos in Bento" },
    { token: "tag-mkv", label: "MKV / AVI", hint: "Container videos in Bento" },
    { token: "tag-other", label: "Other media", hint: "Fallback for other formats" },
  ] },
];

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Reads any color the importer accepts (hex, rgb, hsl). Null when it isn't one. */
export function parseColor(value: string): Rgba | null {
  const v = value.trim().toLowerCase();
  if (!isColor(v)) return null;
  if (v.startsWith("#")) {
    let h = v.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const parts = v.slice(v.indexOf("(") + 1, v.lastIndexOf(")")).split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const num = (s: string, scale: number) => (s.endsWith("%") ? (parseFloat(s) / 100) * scale : parseFloat(s));
  const alpha = parts[3] === undefined ? 1 : clamp(num(parts[3], 1), 0, 1);
  if (v.startsWith("rgb")) return { r: clamp(num(parts[0], 255), 0, 255), g: clamp(num(parts[1], 255), 0, 255), b: clamp(num(parts[2], 255), 0, 255), a: alpha };
  const [r, g, b] = hslToRgb(((parseFloat(parts[0]) % 360) + 360) % 360, clamp(parseFloat(parts[1]) / 100, 0, 1), clamp(parseFloat(parts[2]) / 100, 0, 1));
  return { r, g, b, a: alpha };
}

const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");

/** `#rrggbb` for a color (drops any transparency); the fallback when it can't be read. */
export function toHex(value: string, fallback = "#000000"): string {
  const c = parseColor(value);
  return c ? `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}` : fallback;
}

/** Blends `a` toward `b` by `t` (0 = a, 1 = b), as `#rrggbb`. */
export function mixColors(a: string, b: string, t: number): string {
  const x = parseColor(a) ?? { r: 0, g: 0, b: 0, a: 1 };
  const y = parseColor(b) ?? x;
  return `#${hex2(x.r + (y.r - x.r) * t)}${hex2(x.g + (y.g - x.g) * t)}${hex2(x.b + (y.b - x.b) * t)}`;
}

function luminance(value: string): number {
  const c = parseColor(value) ?? { r: 0, g: 0, b: 0, a: 1 };
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast ratio between two colors, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

export function isDarkColor(value: string): boolean {
  return luminance(value) < 0.18;
}

/** Every token filled in: the theme's own, then Midnight's for anything it leaves out. */
export function fullTokens(theme: Pick<Theme, "tokens">): Record<ThemeToken, string> {
  return { ...MIDNIGHT_TOKENS, ...theme.tokens };
}

/** A complete palette from three colors: surfaces, borders and text shades are blended from them. */
export function derivePalette(bg: string, text: string, accent: string): Record<ThemeToken, string> {
  const dark = isDarkColor(bg);
  return {
    bg: toHex(bg),
    surface: dark ? mixColors(bg, text, 0.04) : mixColors(bg, "#ffffff", 0.75),
    "surface-2": mixColors(bg, text, dark ? 0.08 : 0.035),
    "surface-3": mixColors(bg, text, dark ? 0.15 : 0.09),
    border: mixColors(bg, text, dark ? 0.12 : 0.1),
    "border-strong": mixColors(bg, text, dark ? 0.22 : 0.2),
    text: toHex(text),
    "text-muted": mixColors(text, bg, 0.4),
    "text-faint": mixColors(text, bg, 0.62),
    accent: toHex(accent),
    danger: dark ? "#f06b6b" : "#d64545",
    "g-folder": dark ? "#e7b955" : "#d9a128",
    ok: dark ? "#5ec98a" : "#2f9e5f",
    "tag-jpg": dark ? "#f59e0b" : "#c97208",
    "tag-png": dark ? "#38bdf8" : "#1d72b8",
    "tag-gif": dark ? "#c084fc" : "#8a42c4",
    "tag-webp": dark ? "#34d399" : "#158a5c",
    "tag-svg": dark ? "#f472b6" : "#c4357a",
    "tag-avif": dark ? "#2dd4bf" : "#0f857a",
    "tag-mp4": dark ? "#fb7185" : "#c93b4b",
    "tag-mov": dark ? "#fb923c" : "#cf5e17",
    "tag-webm": dark ? "#a3e635" : "#5c8f12",
    "tag-mkv": dark ? "#818cf8" : "#4b56c4",
    "tag-other": dark ? "#94a3b8" : "#5c6675",
  };
}

/** A pleasant random palette: one hue family for the surfaces and a contrasting accent. */
export function randomPalette(dark: boolean, rand: () => number = Math.random): { scheme: "dark" | "light"; tokens: Record<ThemeToken, string> } {
  const hue = Math.floor(rand() * 360);
  const hsl = (h: number, s: number, l: number) => {
    const [r, g, b] = hslToRgb(((h % 360) + 360) % 360, s / 100, l / 100);
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  };
  const bg = dark ? hsl(hue, 18 + rand() * 14, 7 + rand() * 5) : hsl(hue, 20 + rand() * 25, 95 + rand() * 2);
  const text = dark ? hsl(hue, 14, 90) : hsl(hue, 22, 13);
  const accent = hsl(hue + 150 + rand() * 60, 65 + rand() * 15, dark ? 66 : 45);
  return { scheme: dark ? "dark" : "light", tokens: derivePalette(bg, text, accent) };
}

/** Plain-language warnings for colors that are hard to read. Empty when everything is comfortable. */
export function themeWarnings(tokens: Readonly<Record<ThemeToken, string>>): string[] {
  const out: string[] = [];
  const check = (fg: ThemeToken, bgToken: ThemeToken, min: number, what: string) => {
    const r = contrastRatio(tokens[fg], tokens[bgToken]);
    if (r < min) out.push(`${what} is hard to read (${r.toFixed(1)}:1, aim for ${min}:1)`);
  };
  check("text", "bg", 4.5, "Text on the background");
  check("text", "surface", 4.5, "Text on panels");
  check("text-muted", "surface", 3, "Muted text on panels");
  check("accent", "bg", 3, "The accent on the background");
  check("danger", "bg", 3, "Danger on the background");
  return out;
}

/** A name not already taken (case-insensitive): "Dusk", then "Dusk 2", "Dusk 3"… */
export function uniqueThemeName(name: string, taken: readonly string[]): string {
  const base = name.trim().slice(0, 40) || "Custom";
  const used = new Set(taken.map((t) => t.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base.slice(0, 36)} ${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** The shareable JSON for a theme: every token, so it looks the same wherever it is imported. */
export function themeToJson(theme: Theme): string {
  return JSON.stringify({ name: theme.name, scheme: theme.scheme, tokens: fullTokens(theme) }, null, 2);
}

/** Themes read from storage or an import: valid ones only, unique names, none named like a built-in. */
export function sanitizeThemes(raw: unknown): Theme[] {
  if (!Array.isArray(raw)) return [];
  const taken: string[] = BUILT_IN_THEMES.map((t) => t.name);
  const out: Theme[] = [];
  for (const item of raw) {
    try {
      const t = parseTheme(JSON.stringify(item));
      const name = uniqueThemeName(t.name, taken);
      taken.push(name);
      out.push({ ...t, name });
    } catch {
      // A damaged entry is dropped; the rest still load.
    }
  }
  return out.slice(0, 50);
}

/** One theme, or a list of them, from pasted or loaded JSON. Throws a readable message when none is usable. */
export function parseThemes(text: string): Theme[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That is not valid JSON");
  }
  if (!Array.isArray(raw)) return [parseTheme(text)];
  const list = sanitizeThemes(raw);
  if (list.length === 0) throw new Error("No usable theme in that list");
  return list;
}

/** A round preview for a theme: its background on one half, its accent on the other. */
export function themeSwatch(theme: Pick<Theme, "tokens">): string {
  const t = fullTokens(theme);
  return `linear-gradient(135deg, ${t.bg} 0 50%, ${t.accent} 50% 100%)`;
}

/** The preview for "Follow Windows": a dark half and a light half. */
export const SYSTEM_SWATCH = `linear-gradient(135deg, ${MIDNIGHT_TOKENS.bg} 0 50%, #f6f7f9 50% 100%)`;

export interface ThemeChoice {
  readonly value: string;
  readonly label: string;
  readonly swatch: string;
  readonly group?: string;
}

/** Dropdown entries for the built-in themes (by family) and the user's own, each with a color preview. */
export function themeChoices(custom: readonly Theme[], opts: { system?: boolean; scheme?: "dark" | "light" } = {}): ThemeChoice[] {
  const keep = (t: Theme) => !opts.scheme || t.scheme === opts.scheme;
  const title = (t: Theme) => THEME_FAMILIES.find((f) => f.id === t.family)?.title;
  const out: ThemeChoice[] = [];
  if (opts.system) out.push({ value: "System", label: "Follow Windows", swatch: SYSTEM_SWATCH });
  const built = [...BUILT_IN_THEMES].sort((a, b) => THEME_FAMILIES.findIndex((f) => f.id === a.family) - THEME_FAMILIES.findIndex((f) => f.id === b.family));
  for (const t of built.filter(keep)) out.push({ value: t.name, label: t.name, swatch: themeSwatch(t), group: title(t) });
  for (const t of custom.filter(keep)) out.push({ value: t.name, label: t.name, swatch: themeSwatch(t), group: "Your themes" });
  return out;
}

/** The theme's colors as inline CSS variables, to draw a preview that carries its own palette. */
export function themeVars(theme: Pick<Theme, "tokens">): Record<string, string> {
  const t = fullTokens(theme);
  const vars: Record<string, string> = { "--accent-soft": `color-mix(in srgb, ${t.accent} 18%, transparent)`, "--accent-strong": `color-mix(in srgb, ${t.accent} 30%, transparent)` };
  for (const [k, v] of Object.entries(t)) vars[`--${k}`] = v;
  return vars;
}
