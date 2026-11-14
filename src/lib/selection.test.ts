import { describe, expect, it } from "vitest";
import {
  EMPTY_TYPE_AHEAD,
  entryPattern,
  moveFocus,
  nextTypeAhead,
  selectAll,
  selectAt,
  selectEntriesWhere,
  typeAhead,
  typeAheadMatchInfo,
} from "./selection";

const view = Uint32Array.from([10, 11, 12, 13, 14]);
const none = { ctrl: false, shift: false };

describe("selectAt", () => {
  it("plain click selects one item and moves the anchor", () => {
    const r = selectAt(view, new Set([10, 11]), 0, 3, none);
    expect([...r.selection]).toEqual([13]);
    expect(r.anchor).toBe(3);
  });

  it("ctrl-click toggles items", () => {
    const on = selectAt(view, new Set([10]), 0, 2, { ctrl: true, shift: false });
    expect([...on.selection].sort()).toEqual([10, 12]);
    const off = selectAt(view, on.selection, 2, 0, { ctrl: true, shift: false });
    expect([...off.selection]).toEqual([12]);
  });

  it("shift-click selects a range from the anchor in either direction", () => {
    expect([...selectAt(view, new Set(), 1, 3, { ctrl: false, shift: true }).selection]).toEqual([11, 12, 13]);
    expect([...selectAt(view, new Set(), 3, 1, { ctrl: false, shift: true }).selection].sort()).toEqual([11, 12, 13]);
  });

  it("ctrl+shift adds a range to the existing selection", () => {
    const r = selectAt(view, new Set([14]), 0, 1, { ctrl: true, shift: true });
    expect([...r.selection].sort()).toEqual([10, 11, 14]);
    expect(r.anchor).toBe(0);
  });

  it("ignores out-of-range positions", () => {
    const cur = new Set([10]);
    expect(selectAt(view, cur, 0, 9, none).selection).toBe(cur);
  });

  it("selects everything", () => {
    expect(selectAll(view).size).toBe(5);
  });
});

describe("moveFocus", () => {
  it("clamps and pages", () => {
    expect(moveFocus(5, 0, "ArrowUp", 10)).toBe(0);
    expect(moveFocus(5, 4, "ArrowDown", 10)).toBe(4);
    expect(moveFocus(100, 10, "PageDown", 11)).toBe(20);
    expect(moveFocus(100, 10, "PageUp", 11)).toBe(0);
    expect(moveFocus(100, 10, "End", 11)).toBe(99);
    expect(moveFocus(0, 0, "End", 11)).toBe(0);
  });
});

describe("typeAhead", () => {
  const names: string[] = [];
  names[10] = "alpha";
  names[11] = "beta";
  names[12] = "Bravo";
  names[13] = "charlie";
  names[14] = "ALPINE";

  it("cycles through single-letter matches", () => {
    expect(typeAhead(names, view, 1, "b")).toBe(2);
    expect(typeAhead(names, view, 2, "b")).toBe(1);
    expect(typeAhead(names, view, -1, "b")).toBe(1);
    expect(typeAhead(names, new Uint32Array(0), 0, "b")).toBe(-1);
  });

  it("extends a longer prefix from the current item", () => {
    expect(typeAhead(names, view, 0, "alpi")).toBe(4);
    expect(typeAhead(names, view, -1, "alpi")).toBe(4);
    expect(typeAhead(names, view, 0, "zzz")).toBe(-1);
  });

  it("matches basenames in flat search results", () => {
    const searchNames: string[] = [];
    searchNames[10] = "src\\Games";
    searchNames[11] = "docs\\Git";
    searchNames[12] = "other\\Notes";
    const subView = Uint32Array.from([10, 11, 12]);
    expect(typeAhead(searchNames, subView, -1, "g")).toBe(0);
    expect(typeAhead(searchNames, subView, 0, "g")).toBe(1);
    expect(typeAhead(searchNames, subView, 1, "g")).toBe(0);
  });

  it("keeps a single-letter prefix when the same letter is pressed repeatedly", () => {
    let s = nextTypeAhead(EMPTY_TYPE_AHEAD, "g", 100, 900, "1:C:\\")!;
    expect(s.prefix).toBe("g");
    s = nextTypeAhead(s, "G", 250, 900, "1:C:\\")!;
    expect(s.prefix).toBe("G");
    s = nextTypeAhead(s, "g", 400, 900, "1:C:\\")!;
    expect(s.prefix).toBe("g");

    // A different letter extends the prefix; timeout or folder change resets it.
    s = nextTypeAhead(s, "i", 500, 900, "1:C:\\")!;
    expect(s.prefix).toBe("gi");
    s = nextTypeAhead(s, "a", 550, 900, "1:D:\\")!;
    expect(s.prefix).toBe("a");
    s = nextTypeAhead(s, "b", 2000, 900, "1:D:\\")!;
    expect(s.prefix).toBe("b");
    expect(nextTypeAhead(EMPTY_TYPE_AHEAD, " ", 100, 900, "1:D:\\")).toBeNull();
  });

  it("reports 1-based match index and total count", () => {
    expect(typeAheadMatchInfo(names, view, 0, "a")).toEqual({ index: 1, total: 2 });
    expect(typeAheadMatchInfo(names, view, 4, "a")).toEqual({ index: 2, total: 2 });
    expect(typeAheadMatchInfo(names, view, -1, "zzz")).toEqual({ index: 0, total: 0 });
  });
});

describe("entryPattern", () => {
  const names: string[] = [];
  const dirs: boolean[] = [];
  names[10] = "photo.png";
  dirs[10] = false;
  names[11] = "Assets";
  dirs[11] = true;
  names[12] = "notes.txt";
  dirs[12] = false;
  names[13] = "sub\\icon.PNG";
  dirs[13] = false;
  names[14] = "Builds";
  dirs[14] = true;

  it("matches globs case-insensitively on the basename", () => {
    const match = entryPattern("*.png");
    expect([...selectEntriesWhere(view, (e) => match(names[e], dirs[e]))]).toEqual([10, 13]);
  });

  it("matches type:dir, type:file, and combined patterns", () => {
    const onlyDirs = entryPattern("type:dir");
    expect([...selectEntriesWhere(view, (e) => onlyDirs(names[e], dirs[e]))]).toEqual([11, 14]);
    const onlyFiles = entryPattern("type:file");
    expect([...selectEntriesWhere(view, (e) => onlyFiles(names[e], dirs[e]))]).toEqual([10, 12, 13]);
    const combined = entryPattern("type:dir; *.txt");
    expect([...selectEntriesWhere(view, (e) => combined(names[e], dirs[e]))]).toEqual([11, 12, 14]);
  });

  it("supports re: regular expressions", () => {
    const match = entryPattern("re:^(photo|notes)");
    expect([...selectEntriesWhere(view, (e) => match(names[e], dirs[e]))]).toEqual([10, 12]);
  });
});
