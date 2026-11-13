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

describe("Windows folder icons", () => {
  it("tells them from emoji, and stores them without touching the recent emoji", async () => {
    const { isSystemValue, systemValue } = await import("./folderIcons");
    expect(isSystemValue(systemValue("3dobjects"))).toBe(true);
    for (const bad of ["sys:", "sys:Documents", "sys:a b", "documents", "sys:../x", "sys:" + "a".repeat(25), "📁"]) expect(isSystemValue(bad)).toBe(false);
    expect(isEmoji("sys:documents")).toBe(false);
    const recentBefore = [...folderIcons.recent()];
    folderIcons.set("C:\Sys", systemValue("documents"));
    expect(folderIcons.has("C:\Sys")).toBe(true);
    expect(folderIcons.get("C:\Sys")).toBeUndefined();
    expect(folderIcons.systemId("C:\Sys")).toBe("documents");
    expect(folderIcons.recent()).toEqual(recentBefore);
    folderIcons.set("C:\Sys", null);
    expect(folderIcons.has("C:\Sys")).toBe(false);
  });
});

describe("menu hints", () => {
  it("describes a custom icon for the context menu", async () => {
    const { systemValue, appValue, resourceValue } = await import("./folderIcons");
    expect(folderIcons.describe("C:\Plain")).toBeUndefined();
    folderIcons.set("C:\H", "🎵");
    expect(folderIcons.describe("C:\H")).toBe("🎵");
    folderIcons.set("C:\H", systemValue("documents"));
    expect(folderIcons.describe("C:\H")).toBe("Folder icon");
    folderIcons.set("C:\H", appValue("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"));
    expect(folderIcons.describe("C:\H")).toBe("App icon");
    folderIcons.set("C:\H", resourceValue("imageres", 3));
    expect(folderIcons.describe("C:\H")).toBe("Windows icon");
    folderIcons.set("C:\H", null);
    expect(folderIcons.describe("C:\H")).toBeUndefined();
  });
});
