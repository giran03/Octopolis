import { describe, expect, it } from "vitest";
import { fuzzyMatch, fuzzyRank } from "./fuzzy";
import { frecencyScore, recordVisit, topVisits, forget, MAX_TOTAL_RANK, type FrecencyDb } from "./frecency";
import { ChordMatcher, eventToKey, formatKeys } from "./keymap";

describe("fuzzyMatch", () => {
  it("requires characters in order", () => {
    expect(fuzzyMatch("dls", "Downloads")).not.toBeNull();
    expect(fuzzyMatch("sld", "Downloads")).toBeNull();
  });

  it("prefers word starts and the last path segment", () => {
    const ranked = fuzzyRank("proj", ["C:\\projects-archive\\old\\notes", "D:\\work\\Projects"], (s) => s);
    expect(ranked[0].item).toBe("D:\\work\\Projects");
  });

  it("prefers consecutive matches", () => {
    const tight = fuzzyMatch("doc", "Documents")!.score;
    const loose = fuzzyMatch("doc", "Data of Cats")!.score;
    expect(tight).toBeGreaterThan(loose);
  });

  it("returns highlight positions", () => {
    expect(fuzzyMatch("dl", "Downloads")!.positions).toEqual([0, 4]);
  });

  it("an empty query matches everything with zero score", () => {
    expect(fuzzyMatch("  ", "x")).toEqual({ score: 0, positions: [] });
  });
});

describe("frecency", () => {
  const now = 1_000_000_000_000;

  it("ranks frequent and recent folders first", () => {
    let db: FrecencyDb = {};
    db = recordVisit(db, "C:\\old", now - 30 * 86_400_000);
    db = recordVisit(db, "C:\\old", now - 30 * 86_400_000);
    db = recordVisit(db, "C:\\New\\", now);
    const top = topVisits(db, now);
    expect(top[0].path).toBe("C:\\New\\");
    expect(top.map((t) => t.path)).toContain("C:\\old");
  });

  it("merges paths case-insensitively and ignores trailing slashes", () => {
    let db: FrecencyDb = recordVisit({}, "C:\\A\\", now);
    db = recordVisit(db, "c:\\a", now);
    expect(Object.keys(db)).toHaveLength(1);
    expect(Object.values(db)[0].rank).toBe(2);
  });

  it("decays with age", () => {
    const v = { rank: 10, last: now };
    expect(frecencyScore(v, now + 1000)).toBeGreaterThan(frecencyScore(v, now + 10 * 86_400_000));
  });

  it("ages everything once the total grows too large, dropping faded entries", () => {
    let db: FrecencyDb = { "c:\\faded": { rank: 1, last: now }, "c:\\busy": { rank: MAX_TOTAL_RANK, last: now } };
    db = recordVisit(db, "C:\\busy", now);
    expect(db["c:\\faded"]).toBeUndefined();
    expect(db["c:\\busy"].rank).toBeCloseTo((MAX_TOTAL_RANK + 1) * 0.9);
  });

  it("forgets entries", () => {
    expect(forget(recordVisit({}, "C:\\x", now), "c:\\X")).toEqual({});
  });
});

describe("keymap", () => {
  const ev = (key: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean }> = {}, code?: string) => ({
    key,
    code,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
  });

  it("normalizes events independent of keyboard layout case", () => {
    expect(eventToKey(ev("K", { ctrl: true, shift: true }, "KeyK"))).toBe("ctrl+shift+k");
    expect(eventToKey(ev("|", { ctrl: true, shift: true }, "Backslash"))).toBe("ctrl+shift+\\");
    expect(eventToKey(ev("ArrowUp", { alt: true }, "ArrowUp"))).toBe("alt+arrowup");
    expect(eventToKey(ev(" ", {}, "Space"))).toBe("space");
    expect(eventToKey(ev("Control", { ctrl: true }, "ControlLeft"))).toBeNull();
    expect(eventToKey(ev("G", { shift: true }, "KeyG"))).toBe("shift+g");
  });

  it("formats keys for display", () => {
    expect(formatKeys("ctrl+shift+p")).toBe("Ctrl+Shift+P");
    expect(formatKeys("ctrl+k ctrl+s")).toBe("Ctrl+K Ctrl+S");
    expect(formatKeys("alt+arrowup")).toBe("Alt+↑");
  });

  it("matches single keys and chords", () => {
    const m = new ChordMatcher([
      ["ctrl+t", "tab.new"],
      ["ctrl+k ctrl+s", "shortcuts"],
      ["g g", "top"],
    ]);
    expect(m.feed("ctrl+t")).toEqual({ type: "run", id: "tab.new" });
    expect(m.feed("ctrl+k")).toEqual({ type: "pending" });
    expect(m.feed("ctrl+s")).toEqual({ type: "run", id: "shortcuts" });
    expect(m.feed("g")).toEqual({ type: "pending" });
    expect(m.feed("g")).toEqual({ type: "run", id: "top" });
  });

  it("restarts a broken chord from its last key", () => {
    const m = new ChordMatcher([
      ["ctrl+k ctrl+s", "shortcuts"],
      ["ctrl+t", "tab.new"],
    ]);
    m.feed("ctrl+k");
    expect(m.feed("ctrl+t")).toEqual({ type: "run", id: "tab.new" });
    expect(m.feed("x")).toEqual({ type: "none" });
    expect(m.pending).toBe(false);
  });
});
