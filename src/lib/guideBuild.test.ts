// The offline guide is generated from the app's own sources; these tests hold it to them.
import { describe, expect, it } from "vitest";
import autoSrc from "./autoView.ts?raw";
import commandsSrc from "../commands.ts?raw";
import changelogMd from "../../CHANGELOG.md?raw";
import { build, constant, extractLiteral, parseChangelog, parseCommands, parseModes, parseThemes } from "../../scripts/build-guide.mjs";
import { BENTO_LIMIT, HUGE_FOLDER } from "./autoView";
import { GUIDE_SECTIONS } from "./guideTheme";
import paletteLogicSrc from "./paletteLogic.ts?raw";
import { MODE_PREFIXES } from "./paletteLogic";
import themeToolsSrc from "./themeTools.ts?raw";
import themesSrc from "./themes.ts?raw";
import { BUILT_IN_THEMES, THEME_FAMILIES } from "./themes";
import { fullTokens } from "./themeTools";

describe("generated guide data", () => {
  it("reads every command of the app with its title, category and keys", () => {
    const list = parseCommands(commandsSrc);
    const body = extractLiteral(commandsSrc, "export const COMMANDS: readonly Command[] =");
    expect(list.length).toBe((body.match(/\bid:\s*"/g) ?? []).length);
    expect(list.length).toBe((body.match(/\bcategory:\s*"/g) ?? []).length);
    expect(list.length).toBeGreaterThan(100);
    expect(new Set(list.map((c) => c.id)).size).toBe(list.length);
    const categories = /export type Category = ([^;]+);/.exec(commandsSrc)![1].match(/"([^"]+)"/g)!.map((s) => s.slice(1, -1));
    for (const c of list) expect(categories).toContain(c.category);
    expect(list.find((c) => c.id === "palette.go")).toMatchObject({ title: "Go to folder…", keys: ["ctrl+p"] });
    expect(list.find((c) => c.id === "file.undo")?.keys).toEqual(["ctrl+z"]);
    expect(list.find((c) => c.id === "file.copy")?.vimKeys).toEqual(["y y"]);
    expect(list.find((c) => c.id === "app.shortcuts")?.keys).toEqual(["ctrl+k ctrl+s"]);
  });

  it("matches the app's themes, families, palette modes and Auto view limits exactly", () => {
    const { themes, families } = parseThemes(themesSrc, themeToolsSrc);
    expect(themes).toEqual(BUILT_IN_THEMES.map((t) => ({ name: t.name, scheme: t.scheme, family: t.family, tokens: fullTokens(t) })));
    expect(families).toEqual(THEME_FAMILIES);
    expect(parseModes(paletteLogicSrc)).toEqual(MODE_PREFIXES.map(({ prefix, label, hint }) => ({ prefix, label, hint })));
    expect(constant(autoSrc, "BENTO_LIMIT")).toBe(BENTO_LIMIT);
    expect(constant(autoSrc, "HUGE_FOLDER")).toBe(HUGE_FOLDER);
  });
});


describe("changelog", () => {
  it("splits releases, kinds and entries into a lead sentence and the detail", () => {
    const md = "# Changelog\n\n## [1.2.0] - 2026-01-02\n\n### Added\n\n- Dark mode. It follows `Windows` settings.\n- A thing with no full stop\n\n### Fixed\n\n- Crash on **start**. Thanks!\n\n## [1.1.0] - Unreleased\n\n### Added\n\n- Old (Ctrl+P) thing\n  continued here.\n";
    const r = parseChangelog(md);
    expect(r.map((x) => [x.version, x.date])).toEqual([["1.2.0", "2026-01-02"], ["1.1.0", "Unreleased"]]);
    expect(r[0].sections[0]).toEqual({ type: "Added", entries: [{ title: "Dark mode", body: "It follows Windows settings." }, { title: "A thing with no full stop", body: "" }] });
    expect(r[0].sections[1].entries[0]).toEqual({ title: "Crash on start", body: "Thanks!" });
    expect(r[1].sections[0].entries[0].title).toBe("Old (Ctrl+P) thing continued here");
  });

  it("reads the real changelog: every entry has a title and nothing is lost", () => {
    const r = parseChangelog(changelogMd);
    const entries = r.flatMap((x) => x.sections.flatMap((s) => s.entries));
    expect(entries.length).toBe((changelogMd.match(/^- /gm) ?? []).length);
    for (const e of entries) expect(e.title.length).toBeGreaterThan(3);
  });
});

describe("the built page", () => {
  const { html, sections } = build();
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

  it("is one self-contained page that works offline", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    // The only external file is the theme the app writes next to it.
    expect([...html.matchAll(/\b(?:src|href)="([^"#][^"]*)"/g)].map((m) => m[1]).filter((u) => !u.startsWith("data:") && u !== "guide-theme.js")).toEqual([]);
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(html).not.toMatch(/\{\{\w+\}\}/);
    expect(html).not.toContain("<!--@");
    expect(html.length).toBeLessThan(600 * 1024);
  });

  it("has unique ids and every in-page link lands somewhere", () => {
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    const links = [...html.matchAll(/\shref="#([^"]+)"/g)].map((m) => m[1]);
    for (const l of links) expect(ids, `link #${l}`).toContain(l);
    for (const s of sections) expect(html).toContain(`<a href="#${s.id}">`);
  });

  it("can be opened on every section the app asks for", () => {
    for (const id of GUIDE_SECTIONS) expect(ids, `section #${id}`).toContain(id);
  });

  it("documents the main areas", () => {
    for (const id of ["overview", "getting-started", "palette", "views", "auto-view", "search", "drag-drop", "file-operations", "power-tools", "customize", "shortcuts", "settings", "privacy", "troubleshooting", "changelog"]) expect(ids).toContain(id);
  });

  it("carries the generated data as valid, script-safe JSON", () => {
    const m = /<script type="application\/json" id="guide-data">([\s\S]*?)<\/script>/.exec(html)!;
    const data = JSON.parse(m[1]);
    expect(data.commands.length).toBeGreaterThan(100);
    expect(data.themes.length).toBe(BUILT_IN_THEMES.length);
    expect(data.changelog[0].sections[0].entries.length).toBeGreaterThan(50);
    expect(m[1]).not.toContain("<");
  });
});
