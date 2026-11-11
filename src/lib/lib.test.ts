import { describe, expect, it } from "vitest";
import { createBuilder, decodeBatch, indexOfName, snapshot, KIND_DIR, KIND_FILE, ATTR_HIDDEN } from "./listing";
import { buildView, toggleSort, DEFAULT_SORT } from "./sort";
import { baseName, breadcrumbs, isRoot, joinPath, parentPath, sameVolume, samePath, stemLength, extensionOf } from "./paths";
import { formatSize, typeLabel, categoryOf } from "./format";
import { leaf, leaves, removePane, resizeSplit, splitPane, type LayoutNode } from "./layout";

interface FakeEntry {
  name: string;
  kind?: number;
  size?: number;
  mtime?: number;
  attrs?: number;
}

/** Encodes entries exactly like octo-core's BatchEncoder. */
function encode(entries: FakeEntry[], final = true): ArrayBuffer {
  const len = 8 + entries.reduce((n, e) => n + 24 + e.name.length * 2, 0);
  const buf = new ArrayBuffer(len);
  const v = new DataView(buf);
  v.setUint32(0, entries.length, true);
  v.setUint32(4, final ? 1 : 0, true);
  let off = 8;
  for (const e of entries) {
    v.setUint32(off, e.attrs ?? 0x20, true);
    v.setFloat64(off + 4, e.size ?? 0, true);
    v.setFloat64(off + 12, e.mtime ?? 0, true);
    v.setUint16(off + 20, e.name.length, true);
    v.setUint8(off + 22, e.kind ?? KIND_FILE);
    off += 24;
    for (let i = 0; i < e.name.length; i++, off += 2) v.setUint16(off, e.name.charCodeAt(i), true);
  }
  return buf;
}

function listingOf(entries: FakeEntry[]) {
  const b = createBuilder("C:\\t");
  decodeBatch(encode(entries), b);
  return snapshot(b);
}

describe("listing decoder", () => {
  it("decodes names (including surrogate pairs), kinds, sizes and the final flag", () => {
    const b = createBuilder("C:\\x");
    const final1 = decodeBatch(encode([{ name: "a.txt", size: 42, mtime: 1_700_000_000_123 }], false), b);
    const final2 = decodeBatch(encode([{ name: "🐙 dir", kind: KIND_DIR }]), b);
    const l = snapshot(b);
    expect(final1).toBe(false);
    expect(final2).toBe(true);
    expect(l.count).toBe(2);
    expect(l.names).toEqual(["a.txt", "🐙 dir"]);
    expect(l.sizes[0]).toBe(42);
    expect(l.mtimes[0]).toBe(1_700_000_000_123);
    expect(l.kinds[1]).toBe(KIND_DIR);
    expect(indexOfName(l, "A.TXT")).toBe(0);
  });

  it("rejects truncated batches", () => {
    const buf = encode([{ name: "abc" }]);
    expect(() => decodeBatch(buf.slice(0, buf.byteLength - 2), createBuilder("x"))).toThrow(/truncated/);
  });
});

describe("buildView", () => {
  const l = listingOf([
    { name: "file10.txt", size: 10, mtime: 3 },
    { name: "file2.txt", size: 300, mtime: 1 },
    { name: "Zeta", kind: KIND_DIR, mtime: 2 },
    { name: "alpha", kind: KIND_DIR, mtime: 5 },
    { name: ".hidden", size: 1 },
    { name: "sys.bin", attrs: ATTR_HIDDEN, size: 5 },
    { name: "b.md", size: 50, mtime: 9 },
  ]);
  const names = (v: Uint32Array) => Array.from(v, (i) => l.names[i]);

  it("puts folders first and sorts names naturally", () => {
    expect(names(buildView(l, { sort: DEFAULT_SORT, showHidden: false }))).toEqual(["alpha", "Zeta", "b.md", "file2.txt", "file10.txt"]);
  });

  it("can show hidden items and filter by name", () => {
    expect(buildView(l, { sort: DEFAULT_SORT, showHidden: true }).length).toBe(7);
    expect(names(buildView(l, { sort: DEFAULT_SORT, showHidden: false, filter: "FILE" }))).toEqual(["file2.txt", "file10.txt"]);
  });

  it("sorts by size and date, keeping folders on top", () => {
    expect(names(buildView(l, { sort: { key: "size", dir: -1 }, showHidden: false }))).toEqual(["Zeta", "alpha", "file2.txt", "b.md", "file10.txt"]);
    expect(names(buildView(l, { sort: { key: "modified", dir: 1 }, showHidden: false })).slice(2)).toEqual(["file2.txt", "file10.txt", "b.md"]);
  });

  it("sorts by type then name", () => {
    expect(names(buildView(l, { sort: { key: "type", dir: 1 }, showHidden: false })).slice(2)).toEqual(["b.md", "file2.txt", "file10.txt"]);
  });

  it("toggles direction and picks sensible defaults", () => {
    expect(toggleSort(DEFAULT_SORT, "name")).toEqual({ key: "name", dir: -1 });
    expect(toggleSort(DEFAULT_SORT, "size")).toEqual({ key: "size", dir: -1 });
    expect(toggleSort(DEFAULT_SORT, "type")).toEqual({ key: "type", dir: 1 });
  });
});

describe("paths", () => {
  it("handles drive roots, nested folders and UNC shares", () => {
    expect(parentPath("C:\\Users\\me")).toBe("C:\\Users");
    expect(parentPath("C:\\Users")).toBe("C:\\");
    expect(parentPath("C:\\")).toBeNull();
    expect(parentPath("\\\\srv\\share\\docs")).toBe("\\\\srv\\share\\");
    expect(isRoot("D:\\")).toBe(true);
    expect(isRoot("D:")).toBe(true);
    expect(baseName("C:\\Users\\me")).toBe("me");
    expect(baseName("C:\\")).toBe("C:");
    expect(joinPath("C:\\", "a")).toBe("C:\\a");
    expect(joinPath("C:\\a", "b")).toBe("C:\\a\\b");
  });

  it("builds breadcrumbs", () => {
    expect(breadcrumbs("C:\\Users\\me")).toEqual([
      { label: "C:", path: "C:\\" },
      { label: "Users", path: "C:\\Users" },
      { label: "me", path: "C:\\Users\\me" },
    ]);
    expect(breadcrumbs("\\\\srv\\share\\x").map((c) => c.path)).toEqual(["\\\\srv\\share\\", "\\\\srv\\share\\x"]);
  });

  it("compares volumes and paths case-insensitively", () => {
    expect(sameVolume("c:\\a", "C:\\b")).toBe(true);
    expect(sameVolume("C:\\a", "D:\\a")).toBe(false);
    expect(samePath("C:\\A\\", "c:\\a")).toBe(true);
  });

  it("finds extensions and stems", () => {
    expect(extensionOf("a.TAR.GZ")).toBe("gz");
    expect(extensionOf(".env")).toBe("");
    expect(stemLength("report.pdf", false)).toBe(6);
    expect(stemLength("v1.2", true)).toBe(4);
  });
});

describe("format", () => {
  it("formats sizes like Explorer", () => {
    expect(formatSize(0)).toBe("0 KB");
    expect(formatSize(1)).toBe("1 KB");
    expect(formatSize(1536)).toBe("2 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.00 MB");
    expect(formatSize(123.4 * 1024 ** 3)).toBe("123 GB");
  });

  it("labels types and categories", () => {
    expect(typeLabel("x.rs", false)).toBe("RS file");
    expect(typeLabel("Makefile", false)).toBe("File");
    expect(typeLabel("src", true)).toBe("Folder");
    expect(categoryOf("a.PNG", false)).toBe("image");
    expect(categoryOf("a", true)).toBe("folder");
  });
});

describe("layout tree", () => {
  const sum = (n: LayoutNode) => (n.kind === "split" ? n.sizes.reduce((a, b) => a + b, 0) : 1);

  it("splits into a sibling when the direction matches", () => {
    let t = splitPane(leaf("a"), "a", "b", "row");
    t = splitPane(t, "b", "c", "row");
    expect(leaves(t)).toEqual(["a", "b", "c"]);
    expect(t.kind === "split" && t.sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it("nests when the direction differs", () => {
    const t = splitPane(splitPane(leaf("a"), "a", "b", "row"), "b", "c", "column");
    expect(leaves(t)).toEqual(["a", "b", "c"]);
    expect(t.kind === "split" && t.children[1].kind).toBe("split");
  });

  it("removes panes and collapses single-child splits", () => {
    const t = splitPane(splitPane(leaf("a"), "a", "b", "row"), "b", "c", "row");
    const r = removePane(t, "b")!;
    expect(leaves(r)).toEqual(["a", "c"]);
    expect(sum(r)).toBeCloseTo(1);
    expect(removePane(splitPane(leaf("a"), "a", "b", "row"), "a")).toEqual(leaf("b"));
    expect(removePane(leaf("a"), "a")).toBeNull();
  });

  it("resizes within limits", () => {
    const t = splitPane(leaf("a"), "a", "b", "row");
    const r = resizeSplit(t, [], 0, 0.2);
    expect(r.kind === "split" && r.sizes[0]).toBeCloseTo(0.7);
    const clamped = resizeSplit(t, [], 0, 5);
    expect(clamped.kind === "split" && clamped.sizes[1]).toBeCloseTo(0.12);
    expect(sum(clamped)).toBeCloseTo(1);
  });
});
