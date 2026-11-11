// Theme engine: named token sets, plus safe import of custom themes.

export const THEME_TOKENS = [
  "bg", "surface", "surface-2", "surface-3", "border", "border-strong", "text", "text-muted", "text-faint", "accent", "danger", "g-folder",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

export interface Theme {
  readonly name: string;
  readonly scheme: "dark" | "light";
  readonly tokens: Readonly<Partial<Record<ThemeToken, string>>>;
}

export const BUILT_IN_THEMES: readonly Theme[] = [
  { name: "Midnight", scheme: "dark", tokens: {} },
  {
    name: "Paper", scheme: "light",
    tokens: { bg: "#f6f7f9", surface: "#ffffff", "surface-2": "#f1f3f6", "surface-3": "#e7eaf0", border: "#e2e5eb", "border-strong": "#cfd4dd", text: "#1b1f27", "text-muted": "#5f6878", "text-faint": "#98a0ae", accent: "#3d63f0", danger: "#d64545", "g-folder": "#d9a128" },
  },
  {
    name: "Dune", scheme: "dark",
    tokens: { bg: "#1a1611", surface: "#221d16", "surface-2": "#2b251c", "surface-3": "#362e23", border: "#3a3226", "border-strong": "#4c4233", text: "#ece3d4", "text-muted": "#a89a84", "text-faint": "#786c5a", accent: "#e0a458", danger: "#e5705c", "g-folder": "#e0a458" },
  },
  {
    name: "Forest", scheme: "dark",
    tokens: { bg: "#0f1613", surface: "#151e1a", "surface-2": "#1c2722", "surface-3": "#25332c", border: "#26342d", "border-strong": "#34463d", text: "#dfeae3", "text-muted": "#8ba598", "text-faint": "#5f7669", accent: "#5ec98a", danger: "#f06b6b", "g-folder": "#c9b458" },
  },
  {
    name: "High contrast", scheme: "dark",
    tokens: { bg: "#000000", surface: "#000000", "surface-2": "#101010", "surface-3": "#222222", border: "#777777", "border-strong": "#ffffff", text: "#ffffff", "text-muted": "#e0e0e0", "text-faint": "#c0c0c0", accent: "#ffd400", danger: "#ff6b6b", "g-folder": "#ffd400" },
  },
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
