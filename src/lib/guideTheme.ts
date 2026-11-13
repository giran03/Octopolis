// What the offline guide needs to look like the app: the resolved theme colors, the font, the motion setting, and
// which section to open on. The app writes this next to the guide (guide-theme.js); the guide reads it.
import { isGoogleFont } from "./fonts";
import { BUILT_IN_THEMES, isColor, THEME_TOKENS, type Theme, type ThemeToken } from "./themes";
import { fullTokens, MIDNIGHT_TOKENS, themeVars } from "./themeTools";

export type MotionPref = "system" | "reduce" | "full";

export interface GuidePayload {
  readonly v: 1;
  /** The theme the app is showing, and its colors as CSS variables. */
  readonly name: string;
  readonly scheme: "dark" | "light";
  readonly vars: Readonly<Record<string, string>>;
  /** The user's own themes, so the guide can offer them too. */
  readonly themes: readonly { name: string; scheme: "dark" | "light"; tokens: Partial<Record<ThemeToken, string>> }[];
  /** CSS font-family for the interface font, when it can apply. */
  readonly font: string | null;
  readonly motion: MotionPref;
  /** Section to open on; the guide scrolls there once per `openedAt`. */
  readonly section: string | null;
  readonly openedAt: number;
  /** Words to search for when the guide opens (null: none). */
  readonly search: string | null;
  readonly version: string;
}

export interface GuideThemeInput {
  readonly theme: string;
  readonly systemLight: string;
  readonly systemDark: string;
  readonly systemIsDark: boolean;
  readonly customThemes: readonly Theme[];
  readonly accent: string | null;
  readonly uiFont: string;
  readonly googleFonts: boolean;
  readonly motion: MotionPref;
}

const PAPER = BUILT_IN_THEMES.find((t) => t.name === "Paper")!;

/** The theme the app shows right now: "Follow Windows" picks the pairing for light or dark; none picked uses the built-in look. */
export function resolveTheme(i: Pick<GuideThemeInput, "theme" | "systemLight" | "systemDark" | "systemIsDark" | "customThemes">): { name: string; scheme: "dark" | "light"; tokens: Record<ThemeToken, string> } {
  const chosen = i.theme === "System" ? (i.systemIsDark ? i.systemDark : i.systemLight) : i.theme;
  const found = [...BUILT_IN_THEMES, ...i.customThemes].find((t) => t.name === chosen);
  if (found) return { name: found.name, scheme: found.scheme, tokens: fullTokens(found) };
  // No theme picked (Follow Windows without a pairing): the app falls back to its own light or dark colors.
  return i.systemIsDark ? { name: "Midnight", scheme: "dark", tokens: { ...MIDNIGHT_TOKENS } } : { name: "Paper", scheme: "light", tokens: fullTokens(PAPER) };
}

export function guidePayload(i: GuideThemeInput, extra: { section: string | null; openedAt: number; version: string; search?: string | null }): GuidePayload {
  const theme = resolveTheme(i);
  const tokens = { ...theme.tokens };
  if (i.accent && isColor(i.accent)) tokens.accent = i.accent.trim();
  const font = i.uiFont.trim();
  const usable = font !== "" && (!isGoogleFont(font) || i.googleFonts);
  const customThemes = i.customThemes.map((t) => {
    const clean: Partial<Record<ThemeToken, string>> = {};
    for (const k of THEME_TOKENS) {
      const v = t.tokens[k];
      if (v && isColor(v)) clean[k] = v;
    }
    return { name: t.name, scheme: t.scheme, tokens: fullTokens({ tokens: clean }) as Partial<Record<ThemeToken, string>> };
  });
  return {
    v: 1,
    name: theme.name,
    scheme: theme.scheme,
    vars: themeVars({ tokens }),
    themes: customThemes,
    font: usable ? `"${font.replace(/"/g, "")}", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif` : null,
    motion: i.motion,
    section: extra.section,
    openedAt: extra.openedAt,
    search: extra.search?.trim().slice(0, 200) || null,
    version: extra.version,
  };
}

/** What is open in the app, for choosing the guide section that explains it. */
export interface GuideContext {
  readonly palette: boolean;
  readonly settingsTab: string | null;
  readonly themeEditor: boolean;
  readonly actionsEditor: boolean;
  readonly recycleBin: boolean;
  readonly duplicates: boolean;
  readonly rules: boolean;
  readonly cleanup: boolean;
  readonly tags: boolean;
  readonly batchRename: boolean;
  readonly properties: boolean;
  readonly imageTools: boolean;
  readonly emoji: boolean;
}

/** Every section id the guide can be opened on, for tests to hold the guide to. */
export const GUIDE_SECTIONS = ["palette", "theme-creator", "customize", "shortcuts-edit", "changelog", "settings", "custom-actions", "recycle-bin", "duplicates", "folder-rules", "free-space", "tags", "batch-rename", "basics", "image-tools", "folder-icons"] as const;

/** The guide section that matches what the user is looking at, or null for the top of the guide. */
export function guideSectionFor(c: GuideContext): (typeof GUIDE_SECTIONS)[number] | null {
  if (c.palette) return "palette";
  if (c.themeEditor) return "theme-creator";
  if (c.emoji) return "folder-icons";
  if (c.actionsEditor) return "custom-actions";
  if (c.batchRename) return "batch-rename";
  if (c.recycleBin) return "recycle-bin";
  if (c.duplicates) return "duplicates";
  if (c.rules) return "folder-rules";
  if (c.cleanup) return "free-space";
  if (c.tags) return "tags";
  if (c.imageTools) return "image-tools";
  if (c.properties) return "basics";
  if (c.settingsTab) {
    return c.settingsTab === "appearance" ? "customize" : c.settingsTab === "shortcuts" ? "shortcuts-edit" : c.settingsTab === "updates" ? "changelog" : "settings";
  }
  return null;
}
