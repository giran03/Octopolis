import { describe, expect, it } from "vitest";
import { guidePayload, guideSectionFor, resolveTheme, type GuideContext, type GuideThemeInput } from "./guideTheme";
import { MIDNIGHT_TOKENS } from "./themeTools";
import type { Theme } from "./themes";

const base: GuideThemeInput = { theme: "Midnight", systemLight: "Paper", systemDark: "Graphite", systemIsDark: true, customThemes: [], accent: null, uiFont: "", googleFonts: false, motion: "system" };
const extra = { section: null, openedAt: 1, version: "0.1.0" };
const mine: Theme = { name: "Mine", scheme: "light", tokens: { bg: "#fafafa", accent: "#ff0066" } };

describe("the theme the guide follows", () => {
  it("uses the chosen theme, with Midnight's colors for any the theme leaves out", () => {
    const p = guidePayload(base, extra);
    expect(p.name).toBe("Midnight");
    expect(p.scheme).toBe("dark");
    expect(p.vars["--bg"]).toBe(MIDNIGHT_TOKENS.bg);
    expect(p.vars["--accent-soft"]).toContain("color-mix");
    const light = guidePayload({ ...base, theme: "Mine", customThemes: [mine] }, extra);
    expect(light.scheme).toBe("light");
    expect(light.vars["--bg"]).toBe("#fafafa");
    expect(light.vars["--text"]).toBe(MIDNIGHT_TOKENS.text);
  });

  it("Follow Windows picks the pairing for the current light or dark mode", () => {
    expect(resolveTheme({ ...base, theme: "System", systemIsDark: true }).name).toBe("Graphite");
    expect(resolveTheme({ ...base, theme: "System", systemIsDark: false }).name).toBe("Paper");
  });

  it("falls back to the app's own light or dark look when no theme is paired", () => {
    expect(resolveTheme({ ...base, theme: "System", systemDark: "", systemIsDark: true })).toMatchObject({ name: "Midnight", scheme: "dark" });
    expect(resolveTheme({ ...base, theme: "System", systemLight: "", systemIsDark: false })).toMatchObject({ name: "Paper", scheme: "light" });
    expect(resolveTheme({ ...base, theme: "Gone" }).scheme).toBe("dark");
  });

  it("applies the accent override only when it is a plain color", () => {
    expect(guidePayload({ ...base, accent: "#12ab34" }, extra).vars["--accent"]).toBe("#12ab34");
    expect(guidePayload({ ...base, accent: "red; background:url(x)" }, extra).vars["--accent"]).toBe(MIDNIGHT_TOKENS.accent);
  });

  it("shares the user's themes, keeping only valid colors", () => {
    const evil: Theme = { name: "Evil", scheme: "dark", tokens: { bg: "url(javascript:1)", accent: "#abcdef" } };
    const p = guidePayload({ ...base, customThemes: [mine, evil] }, extra);
    expect(p.themes.map((t) => t.name)).toEqual(["Mine", "Evil"]);
    expect(p.themes[1].tokens.bg).toBe(MIDNIGHT_TOKENS.bg);
    expect(p.themes[1].tokens.accent).toBe("#abcdef");
  });

  it("passes the interface font only when it can apply, and never a quote", () => {
    expect(guidePayload({ ...base, uiFont: "" }, extra).font).toBeNull();
    expect(guidePayload({ ...base, uiFont: "Cascadia Code" }, extra).font).toContain('"Cascadia Code"');
    expect(guidePayload({ ...base, uiFont: 'A"B' }, extra).font).toContain('"AB"');
    // A Google font only applies while Google Fonts is on.
    expect(guidePayload({ ...base, uiFont: "Inter", googleFonts: false }, extra).font).toBeNull();
    expect(guidePayload({ ...base, uiFont: "Inter", googleFonts: true }, extra).font).toContain('"Inter"');
  });

  it("carries the motion setting, the section and when it was opened", () => {
    expect(guidePayload({ ...base, motion: "reduce" }, { section: "palette", openedAt: 7, version: "1.2.3" })).toMatchObject({ motion: "reduce", section: "palette", openedAt: 7, version: "1.2.3", v: 1 });
  });
});

const none: GuideContext = { palette: false, settingsTab: null, themeEditor: false, actionsEditor: false, recycleBin: false, duplicates: false, rules: false, cleanup: false, tags: false, batchRename: false, properties: false, imageTools: false, emoji: false };

describe("choosing the guide section", () => {
  it("opens the section that explains what is on screen", () => {
    expect(guideSectionFor(none)).toBeNull();
    expect(guideSectionFor({ ...none, palette: true })).toBe("palette");
    expect(guideSectionFor({ ...none, themeEditor: true, settingsTab: "appearance" })).toBe("theme-creator");
    expect(guideSectionFor({ ...none, settingsTab: "appearance" })).toBe("customize");
    expect(guideSectionFor({ ...none, settingsTab: "shortcuts" })).toBe("shortcuts-edit");
    expect(guideSectionFor({ ...none, settingsTab: "updates" })).toBe("changelog");
    expect(guideSectionFor({ ...none, settingsTab: "general" })).toBe("settings");
    expect(guideSectionFor({ ...none, actionsEditor: true })).toBe("custom-actions");
    expect(guideSectionFor({ ...none, duplicates: true })).toBe("duplicates");
  });
});
