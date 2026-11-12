import { describe, expect, it } from "vitest";
import { appIconSvg } from "./appIcon";

describe("appIconSvg", () => {
  const svg = appIconSvg({ bg: "#1a1611", tiles: "#ece3d4", hub: "#e0a458" });

  it("uses the theme colors for the tile, the blocks and the hub", () => {
    expect(svg).toContain('fill="#1a1611"');
    expect(svg).toContain('fill="#ece3d4"');
    expect(svg).toContain('fill="#e0a458"');
  });

  it("draws eight blocks", () => {
    const d = /<path fill="#ece3d4" d="([^"]+)"/.exec(svg)![1];
    expect(d.match(/Z/g)).toHaveLength(8);
  });
});
