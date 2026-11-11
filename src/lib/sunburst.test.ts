import { describe, expect, it } from "vitest";
import type { SpaceNode } from "./ipc";
import { annularSectorPath, buildSunburstArcs, findSpaceTrail } from "./sunburst";

const sample: SpaceNode = {
  name: "X:",
  path: "X:\\",
  bytes: 1000,
  files: 40,
  cached: true,
  children: [
    {
      name: "_DEV",
      path: "X:\\_DEV",
      bytes: 700,
      files: 30,
      cached: false,
      children: [
        { name: "Vibe Projects", path: "X:\\_DEV\\Vibe Projects", bytes: 500, files: 20, cached: false, children: [] },
        { name: "Other", path: "", bytes: 200, files: 10, cached: false, children: [] },
      ],
    },
    { name: "_Games", path: "X:\\_Games", bytes: 300, files: 10, cached: true, children: [] },
  ],
};

describe("sunburst layout", () => {
  it("lays out proportional rings and labels for wide sectors", () => {
    const arcs = buildSunburstArcs(sample);
    const ring1 = arcs.filter((a) => a.depth === 1);
    expect(ring1.map((a) => a.node.name)).toEqual(["_DEV", "_Games"]);
    expect(ring1[0].endAngle - ring1[0].startAngle).toBeCloseTo(Math.PI * 2 * 0.7, 4);
    expect(ring1[1].endAngle - ring1[1].startAngle).toBeCloseTo(Math.PI * 2 * 0.3, 4);
    expect(ring1[0].showLabel).toBe(true);

    const ring2 = arcs.filter((a) => a.depth === 2);
    expect(ring2.map((a) => a.node.name)).toEqual(["Vibe Projects", "Other"]);
    expect(ring2[1].color).toBe("var(--surface-3)");
  });

  it("splits full 360-degree sectors cleanly without collapsing", () => {
    const single: SpaceNode = {
      name: "Root",
      path: "C:\\",
      bytes: 100,
      files: 1,
      cached: false,
      children: [{ name: "Only", path: "C:\\Only", bytes: 100, files: 1, cached: false, children: [] }],
    };
    const arcs = buildSunburstArcs(single);
    expect(arcs).toHaveLength(1);
    expect(arcs[0].pathD).toContain("A 112 112 0 1 1");
    expect(annularSectorPath(60, 112, 0, 0)).toBe("");
  });

  it("finds a nested zoom trail by path", () => {
    const trail = findSpaceTrail(sample, "x:\\_dev\\vibe projects");
    expect(trail.map((n) => n.name)).toEqual(["X:", "_DEV", "Vibe Projects"]);
  });
});
