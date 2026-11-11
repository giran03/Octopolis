import { describe, expect, it } from "vitest";
import { clampInspectorWidth, DEFAULT_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH, MIN_INSPECTOR_WIDTH } from "./inspector";

describe("clampInspectorWidth", () => {
  it("clamps width within default minimum and maximum bounds", () => {
    expect(clampInspectorWidth(100)).toBe(MIN_INSPECTOR_WIDTH);
    expect(clampInspectorWidth(380.4)).toBe(380);
    expect(clampInspectorWidth(1200)).toBe(MAX_INSPECTOR_WIDTH);
  });

  it("respects smaller available workspace widths and rejects non-finite values", () => {
    expect(clampInspectorWidth(500, 420)).toBe(420);
    expect(clampInspectorWidth(500, 180)).toBe(MIN_INSPECTOR_WIDTH);
    expect(clampInspectorWidth(Number.NaN)).toBe(DEFAULT_INSPECTOR_WIDTH);
  });
});
