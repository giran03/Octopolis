import { describe, expect, it } from "vitest";
import { moveFocus, selectAll, selectAt, typeAhead } from "./selection";

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
  });

  it("extends a longer prefix from the current item", () => {
    expect(typeAhead(names, view, 0, "alpi")).toBe(4);
    expect(typeAhead(names, view, 0, "zzz")).toBe(-1);
  });
});
