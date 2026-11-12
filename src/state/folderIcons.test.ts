import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const { folderIcons, isEmoji, iconKey } = await import("./folderIcons");

describe("folder icons", () => {
  beforeEach(() => folderIcons.clear());

  it("recognises emoji and rejects plain text", () => {
    for (const ok of ["📁", "👩‍💻", "🇧🇷", "1️⃣", "❤️", "👍🏽"]) expect(isEmoji(ok)).toBe(true);
    for (const bad of ["", "a", "folder", "12", "<b>"]) expect(isEmoji(bad)).toBe(false);
  });

  it("matches paths case-insensitively and ignores trailing slashes", () => {
    folderIcons.set("C:\\Users\\Me\\Docs\\", "📚");
    expect(folderIcons.get("c:/users/me/docs")).toBe("📚");
    expect(iconKey("C:\\A\\")).toBe("c:\\a");
  });

  it("removes an icon and ignores non-emoji input", () => {
    folderIcons.set("C:\\A", "🎵");
    folderIcons.set("C:\\A", "oops");
    expect(folderIcons.get("C:\\A")).toBe("🎵");
    folderIcons.set("C:\\A", null);
    expect(folderIcons.get("C:\\A")).toBeUndefined();
  });

  it("follows a folder that is renamed, with its subfolders", () => {
    folderIcons.set("C:\\A", "🎵");
    folderIcons.set("C:\\A\\Sub", "🎸");
    folderIcons.set("C:\\AB", "🥁");
    folderIcons.move("C:\\A", "C:\\B");
    expect(folderIcons.get("C:\\B")).toBe("🎵");
    expect(folderIcons.get("C:\\B\\Sub")).toBe("🎸");
    expect(folderIcons.get("C:\\A")).toBeUndefined();
    expect(folderIcons.get("C:\\AB")).toBe("🥁");
  });

  it("persists to local storage and remembers recents", () => {
    folderIcons.set("C:\\A", "🎵");
    expect(JSON.parse(store.get("octopolis.folderIcons.v1")!)).toEqual({ "c:\\a": "🎵" });
    expect(folderIcons.recent()[0]).toBe("🎵");
  });
});
