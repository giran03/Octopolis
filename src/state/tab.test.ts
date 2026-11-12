import { beforeEach, describe, expect, it, vi } from "vitest";

// Feed listings through the real tab model with the Tauri IPC layer mocked.
// `dirs` maps a path to the names it currently contains.
const dirs = new Map<string, string[]>();
const gates: (() => void)[] = [];
let holdNextLoad = false;

function encode(names: string[]): ArrayBuffer {
  const len = 8 + names.reduce((n, s) => n + 24 + s.length * 2, 0);
  const buf = new ArrayBuffer(len);
  const v = new DataView(buf);
  v.setUint32(0, names.length, true);
  v.setUint32(4, 1, true); // final batch
  let off = 8;
  for (const s of names) {
    v.setUint32(off, 0x20, true);
    v.setUint16(off + 20, s.length, true);
    off += 24;
    for (let i = 0; i < s.length; i++, off += 2) v.setUint16(off, s.charCodeAt(i), true);
  }
  return buf;
}

const cachedSizes = new Map<string, { name: string; bytes: number; files: number; stale: boolean }[]>();
const gitRepos = new Map<string, { branch: string; children: Record<string, string> }>();
const repoCommits = new Map<string, Record<string, { timeMs: number; author: string }>>();

vi.mock("../lib/ipc", () => ({
  errorText: (e: unknown) => String(e),
  cachedFolderSizes: async (path: string) => cachedSizes.get(path) ?? [],
  folderSizes: async () => undefined,
  gitStatus: async (path: string) => gitRepos.get(path) ?? null,
  gitLastCommits: async (path: string) => repoCommits.get(path) ?? {},
  unwatchDir: async () => undefined,
  watchDir: async () => undefined,
  listDir: async (path: string, onBatch: (b: ArrayBuffer) => boolean) => {
    // Snapshot the folder now, deliver it later if the test holds this load.
    const payload = encode(dirs.get(path) ?? []);
    if (holdNextLoad) {
      holdNextLoad = false;
      await new Promise<void>((r) => gates.push(r));
    }
    onBatch(payload);
    return { count: 0, elapsedMs: 1, archive: null };
  },
}));

const { settings } = await import("./settings");
const { createTab } = await import("./tab");
const selectedNames = (t: ReturnType<typeof createTab>) => [...t.selection()].map((i) => t.listing().names[i]).sort();

beforeEach(() => {
  dirs.clear();
  cachedSizes.clear();
  gitRepos.clear();
  repoCommits.clear();
  settings.set({ showCommits: false });
  gates.length = 0;
  holdNextLoad = false;
});

describe("tab refresh", () => {
  it("keeps the selection and focus by name when files appear", async () => {
    dirs.set("C:\\d", ["b.txt", "c.txt"]);
    const tab = createTab("C:\\d");
    await tab.navigate("C:\\d");
    tab.selectNames(["c.txt"]);
    const before = tab.selection();

    dirs.set("C:\\d", ["a.txt", "b.txt", "c.txt"]); // a new file sorts above
    await tab.refresh();

    expect(selectedNames(tab)).toEqual(["c.txt"]);
    expect(tab.listing().names[tab.view()[tab.focus()]]).toBe("c.txt");
    expect(tab.selection()).not.toBe(before); // indices moved, so a new set
  });

  it("does not replace the selection when nothing changed (no scroll jump)", async () => {
    dirs.set("C:\\d", ["a", "b"]);
    const tab = createTab("C:\\d");
    await tab.navigate("C:\\d");
    tab.selectNames(["b"]);
    const before = tab.selection();
    await tab.refresh();
    expect(tab.selection()).toBe(before);
  });

  it("uses the selection made while a refresh was running", async () => {
    dirs.set("C:\\d", ["a", "b", "c"]);
    const tab = createTab("C:\\d");
    await tab.navigate("C:\\d");
    tab.selectNames(["a"]);

    holdNextLoad = true;
    const pending = tab.refresh();
    tab.selectNames(["c"]); // user clicks during the refresh
    gates.forEach((g) => g());
    await pending;

    expect(selectedNames(tab)).toEqual(["c"]);
  });

  it("an explicit select survives a refresh that supersedes it", async () => {
    dirs.set("C:\\d", ["a"]);
    const tab = createTab("C:\\d");
    await tab.navigate("C:\\d");

    dirs.set("C:\\d", ["a", "pasted.txt"]);
    holdNextLoad = true;
    const paste = tab.navigate("C:\\d", ["pasted.txt"]); // e.g. after a paste
    const watcher = tab.refresh(); // a watcher event arrives meanwhile
    await watcher;
    gates.forEach((g) => g());
    await paste;

    expect(selectedNames(tab)).toEqual(["pasted.txt"]);
  });

  it("starts a new folder with nothing selected", async () => {
    dirs.set("C:\\a", ["x"]);
    dirs.set("C:\\b", ["y"]);
    const tab = createTab("C:\\a");
    await tab.navigate("C:\\a");
    tab.selectNames(["x"]);
    await tab.navigate("C:\\b");
    expect(tab.selection().size).toBe(0);
  });

  it("shows cached folder sizes immediately before listing completes and remembers them in session", async () => {
    dirs.set("C:\\cached", ["docs"]);
    cachedSizes.set("C:\\cached", [{ name: "docs", bytes: 4096, files: 3, stale: true }]);
    const tab = createTab("C:\\other");
    await tab.navigate("C:\\other");

    holdNextLoad = true;
    const pending = tab.navigate("C:\\cached");
    await new Promise((r) => setTimeout(r, 0));
    expect(tab.dirSizes()?.get("docs")).toBe(4096);

    gates.forEach((g) => g());
    await pending;

    // Leaving and returning restores sizes synchronously on navigation.
    await tab.navigate("C:\\other");
    cachedSizes.delete("C:\\cached");
    holdNextLoad = true;
    const revisit = tab.navigate("C:\\cached");
    expect(tab.dirSizes()?.get("docs")).toBe(4096);
    gates.forEach((g) => g());
    await revisit;
  });

  it("loads last-commit info immediately when showCommits is toggled inside a repository", async () => {
    dirs.set("C:\\repo", ["README.md"]);
    gitRepos.set("C:\\repo", { branch: "main", children: { "readme.md": "M" } });
    repoCommits.set("C:\\repo", { "readme.md": { timeMs: 1_700_000_000_000, author: "Ada" } });

    const tab = createTab("C:\\repo");
    await tab.navigate("C:\\repo");
    await new Promise((r) => setTimeout(r, 0));
    expect(tab.git()?.branch).toBe("main");
    expect(tab.commits()).toBeNull();

    settings.toggleCommits();
    await new Promise((r) => setTimeout(r, 0));
    expect(tab.commits()?.["readme.md"]?.author).toBe("Ada");
  });
});
