import { describe, expect, it } from "vitest";
import { compareVersions, whatsNewText } from "./whatsNew";

const MD = `# Changelog

## [0.1.2] - 2026-12-01

- three

## [0.1.1] - 2026-11-14

- two

## [0.1.0] - 2026-11-13

- one
`;

describe("whatsNew", () => {
  it("compares versions", () => {
    expect(compareVersions("0.1.0", "0.1.1")).toBeLessThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
  it("shows only the current release when the last seen version is unknown", () => {
    const t = whatsNewText(MD, "", "0.1.1")!;
    expect(t).toContain("[0.1.1]");
    expect(t).not.toContain("[0.1.2]");
    expect(t).not.toContain("[0.1.0]");
  });
  it("shows every release since the last seen one", () => {
    const t = whatsNewText(MD, "0.1.0", "0.1.2")!;
    expect(t).toContain("[0.1.2]");
    expect(t).toContain("[0.1.1]");
    expect(t).not.toContain("[0.1.0]");
  });
  it("shows nothing when up to date or downgraded", () => {
    expect(whatsNewText(MD, "0.1.1", "0.1.1")).toBeNull();
    expect(whatsNewText(MD, "0.1.2", "0.1.1")).toBeNull();
  });
  it("shows nothing when the current version has no entry", () => {
    expect(whatsNewText(MD, "", "9.9.9")).toBeNull();
  });
});
