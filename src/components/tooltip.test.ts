import { describe, expect, it } from "vitest";
import { isTooltipTruncated } from "./Tooltip";

function mockEl(opts: {
  attr?: string | null;
  scrollWidth?: number;
  clientWidth?: number;
  scrollHeight?: number;
  clientHeight?: number;
  children?: Array<{ scrollWidth?: number; clientWidth?: number; scrollHeight?: number; clientHeight?: number }>;
}) {
  return {
    getAttribute: (name: string) => (name === "data-tooltip-truncated" ? (opts.attr ?? null) : null),
    querySelectorAll: () => (opts.children ?? []) as unknown as NodeListOf<Element>,
    scrollWidth: opts.scrollWidth ?? 100,
    clientWidth: opts.clientWidth ?? 100,
    scrollHeight: opts.scrollHeight ?? 20,
    clientHeight: opts.clientHeight ?? 20,
  };
}

describe("isTooltipTruncated", () => {
  it("allows tooltips when truncation gating is absent or false", () => {
    expect(isTooltipTruncated(mockEl({ attr: null }))).toBe(true);
    expect(isTooltipTruncated(mockEl({ attr: "false" }))).toBe(true);
  });

  it("checks the element itself when data-tooltip-truncated is empty or true", () => {
    expect(isTooltipTruncated(mockEl({ attr: "", scrollWidth: 100, clientWidth: 100 }))).toBe(false);
    expect(isTooltipTruncated(mockEl({ attr: "", scrollWidth: 101, clientWidth: 100 }))).toBe(false);
    expect(isTooltipTruncated(mockEl({ attr: "", scrollWidth: 102, clientWidth: 100 }))).toBe(true);
    expect(isTooltipTruncated(mockEl({ attr: "true", scrollHeight: 24, clientHeight: 20 }))).toBe(true);
  });

  it("checks queried child nodes when a selector is given", () => {
    expect(
      isTooltipTruncated(
        mockEl({
          attr: ".side-label, .side-sub",
          children: [
            { scrollWidth: 80, clientWidth: 80 },
            { scrollWidth: 120, clientWidth: 120 },
          ],
        }),
      ),
    ).toBe(false);

    expect(
      isTooltipTruncated(
        mockEl({
          attr: ".side-label, .side-sub",
          children: [
            { scrollWidth: 80, clientWidth: 80 },
            { scrollWidth: 140, clientWidth: 120 },
          ],
        }),
      ),
    ).toBe(true);
  });
});
