import { describe, expect, it } from "vitest";
import { fuzzyRank } from "./fuzzy";
import { parseQuery } from "./paletteLogic";
import { SETTINGS_INDEX } from "./settingsIndex";

describe("PowerBar settings search", () => {
  it("parses the comma prefix as settings mode", () => {
    expect(parseQuery(",appearance")).toEqual({ mode: "settings", query: "appearance" });
    expect(parseQuery(",")).toEqual({ mode: "settings", query: "" });
  });

  it("matches appearance tab and specific settings via fuzzy search", () => {
    const rank = (q: string) =>
      fuzzyRank(q, SETTINGS_INDEX, (s) => `${s.title} ${s.tabLabel} ${s.keywords}`, (s) => (s.isTab && s.tabLabel.toLowerCase().includes(q.toLowerCase()) ? 8 : 0));

    const appearance = rank("appearance");
    expect(appearance.length).toBeGreaterThan(0);
    expect(appearance[0].item.tab).toBe("appearance");
    expect(appearance[0].item.isTab).toBe(true);

    const accent = rank("accent");
    expect(accent[0].item.tab).toBe("appearance");
    expect(accent[0].item.rowLabel).toBe("Accent color");
  });

  it("includes every settings tab in the index", () => {
    const tabs = SETTINGS_INDEX.filter((s) => s.isTab).map((s) => s.tab);
    expect(tabs).toEqual(["general", "appearance", "shortcuts", "advanced", "updates", "about"]);
  });
});
