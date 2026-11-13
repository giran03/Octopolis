// Theme engine: named token sets, plus safe import of custom themes.

export const THEME_TOKENS = [
  "bg", "surface", "surface-2", "surface-3", "border", "border-strong", "text", "text-muted", "text-faint", "accent", "danger", "g-folder", "ok",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

export interface Theme {
  readonly name: string;
  readonly scheme: "dark" | "light";
  /** Set on the built-in themes, which are grouped by it; your own themes have none. */
  readonly family?: ThemeFamily;
  readonly tokens: Readonly<Partial<Record<ThemeToken, string>>>;
}

export type ThemeFamily = "light" | "dark" | "contrast" | "minimal" | "vibrant" | "pastel";

/** The families the built-in themes are grouped by, in display order. */
export const THEME_FAMILIES: readonly { id: ThemeFamily; title: string; hint: string }[] = [
  { id: "light", title: "Light", hint: "Bright backgrounds, dark text" },
  { id: "dark", title: "Dark", hint: "Low-luminance surfaces, easy on the eyes" },
  { id: "contrast", title: "High contrast", hint: "Maximum separation for accessibility" },
  { id: "minimal", title: "Minimal", hint: "Shades of a single hue" },
  { id: "vibrant", title: "Vibrant", hint: "Saturated, energetic accents" },
  { id: "pastel", title: "Pastel", hint: "Soft, calm, low saturation" },
];

export const BUILT_IN_THEMES: readonly Theme[] = [
  { name: "Midnight", scheme: "dark", family: "dark", tokens: {} },
  { name: "Graphite", scheme: "dark", family: "dark", tokens: { bg: "#151515", surface: "#1d1d1d", "surface-2": "#262626", "surface-3": "#343434", border: "#2e2e2e", "border-strong": "#434343", text: "#e6e6e6", "text-muted": "#929292", "text-faint": "#646464", accent: "#8ab4f8", danger: "#f06b6b", "g-folder": "#e7b955", ok: "#6fcf97" } },
  { name: "OLED Black", scheme: "dark", family: "dark", tokens: { bg: "#000000", surface: "#080808", "surface-2": "#101010", "surface-3": "#1a1a1a", border: "#1f1f1f", "border-strong": "#333333", text: "#e8e8e8", "text-muted": "#9a9a9a", "text-faint": "#666666", accent: "#7aa2ff", danger: "#f06b6b", "g-folder": "#e7b955", ok: "#5ec98a" } },
  { name: "Dune", scheme: "dark", family: "dark", tokens: { bg: "#1a1611", surface: "#221d16", "surface-2": "#2b251c", "surface-3": "#362e23", border: "#3a3226", "border-strong": "#4c4233", text: "#ece3d4", "text-muted": "#a89a84", "text-faint": "#786c5a", accent: "#e0a458", danger: "#e5705c", "g-folder": "#e0a458", ok: "#8fc98a" } },
  { name: "Forest", scheme: "dark", family: "dark", tokens: { bg: "#0f1613", surface: "#151e1a", "surface-2": "#1c2722", "surface-3": "#25332c", border: "#26342d", "border-strong": "#34463d", text: "#dfeae3", "text-muted": "#8ba598", "text-faint": "#5f7669", accent: "#5ec98a", danger: "#f06b6b", "g-folder": "#c9b458", ok: "#5ec98a" } },
  { name: "Paper", scheme: "light", family: "light", tokens: { bg: "#f6f7f9", surface: "#ffffff", "surface-2": "#f1f3f6", "surface-3": "#e7eaf0", border: "#e2e5eb", "border-strong": "#cfd4dd", text: "#1b1f27", "text-muted": "#5f6878", "text-faint": "#98a0ae", accent: "#3d63f0", danger: "#d64545", "g-folder": "#d9a128", ok: "#2f9e5f" } },
  { name: "Daylight", scheme: "light", family: "light", tokens: { bg: "#fbfcfe", surface: "#fefeff", "surface-2": "#f3f4f6", "surface-3": "#e6e7ea", border: "#e4e5e8", "border-strong": "#cdced1", text: "#14181f", "text-muted": "#707378", "text-faint": "#a3a5a9", accent: "#0b6bcb", danger: "#d64545", "g-folder": "#d9a128", ok: "#1f8f55" } },
  { name: "Linen", scheme: "light", family: "light", tokens: { bg: "#f7f3ec", surface: "#fdfcfa", "surface-2": "#f0ece5", "surface-3": "#e5e1da", border: "#e3dfd8", "border-strong": "#cecac3", text: "#2b2620", "text-muted": "#7d7872", "text-faint": "#a9a59e", accent: "#b4541a", danger: "#d64545", "g-folder": "#c98a1a", ok: "#3f8a50" } },
  { name: "High contrast", scheme: "dark", family: "contrast", tokens: { bg: "#000000", surface: "#000000", "surface-2": "#101010", "surface-3": "#222222", border: "#777777", "border-strong": "#ffffff", text: "#ffffff", "text-muted": "#e0e0e0", "text-faint": "#c0c0c0", accent: "#ffd400", danger: "#ff6b6b", "g-folder": "#ffd400", ok: "#4dff88" } },
  { name: "High contrast light", scheme: "light", family: "contrast", tokens: { bg: "#ffffff", surface: "#ffffff", "surface-2": "#f0f0f0", "surface-3": "#d8d8d8", border: "#555555", "border-strong": "#000000", text: "#000000", "text-muted": "#1f1f1f", "text-faint": "#404040", accent: "#0033cc", danger: "#b00000", "g-folder": "#7a5200", ok: "#006b2d" } },
  { name: "Mono Slate", scheme: "dark", family: "minimal", tokens: { bg: "#0e1114", surface: "#16191d", "surface-2": "#1f2225", "surface-3": "#2d3134", border: "#272a2e", "border-strong": "#3c3f43", text: "#dfe4ea", "text-muted": "#8b9094", "text-faint": "#5d6165", accent: "#9fb3c8", danger: "#d98b8b", "g-folder": "#9fb3c8", ok: "#a9c2b4" } },
  { name: "Mono Paper", scheme: "light", family: "minimal", tokens: { bg: "#f4f4f4", surface: "#fcfcfc", "surface-2": "#ececec", "surface-3": "#e0e0e0", border: "#dedede", "border-strong": "#c8c8c8", text: "#1a1a1a", "text-muted": "#717171", "text-faint": "#a1a1a1", accent: "#404040", danger: "#a83232", "g-folder": "#6b6b6b", ok: "#3d6b4a" } },
  { name: "Neon Nights", scheme: "dark", family: "vibrant", tokens: { bg: "#0b0a14", surface: "#14131d", "surface-2": "#1d1c27", "surface-3": "#2e2c37", border: "#272530", "border-strong": "#3e3c48", text: "#f1ecff", "text-muted": "#9592a1", "text-faint": "#62606d", accent: "#ff2bd6", danger: "#ff4d6d", "g-folder": "#00f0ff", ok: "#39ff88" } },
  { name: "Electric Lime", scheme: "dark", family: "vibrant", tokens: { bg: "#090d09", surface: "#121612", "surface-2": "#1b201b", "surface-3": "#2b302a", border: "#242924", "border-strong": "#3b403a", text: "#eaf5e6", "text-muted": "#90988e", "text-faint": "#5f655d", accent: "#b6ff00", danger: "#ff5252", "g-folder": "#00e5ff", ok: "#3dff8a" } },
  { name: "Cotton", scheme: "light", family: "pastel", tokens: { bg: "#faf7fb", surface: "#fefdfe", "surface-2": "#f3f0f5", "surface-3": "#e9e5eb", border: "#e7e4e9", "border-strong": "#d4d0d6", text: "#3b3444", "text-muted": "#87828d", "text-faint": "#b1adb5", accent: "#7b63c9", danger: "#d9607a", "g-folder": "#e0905a", ok: "#3f8f6b" } },
  { name: "Sage", scheme: "light", family: "pastel", tokens: { bg: "#f3f6f1", surface: "#fcfdfc", "surface-2": "#ecefea", "surface-3": "#e1e5e0", border: "#dfe3de", "border-strong": "#ccd0cb", text: "#2f3a32", "text-muted": "#7d857e", "text-faint": "#a9afa8", accent: "#4f8a63", danger: "#c9605a", "g-folder": "#c79a3b", ok: "#4f8a63" } },
  { name: "Dusk", scheme: "dark", family: "pastel", tokens: { bg: "#1f1d27", surface: "#27252f", "surface-2": "#2f2d37", "surface-3": "#3d3b45", border: "#37353f", "border-strong": "#4b4953", text: "#e8e3f0", "text-muted": "#9894a0", "text-faint": "#6b6873", accent: "#b8a4e8", danger: "#f08a9b", "g-folder": "#f0c8a0", ok: "#8fd6b0" } },
];

/** Accepts only plain colors, so an imported theme can't smuggle in CSS. */
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\))$/i;

export function isColor(value: string): boolean {
  return COLOR.test(value.trim());
}

/** Parses a theme from JSON, keeping only known tokens with valid colors. */
export function parseTheme(json: string): Theme {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("That is not valid JSON");
  }
  const o = raw as { name?: unknown; scheme?: unknown; tokens?: unknown };
  if (typeof o !== "object" || o === null || typeof o.tokens !== "object" || o.tokens === null) throw new Error('A theme needs a "tokens" object');
  const tokens: Partial<Record<ThemeToken, string>> = {};
  for (const key of THEME_TOKENS) {
    const value = (o.tokens as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !isColor(value)) throw new Error(`"${key}" is not a color`);
    tokens[key] = value.trim();
  }
  if (Object.keys(tokens).length === 0) throw new Error("The theme sets no known colors");
  return { name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 40) : "Custom", scheme: o.scheme === "light" ? "light" : "dark", tokens };
}

export const DENSITIES = { compact: 22, normal: 26, comfortable: 32 } as const;
export type Density = keyof typeof DENSITIES;
