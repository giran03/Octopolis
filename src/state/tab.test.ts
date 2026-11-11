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

vi.mock("../lib/ipc", () => ({
  errorText: (e: unknown) => String(e),
  folderSizes: async () => undefined,
  gitStatus: async () => null,
  gitLastCommits: async () => ({}),
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

const { createTab } = await import("./tab");
const selectedNames = (t: ReturnType<typeof createTab>) => [...t.selection()].map((i) => t.listing().names[i]).sort();

beforeEach(() => {
  dirs.clear();
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
});
