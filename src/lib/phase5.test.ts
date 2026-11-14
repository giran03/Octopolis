import { describe, expect, it } from "vitest";
import { cellsInRect, extensionOf, invertSelection, marqueeSelection, namePattern, rowsInBand, selectWhere } from "./selection";
import { attributeLetters, gridTemplate, moveColumn, stepColumn, toggleColumn, visibleColumns } from "./columns";
import { compareListings, countStatuses, isDifference } from "./compare";
import { planTransfer } from "./conflicts";
import { cloudState } from "./listing";
import { formatPath, formatPaths, toFileUrl, toRelative, toWslPath } from "./pathFormats";
import { parseFolderViews, rememberView, viewFor } from "./folderViews";
import { classifyTarget, contentTerm, THIS_PC } from "./launch";
import { parsePreset } from "./session";
import { extrasToRemove, summarize } from "./summary";
import { parseSavedSearches } from "../state/savedSearches";

describe("parsePreset", () => {
  const good = {
    layout: { kind: "split", dir: "row", children: [{ kind: "leaf", paneId: "a" }, { kind: "leaf", paneId: "b" }], sizes: [0.3, 0.7] },
    panes: { a: { tabs: ["C:\\", "D:\\x"], active: 1 }, b: { tabs: ["E:\\"], active: 0 } },
  };

  it("accepts a saved two-pane session", () => {
    const p = parsePreset(good);
    expect(p?.panes.a).toMatchObject({ tabs: ["C:\\", "D:\\x"], active: 1, pinned: [false, false], colors: [null, null] });
    expect(p?.layout.kind).toBe("split");
  });

  it("keeps pins and colors, dropping invalid ones", () => {
    const p = parsePreset({ ...good, panes: { ...good.panes, a: { tabs: ["C:\\", "", "D:\\x"], active: 0, pinned: [true, true, "yes"], colors: ["blue", "red", "neon"] } } });
    expect(p?.panes.a).toMatchObject({ tabs: ["C:\\", "D:\\x"], pinned: [true, false], colors: ["blue", null] });
  });

  it("clamps an out-of-range active tab", () => {
    expect(parsePreset({ ...good, panes: { ...good.panes, a: { tabs: ["C:\\"], active: 9 } } })?.panes.a.active).toBe(0);
  });

  it("normalises split sizes to sum to 1", () => {
    const p = parsePreset({ ...good, layout: { ...good.layout, sizes: [1, 3] } });
    expect(p?.layout.kind === "split" && p.layout.sizes).toEqual([0.25, 0.75]);
  });

  it("rejects damaged values", () => {
    expect(parsePreset(null)).toBeNull();
    expect(parsePreset("nope")).toBeNull();
    expect(parsePreset({ ...good, panes: { a: good.panes.a } })).toBeNull(); // pane b missing
    expect(parsePreset({ ...good, panes: { ...good.panes, b: { tabs: [], active: 0 } } })).toBeNull();
    expect(parsePreset({ ...good, layout: { ...good.layout, sizes: [1] } })).toBeNull();
    expect(parsePreset({ ...good, layout: { ...good.layout, children: [{ kind: "leaf", paneId: "a" }, { kind: "leaf", paneId: "a" }] } })).toBeNull();
  });
});

describe("path formats", () => {
  const base = "C:\\Users\\me";
  it("formats each style", () => {
    const p = "C:\\Users\\me\\My docs\\a#1.txt";
    expect(formatPath(p, "quoted", base)).toBe('"C:\\Users\\me\\My docs\\a#1.txt"');
    expect(formatPath(p, "forward", base)).toBe("C:/Users/me/My docs/a#1.txt");
    expect(formatPath(p, "relative", base)).toBe(".\\My docs\\a#1.txt");
    expect(formatPath(p, "name", base)).toBe("a#1.txt");
    expect(formatPath(p, "url", base)).toBe("file:///C:/Users/me/My%20docs/a%231.txt");
    expect(formatPath(p, "wsl", base)).toBe("/mnt/c/Users/me/My docs/a#1.txt");
  });

  it("handles roots, other folders and network paths", () => {
    expect(toWslPath("D:\\")).toBe("/mnt/d");
    expect(toFileUrl("C:\\")).toBe("file:///C:/");
    expect(toFileUrl("\\\\nas\\share\\x y")).toBe("file://nas/share/x%20y");
    expect(toRelative("D:\\other", base)).toBe("D:\\other");
    expect(toRelative("C:\\Users\\meme\\x", base)).toBe("C:\\Users\\meme\\x");
    expect(toRelative(base, base)).toBe(".");
  });

  it("joins quoted paths on one line and others one per line", () => {
    expect(formatPaths(["C:\\a", "C:\\b"], "quoted", base)).toBe('"C:\\a" "C:\\b"');
    expect(formatPaths(["C:\\a", "C:\\b"], "plain", base)).toBe("C:\\a\r\nC:\\b");
  });
});

describe("planTransfer", () => {
  const side = (path: string, modifiedMs: number, isDir = false) => ({ path, isDir, size: 1, modifiedMs });
  const conflicts = [
    { source: side("C:\\a\\x.txt", 200), target: side("D:\\x.txt", 100) }, // incoming is newer
    { source: side("C:\\a\\y.txt", 100), target: side("D:\\y.txt", 300) }, // incoming is older
    { source: side("C:\\a\\dir", 0, true), target: side("D:\\dir", 0, false) }, // folder onto a file
  ];
  const sources = ["C:\\a\\x.txt", "C:\\a\\y.txt", "C:\\a\\dir", "C:\\a\\free.txt"];

  it("applies one choice to everything", () => {
    expect(planTransfer(sources, conflicts, new Map(), "skip")).toEqual({ keepBoth: ["C:\\a\\free.txt"], replace: [], skipped: ["C:\\a\\x.txt", "C:\\a\\y.txt", "C:\\a\\dir"] });
  });

  it("replaces only newer items with 'newer'", () => {
    const p = planTransfer(sources, conflicts, new Map(), "newer");
    expect(p.replace).toEqual(["C:\\a\\x.txt"]);
    expect(p.skipped).toEqual(["C:\\a\\y.txt", "C:\\a\\dir"]);
  });

  it("keeps both when a folder would replace a file", () => {
    const p = planTransfer(sources, conflicts, new Map(), "replace");
    expect(p.replace).toEqual(["C:\\a\\x.txt", "C:\\a\\y.txt"]);
    expect(p.keepBoth).toEqual(["C:\\a\\dir", "C:\\a\\free.txt"]);
  });

  it("lets per-item choices override the fallback, case-insensitively", () => {
    const p = planTransfer(sources, conflicts, new Map([["c:\\a\\y.txt", "replace"]]), "skip");
    expect(p.replace).toEqual(["C:\\a\\y.txt"]);
  });
});

describe("classifyTarget", () => {
  it("maps known shell folders and This PC", () => {
    expect(classifyTarget("shell:Downloads")).toEqual({ kind: "known", id: "downloads" });
    expect(classifyTarget("shell:Personal\\")).toEqual({ kind: "known", id: "documents" });
    expect(classifyTarget(THIS_PC.toUpperCase())).toEqual({ kind: "known", id: "start" });
  });

  it("sends other shell locations to Explorer and keeps real paths", () => {
    expect(classifyTarget("shell:ControlPanelFolder")).toEqual({ kind: "explorer", arg: "shell:ControlPanelFolder" });
    expect(classifyTarget("::{21EC2020-3AEA-1069-A2DD-08002B30309D}").kind).toBe("explorer");
    expect(classifyTarget("D:\\Photos")).toEqual({ kind: "path", path: "D:\\Photos" });
  });
});

describe("extrasToRemove", () => {
  const groups = [{ files: [["new", 3], ["mid", 2], ["old", 1]] as [string, number][] }, { files: [["a", 2], ["b", 1]] as [string, number][] }];
  it("keeps exactly one copy per group", () => {
    expect([...extrasToRemove(groups, "newest")]).toEqual(["mid", "old", "b"]);
    expect([...extrasToRemove(groups, "oldest")]).toEqual(["new", "mid", "a"]);
  });
});

describe("saved searches", () => {
  it("keeps only well-formed entries", () => {
    expect(parseSavedSearches([{ name: "PDFs", root: "D:\\", query: "ext:pdf" }, { name: "", root: "x", query: "" }, { name: "a" }, 7])).toEqual([{ name: "PDFs", root: "D:\\", query: "ext:pdf" }]);
    expect(parseSavedSearches("nope")).toEqual([]);
  });
});

describe("selection summary", () => {
  it("totals sizes, counts kinds and dates, and tracks unmeasured folders", () => {
    const s = summarize([
      { name: "a.jpg", dir: false, size: 100, modified: 2000 },
      { name: "b.png", dir: false, size: 50, modified: 1000 },
      { name: "src", dir: true, size: undefined, modified: 3000 },
      { name: "c.rs", dir: false, size: 10, modified: 0 },
    ]);
    expect(s).toMatchObject({ count: 4, files: 3, folders: 1, bytes: 160, unsized: 1, oldest: 1000, newest: 3000 });
    expect(s.kinds[0]).toEqual(["image", 2]);
  });
});

describe("folder views", () => {
  const grid = { mode: "grid" as const, sort: { key: "modified" as const, dir: -1 as const } };
  it("remembers per folder, case- and slash-insensitively, newest first", () => {
    let all = rememberView([], "D:\\Photos\\", grid);
    all = rememberView(all, "C:\\x", { mode: "details", sort: { key: "name", dir: 1 } });
    expect(viewFor(all, "d:\\photos")).toEqual(grid);
    expect(all[0][0]).toBe("c:\\x");
    expect(viewFor(all, "E:\\none")).toBeNull();
  });

  it("forgets the oldest past the limit and drops damaged entries", () => {
    let all = rememberView([], "A:\\1", grid, 2);
    all = rememberView(all, "A:\\2", grid, 2);
    all = rememberView(all, "A:\\3", grid, 2);
    expect(all.map(([k]) => k)).toEqual(["a:\\3", "a:\\2"]);
    expect(parseFolderViews([["a", grid], ["b", { mode: "huge", sort: grid.sort }], "junk"])).toEqual([["a", grid]]);
  });
});

describe("contentTerm", () => {
  it("pulls the content: term out of a search", () => {
    expect(contentTerm('report content:"connection refused" ext:log')).toBe("connection refused");
    expect(contentTerm("content:TODO")).toBe("TODO");
    expect(contentTerm("todo.txt")).toBeNull();
    expect(contentTerm("content:")).toBeNull();
  });
});

describe("cloudState", () => {
  it("reads OneDrive placeholder attributes", () => {
    expect(cloudState(0x400000 | 0x20)).toBe("online");
    expect(cloudState(0x1000)).toBe("online");
    expect(cloudState(0x80000)).toBe("pinned");
    expect(cloudState(0x100000)).toBe("local");
    expect(cloudState(0x20)).toBeNull();
  });
});

describe("compareListings", () => {
  const listing = (path: string, items: [string, number, number, boolean?][]) => ({
    path,
    count: items.length,
    names: items.map((i) => i[0]),
    sizes: items.map((i) => i[1]),
    mtimes: items.map((i) => i[2]),
    kinds: items.map((i) => (i[3] ? 1 : 0)),
    attrs: items.map(() => 0),
  });
  it("marks items only here, newer, older, differing or the same", () => {
    const a = listing("C:\a", [["new.txt", 5, 10_000], ["old.txt", 5, 1_000], ["same.txt", 5, 5_000], ["Size.txt", 9, 5_000], ["mine.txt", 1, 0], ["dir", 0, 0, true]]);
    const b = listing("D:\b", [["new.txt", 5, 1_000], ["old.txt", 5, 10_000], ["same.txt", 5, 6_000], ["size.TXT", 3, 5_000], ["dir", 0, 99_999, true]]);
    const m = compareListings(a, b);
    expect(Object.fromEntries(m)).toEqual({ "new.txt": "newer", "old.txt": "older", "same.txt": "same", "size.txt": "differs", "mine.txt": "only", dir: "same" });
    expect(countStatuses(m).only).toBe(1);
    expect(["only", "newer", "differs", "older", "same"].map((s) => isDifference(s as never))).toEqual([true, true, true, false, false]);
  });
});

describe("columns", () => {
  it("drops Type, then the date, as panes get narrow", () => {
    expect(visibleColumns(["modified", "type", "size"], 900, false)).toEqual(["modified", "type", "size"]);
    expect(visibleColumns(["modified", "type", "size"], 600, false)).toEqual(["modified", "size"]);
    expect(visibleColumns(["modified", "type", "size", "extension"], 400, true)).toEqual(["size"]);
    expect(visibleColumns(["size", "bogus"], 900, true)).toEqual(["size", "commit"]);
  });

  it("builds the grid template with clamped widths", () => {
    expect(gridTemplate(["modified", "size"], { size: 5 })).toBe("minmax(160px, 1fr) 140px 56px");
    expect(gridTemplate([], {})).toBe("minmax(160px, 1fr)");
  });

  it("toggles and reorders columns while preserving custom order", () => {
    expect(toggleColumn(["size", "modified"], "type")).toEqual(["size", "modified", "type"]);
    expect(toggleColumn(["modified", "type"], "type")).toEqual(["modified"]);
    expect(moveColumn(["modified", "type", "size"], "size", "modified", "before")).toEqual(["size", "modified", "type"]);
    expect(moveColumn(["modified", "type", "size"], "modified", "size", "after")).toEqual(["type", "size", "modified"]);
    expect(stepColumn(["modified", "type", "size"], "type", -1)).toEqual(["type", "modified", "size"]);
    expect(stepColumn(["modified", "type", "size"], "size", 1)).toEqual(["modified", "type", "size"]);
    expect(attributeLetters(0x1 | 0x2 | 0x20)).toBe("RHA");
  });
});

describe("marquee selection", () => {
  it("finds rows a band touches, in either drag direction", () => {
    expect(rowsInBand(100, 20, 30, 75)).toEqual([1, 3]);
    expect(rowsInBand(100, 20, 75, 30)).toEqual([1, 3]);
    expect(rowsInBand(3, 20, 50, 500)).toEqual([2, 2]);
    expect(rowsInBand(3, 20, 200, 300)).toBeNull();
  });

  it("finds grid cells a rectangle touches", () => {
    // 4 columns of 100x100; box from (150, 50) to (260, 160) covers columns 1-2 of rows 0-1.
    expect(cellsInRect(10, 4, 100, 100, 150, 50, 260, 160)).toEqual([1, 2, 5, 6]);
    expect(cellsInRect(6, 4, 100, 100, 150, 150, 390, 199)).toEqual([5]);
  });

  it("adds boxed entries to the base selection", () => {
    const view = Uint32Array.from([7, 8, 9]);
    expect([...marqueeSelection(view, new Set([1]), [0, 2])]).toEqual([1, 7, 9]);
  });
});

describe("selection helpers", () => {
  const names = ["a.jpg", "b.PNG", "notes.txt", "IMG_0001.jpg", ".gitignore", "sub\\deep.jpg"];
  const view = Uint32Array.from([0, 1, 2, 3, 4, 5]);

  it("inverts against the visible entries", () => {
    expect([...invertSelection(view, new Set([0, 2]))]).toEqual([1, 3, 4, 5]);
  });

  it("reads extensions case-insensitively and ignores dotfiles", () => {
    expect(extensionOf("b.PNG")).toBe("png");
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("folder.v2\\file")).toBe("");
  });

  it("matches wildcard patterns against the base name", () => {
    expect([...selectWhere(view, names, namePattern("*.jpg"))]).toEqual([0, 3, 5]);
    expect([...selectWhere(view, names, namePattern("*.png; IMG_????.*"))]).toEqual([1, 3]);
  });

  it("treats plain text as 'contains'", () => {
    expect([...selectWhere(view, names, namePattern("note"))]).toEqual([2]);
  });

  it("supports re: patterns and rejects bad ones", () => {
    expect([...selectWhere(view, names, namePattern("re:^img_\\d+"))]).toEqual([3]);
    expect(() => namePattern("re:(")).toThrow();
  });

  it("matches nothing for an empty pattern", () => {
    expect(selectWhere(view, names, namePattern("  ")).size).toBe(0);
  });
});
