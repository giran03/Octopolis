import { describe, expect, it } from "vitest";
import { BUILT_IN_THEMES, isColor, parseTheme } from "./themes";
import { filterMenu } from "./menu";

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
});
