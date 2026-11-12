import { describe, expect, it } from "vitest";
import { groupOf, groupStarts } from "./group";
import { KIND_DIR, KIND_FILE, type Listing } from "./listing";
import { buildView, DEFAULT_SORT } from "./sort";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();

function listing(items: [name: string, dir: boolean, size: number, mtime: number][]): Listing {
  return {
    path: "C:/x",
    names: items.map((i) => i[0]),
    kinds: items.map((i) => (i[1] ? KIND_DIR : KIND_FILE)),
    sizes: items.map((i) => i[2]),
    mtimes: items.map((i) => i[3]),
    attrs: items.map(() => 0),
    count: items.length,
  } as unknown as Listing;
}

describe("group by", () => {
  const l = listing([
    ["notes.txt", false, 100, NOW - 3 * DAY],
    ["photo.png", false, 5_000_000, NOW - 1000],
    ["src", true, 0, NOW],
    ["song.mp3", false, 4_000_000, NOW - 40 * DAY],
    ["empty.log", false, 0, NOW - 2 * DAY],
  ]);

  it("puts folders first and files by type order", () => {
    const view = buildView(l, { sort: DEFAULT_SORT, showHidden: true, group: "type" });
    expect([...view].map((i) => l.names[i])).toEqual(["src", "notes.txt", "photo.png", "song.mp3", "empty.log"]);
  });

  it("labels date buckets newest first", () => {
    expect(groupOf(l, 1, "modified", NOW).label).toBe("Today");
    expect(groupOf(l, 4, "modified", NOW).label).toBe("Earlier this week");
    expect(groupOf(l, 3, "modified", NOW).label).toBe("Earlier this year");
  });

  it("buckets sizes and first letters", () => {
    expect(groupOf(l, 4, "size", NOW).label).toBe("Empty");
    expect(groupOf(l, 0, "size", NOW).label).toBe("Tiny (under 10 KB)");
    expect(groupOf(l, 1, "size", NOW).label).toBe("Medium (under 100 MB)");
    expect(groupOf(l, 0, "name", NOW).label).toBe("N");
  });

  it("finds where each group starts with its count", () => {
    const view = buildView(l, { sort: DEFAULT_SORT, showHidden: true, group: "type" });
    const starts = groupStarts(l, view, "type", NOW);
    expect([...starts.entries()].map(([pos, g]) => [pos, g.label, g.count])).toEqual([
      [0, "Folders", 1],
      [1, "Documents", 1],
      [2, "Pictures", 1],
      [3, "Music", 1],
      [4, "Other files", 1],
    ]);
    expect(groupStarts(l, view, "none", NOW).size).toBe(0);
  });
});
