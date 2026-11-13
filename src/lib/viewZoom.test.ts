import { describe, expect, it } from "vitest";
import { parseFolderViews, rememberView, viewFor } from "./folderViews";
import { clampIcon, ICON_MAX, ICON_MIN, iconCell, iconPresetFor, stepView, thumbBucket, viewAt, viewLabel, ZOOM_MAX, zoomOf } from "./viewZoom";

describe("the zoom slider", () => {
  it("puts the compact views on fixed steps and the icon views on a smooth range", () => {
    expect(zoomOf("list", 96)).toBe(0);
    expect(zoomOf("details", 96)).toBe(120);
    expect(zoomOf("content", 96)).toBe(240);
    expect(zoomOf("tiles", 96)).toBe(360);
    expect(zoomOf("grid", ICON_MIN)).toBe(480);
    expect(zoomOf("grid", ICON_MAX)).toBe(ZOOM_MAX);
    expect(zoomOf("columns", 96)).toBeNull();
  });

  it("snaps to the nearest compact view below the icons", () => {
    expect(viewAt(0).mode).toBe("list");
    expect(viewAt(50).mode).toBe("list");
    expect(viewAt(70).mode).toBe("details");
    expect(viewAt(250).mode).toBe("content");
    expect(viewAt(400).mode).toBe("tiles");
    expect(viewAt(430)).toEqual({ mode: "grid", size: ICON_MIN });
  });

  it("maps the icon range to sizes and back", () => {
    expect(viewAt(ZOOM_MAX)).toEqual({ mode: "grid", size: ICON_MAX });
    for (const size of [40, 56, 96, 160, 256]) {
      const z = zoomOf("grid", size)!;
      expect(Math.abs(viewAt(z).size - size)).toBeLessThanOrEqual(1);
    }
    // Always increasing, so dragging the slider never goes backwards.
    let last = -1;
    for (let z = 480; z <= ZOOM_MAX; z += 20) {
      const s = viewAt(z).size;
      expect(s).toBeGreaterThanOrEqual(last);
      last = s;
    }
  });

  it("keeps bad input in range", () => {
    expect(clampIcon(5)).toBe(ICON_MIN);
    expect(clampIcon(9999)).toBe(ICON_MAX);
    expect(clampIcon(NaN)).toBe(96);
    expect(viewAt(-50).mode).toBe("list");
    expect(viewAt(NaN).mode).toBe("list");
    expect(viewAt(5000).size).toBe(ICON_MAX);
  });

  it("names sizes like Explorer and lays out cells from them", () => {
    expect(iconPresetFor(256).label).toBe("Extra large icons");
    expect(iconPresetFor(150).label).toBe("Large icons");
    expect(iconPresetFor(96).label).toBe("Medium icons");
    expect(iconPresetFor(40).label).toBe("Small icons");
    expect(viewLabel("details", 96)).toBe("Details");
    expect(viewLabel("grid", 160)).toBe("Large icons · 160 px");
    expect(iconCell(256)).toEqual({ w: 284, h: 296, thumb: 256 });
    expect(iconCell(40).w).toBe(80);
    expect(thumbBucket(40)).toBe(64);
    expect(thumbBucket(96)).toBe(96);
    expect(thumbBucket(97)).toBe(160);
    expect(thumbBucket(256)).toBe(256);
  });

  it("steps one notch at a time from any view", () => {
    expect(stepView("list", 96, -1)).toEqual({ mode: "list", size: 96 });
    expect(stepView("list", 96, 1)).toEqual({ mode: "details", size: 96 });
    expect(stepView("tiles", 96, 1)).toEqual({ mode: "grid", size: ICON_MIN });
    expect(stepView("grid", ICON_MIN, -1)?.mode).toBe("tiles");
    expect(stepView("grid", 96, 1)!.size).toBeGreaterThan(96);
    expect(stepView("grid", 96, -1)!.size).toBeLessThan(96);
    expect(stepView("grid", ICON_MAX, 1)!.size).toBe(ICON_MAX);
    expect(stepView("columns", 96, 1)).toBeNull();
    // From the first step, repeated notches reach the largest icons without getting stuck.
    let v = { mode: "list" as const, size: 96 } as ReturnType<typeof stepView>;
    for (let i = 0; i < 60 && v && !(v.mode === "grid" && v.size === ICON_MAX); i++) v = stepView(v.mode, v.size, 1);
    expect(v).toEqual({ mode: "grid", size: ICON_MAX });
  });
});

describe("remembered views", () => {
  it("keeps the new views and the icon size, and drops nonsense", () => {
    const all = parseFolderViews([
      ["c:\\a", { mode: "list", sort: { key: "name", dir: 1 } }],
      ["c:\\b", { mode: "grid", size: 160, sort: { key: "size", dir: -1 } }],
      ["c:\\c", { mode: "tiles", size: 9999, sort: { key: "name", dir: 1 } }],
      ["c:\\d", { mode: "content", size: "big", sort: { key: "name", dir: 1 } }],
      ["c:\\e", { mode: "cards", sort: { key: "name", dir: 1 } }],
    ]);
    expect(all.map(([k]) => k)).toEqual(["c:\\a", "c:\\b", "c:\\c", "c:\\d"]);
    expect(viewFor(all, "C:\\B")).toMatchObject({ mode: "grid", size: 160 });
    expect(viewFor(all, "c:\\c")?.size).toBe(256);
    expect(viewFor(all, "c:\\d")?.size).toBeUndefined();
    const again = rememberView(all, "c:\\a", { mode: "grid", size: 96, sort: { key: "name", dir: 1 } });
    expect(again[0][1]).toMatchObject({ mode: "grid", size: 96 });
  });
});

describe("the bento view", () => {
  it("is a view of its own, outside the zoom slider, that zooms by row height", async () => {
    const { bentoRowHeight, BENTO_GAP } = await import("./viewZoom");
    expect(zoomOf("bento", 96)).toBeNull();
    expect(viewLabel("bento", 96)).toBe("Bento");
    expect(stepView("bento", 96, 1)).toMatchObject({ mode: "bento" });
    expect(stepView("bento", 96, 1)!.size).toBeGreaterThan(96);
    expect(stepView("bento", ICON_MIN, -1)!.size).toBe(ICON_MIN);
    expect(bentoRowHeight(96)).toBeGreaterThan(bentoRowHeight(56));
    expect(BENTO_GAP).toBeGreaterThan(0);
    expect(parseFolderViews([["c:\a", { mode: "bento", size: 120, sort: { key: "name", dir: 1 } }]])[0][1]).toMatchObject({ mode: "bento", size: 120 });
  });
});
