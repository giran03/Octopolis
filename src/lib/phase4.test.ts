import { describe, expect, it } from "vitest";
import { BUILT_IN_THEMES, isColor, parseTheme } from "./themes";
import { clampMenuPosition, filterMenu, MENU_EDGE_GAP } from "./menu";
import { psCdCommand } from "./paths";

describe("terminal folder sync", () => {
  it("quotes paths so a folder name cannot run commands", () => {
    expect(psCdCommand("C:\\a")).toBe("Set-Location -LiteralPath 'C:\\a'\r");
    expect(psCdCommand("C:\\it's")).toBe("Set-Location -LiteralPath 'C:\\it''s'\r");
    expect(psCdCommand("C:\\x\u2019; calc; \u2018")).toBe("Set-Location -LiteralPath 'C:\\x\u2019\u2019; calc; \u2018\u2018'\r");
  });
});

describe("themes", () => {
  it("accepts plain colors and rejects anything else", () => {
    expect(isColor("#abc")).toBe(true);
    expect(isColor("rgb(1, 2, 3)")).toBe(true);
    expect(isColor("hsl(200deg 50% 50%)")).toBe(true);
    expect(isColor("red; background: url(x)")).toBe(false);
    expect(isColor("url(http://x)")).toBe(false);
  });

  it("imports known tokens and refuses injected CSS", () => {
    const t = parseTheme('{"name":"Mine","scheme":"light","tokens":{"bg":"#111","accent":"#f00","unknown":"#000"}}');
    expect(t).toEqual({ name: "Mine", scheme: "light", tokens: { bg: "#111", accent: "#f00" } });
    expect(() => parseTheme('{"tokens":{"bg":"#111; color:red"}}')).toThrow(/not a color/);
    expect(() => parseTheme("nope")).toThrow(/JSON/);
    expect(() => parseTheme('{"tokens":{"nothing":"#111"}}')).toThrow(/no known/);
  });

  it("built-in themes only use valid colors", () => {
    for (const t of BUILT_IN_THEMES) for (const v of Object.values(t.tokens)) expect(isColor(v)).toBe(true);
  });
});

describe("curated context menu", () => {
  const items = [
    { label: "Open" },
    "separator" as const,
    { label: "Copy" },
    { label: "Copy path" },
    "separator" as const,
    { label: "Delete" },
  ];

  it("moves pinned actions to the top", () => {
    const out = filterMenu(items, "", new Set(["Delete"]));
    expect(out[0]).toEqual({ label: "Delete" });
    expect(out[1]).toBe("separator");
    expect(out.filter((x) => x !== "separator")).toHaveLength(4);
  });

  it("filters by text, dropping separators", () => {
    expect(filterMenu(items, "cop", new Set())).toEqual([{ label: "Copy" }, { label: "Copy path" }]);
  });

  it("collapses leading, trailing and doubled separators", () => {
    const out = filterMenu(["separator", { label: "A" }, "separator", "separator", { label: "B" }, "separator"], "", new Set());
    expect(out).toEqual([{ label: "A" }, "separator", { label: "B" }]);
  });

  it("clamps context menus away from window corners and accounts for UI zoom", () => {
    expect(clampMenuPosition(0, 2, 260, 400, 1280, 800)).toEqual({ x: MENU_EDGE_GAP, y: MENU_EDGE_GAP });
    expect(clampMenuPosition(1275, 795, 260, 400, 1280, 800)).toEqual({ x: 1280 - 260 - MENU_EDGE_GAP, y: 800 - 400 - MENU_EDGE_GAP });
    expect(clampMenuPosition(1100, 700, 240, 300, 1200, 800, 1.25)).toEqual({ x: (1200 - 240 - MENU_EDGE_GAP) / 1.25, y: (800 - 300 - MENU_EDGE_GAP) / 1.25 });
  });
});

import { recentVisits, recordVisit } from "./frecency";
import { clampSidebarWidth, isPinned, movePin, renamePin, sidebarWidthForRowPx, togglePin } from "./sidebar";

describe("sidebar pins", () => {
  it("toggles a pin case-insensitively and labels it by folder name", () => {
    const pinned = togglePin([], "C:\\Work\\Docs");
    expect(pinned).toEqual([{ path: "C:\\Work\\Docs", label: "Docs" }]);
    expect(isPinned(pinned, "c:\\work\\docs\\")).toBe(true);
    expect(togglePin(pinned, "c:\\work\\docs")).toEqual([]);
  });

  it("moves pins and stops at the ends", () => {
    const pins = ["C:\\a", "C:\\b", "C:\\c"].reduce((acc, p) => togglePin(acc, p), [] as ReturnType<typeof togglePin>);
    expect(movePin(pins, "C:\\c", -1).map((p) => p.label)).toEqual(["a", "c", "b"]);
    expect(movePin(pins, "C:\\a", -1).map((p) => p.label)).toEqual(["a", "b", "c"]);
    expect(movePin(pins, "C:\\c", 1).map((p) => p.label)).toEqual(["a", "b", "c"]);
  });

  it("renames a pin and falls back to the folder name when blank", () => {
    const pins = togglePin([], "C:\\Work\\Docs");
    expect(renamePin(pins, "C:\\Work\\Docs", " Papers ")[0].label).toBe("Papers");
    expect(renamePin(pins, "C:\\Work\\Docs", "  ")[0].label).toBe("Docs");
  });

  it("clamps the sidebar width", () => {
    expect(clampSidebarWidth(-20)).toBe(0);
    expect(clampSidebarWidth(50)).toBe(50);
    expect(clampSidebarWidth(900)).toBe(380);
    expect(clampSidebarWidth(250.4)).toBe(250);
  });

  it("maps density row heights to sidebar widths", () => {
    expect(sidebarWidthForRowPx(22)).toBe(150);
    expect(sidebarWidthForRowPx(24)).toBe(195);
    expect(sidebarWidthForRowPx(26)).toBe(240);
    expect(sidebarWidthForRowPx(32)).toBe(280);
  });
});

describe("recent folders", () => {
  it("orders by last visit, not by visit count", () => {
    let db = recordVisit({}, "C:\\often", 1000);
    db = recordVisit(db, "C:\\often", 1001);
    db = recordVisit(db, "C:\\latest", 5000);
    expect(recentVisits(db, 5).map((r) => r.path)).toEqual(["C:\\latest", "C:\\often"]);
  });
});

import { insertPins, reorderPin } from "./sidebar";
describe("pin drag and drop", () => {
  const pins = ["a", "b", "c"].map((n) => ({ path: `C:\\${n}`, label: n }));
  const labels = (p: readonly { label: string }[]) => p.map((x) => x.label);
  it("reorders before a given index", () => {
    expect(labels(reorderPin(pins, "C:\\a", 3))).toEqual(["b", "c", "a"]);
    expect(labels(reorderPin(pins, "C:\\c", 0))).toEqual(["c", "a", "b"]);
    expect(labels(reorderPin(pins, "C:\\a", 1))).toEqual(["a", "b", "c"]);
  });
  it("inserts new pins and skips duplicates", () => {
    expect(labels(insertPins(pins, ["C:\\x", "C:\\b", "D:\\y"], 1))).toEqual(["a", "x", "y", "b", "c"]);
  });
});

import { fileIconSpec, ICON_EXTENSIONS } from "./fileicons";

describe("file type icons", () => {
  it("knows supported types case-insensitively and ignores the rest", () => {
    expect(fileIconSpec("main.RS")).toEqual({ code: "E943", tone: "rust" });
    expect(fileIconSpec("report.final.pdf")?.tone).toBe("red");
    expect(fileIconSpec("archive.tar.gz")?.code).toBe("E7B8");
    expect(fileIconSpec("README")).toBeNull();
    expect(fileIconSpec(".gitignore")).toBeNull();
    expect(fileIconSpec("data.unknownext")).toBeNull();
  });

  it("gives every listed extension a real code point", () => {
    for (const ext of ICON_EXTENSIONS) {
      const spec = fileIconSpec(`x.${ext}`);
      expect(spec?.code).toMatch(/^[0-9A-F]{4}$/);
    }
  });
});
