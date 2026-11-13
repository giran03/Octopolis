import { describe, expect, it } from "vitest";
import { computeLayout, edgeSplit, leaf, leaves, paneTotal, removePane, splitPane } from "./layout";

describe("splitting along an edge", () => {
  it("maps each edge to a direction and side", () => {
    expect(edgeSplit("left")).toEqual({ dir: "row", before: true });
    expect(edgeSplit("right")).toEqual({ dir: "row", before: false });
    expect(edgeSplit("top")).toEqual({ dir: "column", before: true });
    expect(edgeSplit("bottom")).toEqual({ dir: "column", before: false });
  });

  it("puts the new pane before or after the target", () => {
    expect(leaves(splitPane(leaf("a"), "a", "b", "row", true))).toEqual(["b", "a"]);
    expect(leaves(splitPane(leaf("a"), "a", "b", "row", false))).toEqual(["a", "b"]);
  });

  it("adds a sibling in the same direction, on the requested side", () => {
    const two = splitPane(leaf("a"), "a", "b", "row");
    const left = splitPane(two, "b", "c", "row", true);
    expect(leaves(left)).toEqual(["a", "c", "b"]);
    expect(left.kind === "split" && left.sizes).toEqual([0.5, 0.25, 0.25]);
    const right = splitPane(two, "a", "c", "row", false);
    expect(leaves(right)).toEqual(["a", "c", "b"]);
  });

  it("builds a four-pane grid from repeated edge drops", () => {
    let tree = splitPane(leaf("a"), "a", "b", "row"); // a | b
    tree = splitPane(tree, "a", "c", "column"); // a over c, then b
    tree = splitPane(tree, "b", "d", "column", true); // d over b
    expect(paneTotal(tree)).toBe(4);
    expect(leaves(tree).sort()).toEqual(["a", "b", "c", "d"]);
    expect(tree.kind === "split" && tree.dir).toBe("row");
    const col = tree.kind === "split" ? tree.children[1] : null;
    expect(col?.kind === "split" && col.dir).toBe("column");
    expect(col?.kind === "split" && leaves(col)).toEqual(["d", "b"]);
  });
});

describe("computing pane rectangles", () => {
  it("fills the area with one pane", () => {
    const { panes, dividers } = computeLayout(leaf("a"));
    expect(panes.get("a")).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(dividers).toEqual([]);
  });

  it("places a grid and its dividers", () => {
    let tree = splitPane(leaf("a"), "a", "b", "row"); // a | b
    tree = splitPane(tree, "b", "c", "column"); // b over c
    const { panes, dividers } = computeLayout(tree);
    expect(panes.get("a")).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(panes.get("b")).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(panes.get("c")).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(dividers.map((d) => [d.dir, d.path.length, d.line.x, d.line.y, d.line.w, d.line.h])).toEqual([
      ["row", 0, 0.5, 0, 0, 1],
      ["column", 1, 0.5, 0.5, 0.5, 0],
    ]);
  });

  it("closing a pane shares its space between the others in proportion", () => {
    let tree = splitPane(leaf("a"), "a", "b", "row");
    tree = splitPane(tree, "b", "c", "row");
    expect(computeLayout(tree).panes.get("a")?.w).toBe(0.5);
    const after = computeLayout(removePane(tree, "c")!).panes;
    expect(after.get("a")?.w).toBeCloseTo(2 / 3);
    expect(after.get("b")?.x).toBeCloseTo(2 / 3);
    expect(after.get("b")?.w).toBeCloseTo(1 / 3);
  });
});
