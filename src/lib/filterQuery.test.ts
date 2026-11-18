import { describe, expect, it } from "vitest";
import { matchesFilter, parseFilter, parseSize } from "./filterQuery";

const NOW = new Date(2026, 10, 18, 15, 0).getTime();
const file = (o: Partial<{ name: string; size: number; mtime: number; ext: string }> = {}) => ({ name: "a.png", dir: false, size: 100, mtime: NOW, ext: "png", ...o });

describe("filter query", () => {
  it("reads sizes", () => {
    expect(parseSize("10mb")).toBe(10 * 1024 ** 2);
    expect(parseSize("1.5k")).toBe(1536);
    expect(parseSize("abc")).toBeNull();
  });
  it("keeps plain text as a name match", () => {
    const q = parseFilter("holiday photos");
    expect(q.text).toBe("holiday photos");
    expect(matchesFilter(q, file({ name: "my holiday photos.png" }))).toBe(true);
  });
  it("filters by extension list", () => {
    const q = parseFilter("ext:png,.jpg");
    expect(matchesFilter(q, file({ ext: "jpg" }))).toBe(true);
    expect(matchesFilter(q, file({ ext: "txt" }))).toBe(false);
  });
  it("filters by size", () => {
    expect(matchesFilter(parseFilter("size:>1kb"), file({ size: 2048 }))).toBe(true);
    expect(matchesFilter(parseFilter("size:>1kb"), file({ size: 10 }))).toBe(false);
    expect(matchesFilter(parseFilter("size:<1kb"), file({ size: 10 }))).toBe(true);
  });
  it("filters by when it changed", () => {
    const q = parseFilter("modified:today", NOW);
    expect(matchesFilter(q, file({ mtime: NOW - 3_600_000 }))).toBe(true);
    expect(matchesFilter(q, file({ mtime: NOW - 3 * 86_400_000 }))).toBe(false);
  });
  it("filters folders and files", () => {
    expect(matchesFilter(parseFilter("type:folder"), { ...file(), dir: true })).toBe(true);
    expect(matchesFilter(parseFilter("type:folder"), file())).toBe(false);
  });
  it("leaves unknown operators in the text", () => {
    expect(parseFilter("size:big").text).toBe("size:big");
  });
});
