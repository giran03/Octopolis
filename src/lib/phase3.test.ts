import { describe, expect, it } from "vitest";
import { DEFAULT_SPEC, nameProblem, planRenames, renderAll, renderName, type RenameItem } from "./rename";
import { EMPTY_STACKS, popRedo, popUndo, pushAction, redoStep, undoStep, type UndoAction } from "./undo";
import { squarify } from "./treemap";
import { boundsOf, parseObj, parseStl } from "./model3d";

const item = (name: string, tags = {}, isDir = false): RenameItem => ({ name, isDir, modifiedMs: new Date(2024, 4, 9, 13, 5).getTime(), tags });

describe("batch rename templates", () => {
  it("renders name, extension and padded numbers", () => {
    const spec = { ...DEFAULT_SPEC, template: "IMG_{n:3}{ext}", start: 7 };
    expect(renderAll(spec, [item("a.JPG"), item("b.png")])).toEqual(["IMG_007.JPG", "IMG_008.png"]);
  });

  it("uses dates and metadata tags, blank when a tag is missing", () => {
    expect(renderName({ ...DEFAULT_SPEC, template: "{date} {name}{ext}" }, item("x.txt"), 0)).toBe("2024-05-09 x.txt");
    expect(renderName({ ...DEFAULT_SPEC, template: "{date:YYYYMMDD_HHmm}{ext}" }, item("x.txt"), 0)).toBe("20240509_1305.txt");
    expect(renderName({ ...DEFAULT_SPEC, template: "{id3:artist} - {id3:title}{ext}" }, item("t.mp3", { "id3:artist": "A", "id3:title": "B" }), 0)).toBe("A - B.mp3");
    expect(renderName({ ...DEFAULT_SPEC, template: "[{exif:camera}]{ext}" }, item("t.jpg"), 0)).toBe("[].jpg");
  });

  it("find and replace, plain and with regex capture groups", () => {
    expect(renderName({ ...DEFAULT_SPEC, find: "old", replace: "new" }, item("old_old.txt"), 0)).toBe("new_new.txt");
    expect(renderName({ ...DEFAULT_SPEC, find: "(\\d+)-(\\d+)", replace: "$2_$1", regex: true }, item("12-34.txt"), 0)).toBe("34_12.txt");
    expect(() => renderName({ ...DEFAULT_SPEC, find: "(", regex: true }, item("x"), 0)).toThrow();
  });

  it("changes case", () => {
    expect(renderName({ ...DEFAULT_SPEC, caseMode: "upper" }, item("ab.txt"), 0)).toBe("AB.TXT");
    expect(renderName({ ...DEFAULT_SPEC, caseMode: "title" }, item("hello big-world.txt"), 0)).toBe("Hello Big-World.Txt");
  });

  it("folders have no extension", () => {
    expect(renderName({ ...DEFAULT_SPEC, template: "{name}_x{ext}" }, item("v1.2", {}, true), 0)).toBe("v1.2_x");
  });

  it("flags conflicts, invalid names and allows swaps", () => {
    const items = [item("a"), item("b"), item("c")];
    const existing = new Set(["a", "b", "c", "taken"]);
    const rows = planRenames(items, ["b", "a", "taken"], existing);
    expect(rows.map((r) => r.status)).toEqual(["ok", "ok", "conflict"]);
    expect(planRenames(items, ["same", "SAME", "c"], existing).map((r) => r.status)).toEqual(["conflict", "conflict", "unchanged"]);
    expect(planRenames([item("a")], ["bad:name"], new Set(["a"]))[0].status).toBe("invalid");
    expect(nameProblem("nul.txt")).toMatch(/Reserved/);
    expect(nameProblem("fine.txt")).toBeNull();
  });
});

describe("undo model", () => {
  const move: UndoAction = { kind: "move", label: "Move", pairs: [["C:\\a\\x", "C:\\b\\x"]] };

  it("reverses and repeats each action", () => {
    expect(undoStep(move)).toEqual({ type: "relocate", pairs: [["C:\\b\\x", "C:\\a\\x"]] });
    expect(redoStep(move)).toEqual({ type: "relocate", pairs: move.kind === "move" ? move.pairs : [] });
    const copy: UndoAction = { kind: "copy", label: "Copy", pairs: [["C:\\a\\x", "C:\\b\\x"]] };
    expect(undoStep(copy)).toEqual({ type: "recycle", paths: ["C:\\b\\x"] });
    expect(redoStep(copy)).toEqual({ type: "copy", sources: ["C:\\a\\x"], dest: "C:\\b" });
    expect(redoStep({ kind: "copy", label: "", pairs: [["D:\\x", "C:\\x"]] })).toEqual({ type: "copy", sources: ["D:\\x"], dest: "C:\\" });
    expect(undoStep({ kind: "recycle", label: "", paths: ["C:\\f"] })).toEqual({ type: "restore", paths: ["C:\\f"] });
    expect(undoStep({ kind: "newFolder", label: "", path: "C:\\n" })).toEqual({ type: "removeEmpty", path: "C:\\n" });
  });

  it("walks the stacks and clears redo on a new action", () => {
    let s = pushAction(EMPTY_STACKS, move);
    const u = popUndo(s)!;
    expect(u.action).toBe(move);
    s = u.stacks;
    expect(s.done).toHaveLength(0);
    const r = popRedo(s)!;
    s = r.stacks;
    expect(s.done).toEqual([move]);
    s = popUndo(s)!.stacks;
    s = pushAction(s, { kind: "newFolder", label: "", path: "x" });
    expect(s.undone).toHaveLength(0);
    expect(popUndo(EMPTY_STACKS)).toBeNull();
    expect(popRedo(EMPTY_STACKS)).toBeNull();
  });
});

describe("treemap", () => {
  it("fills the box with areas proportional to values", () => {
    const tiles = squarify([6, 6, 4, 3, 2, 2, 1, 0], (v) => v, { x: 0, y: 0, w: 600, h: 400 });
    expect(tiles).toHaveLength(7);
    const total = tiles.reduce((s, t) => s + t.w * t.h, 0);
    expect(total).toBeCloseTo(240000, 3);
    const big = tiles.find((t) => t.item === 6)!;
    const small = tiles.find((t) => t.item === 1)!;
    expect((big.w * big.h) / (small.w * small.h)).toBeCloseTo(6, 3);
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(-1e-6);
      expect(t.x + t.w).toBeLessThanOrEqual(600 + 1e-6);
      expect(t.y + t.h).toBeLessThanOrEqual(400 + 1e-6);
    }
  });

  it("returns nothing for an empty or zero-sized input", () => {
    expect(squarify([0, 0], (v) => v, { x: 0, y: 0, w: 10, h: 10 })).toEqual([]);
    expect(squarify([1], (v) => v, { x: 0, y: 0, w: 0, h: 10 })).toEqual([]);
  });
});

describe("3D models", () => {
  it("parses OBJ polygons, negative indices and v/vt/vn faces", () => {
    const m = parseObj("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1/1/1 2/2/2 3/3/3 4/4/4\nf -1 -2 -3\n");
    expect(m.triangles).toBe(3);
    expect(Array.from(m.positions.slice(0, 3))).toEqual([0, 0, 0]);
    expect(() => parseObj("f 1 2 3")).toThrow(/missing vertex/);
  });

  it("parses binary and ASCII STL", () => {
    const buf = new ArrayBuffer(84 + 50);
    const v = new DataView(buf);
    v.setUint32(80, 1, true);
    v.setFloat32(84 + 12 + 12, 5, true); // second vertex x
    const bin = parseStl(buf);
    expect(bin.triangles).toBe(1);
    expect(bin.positions[3]).toBe(5);

    const ascii = new TextEncoder().encode("solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 2 0 0\nvertex 0 2 0\nendloop\nendfacet\nendsolid x");
    const m = parseStl(ascii.buffer as ArrayBuffer);
    expect(m.triangles).toBe(1);
    expect(boundsOf(m).center).toEqual([1, 1, 0]);
  });
});
