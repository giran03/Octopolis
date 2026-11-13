import { describe, expect, it } from "vitest";
import { BENTO_LIMIT, chooseView, folderStats, HUGE_FOLDER } from "./autoView";
import { parseFolderViews } from "./folderViews";

const files = (names: string[], dirs = 0) => {
  const all = [...Array.from({ length: dirs }, (_, i) => `dir${i}`), ...names];
  return folderStats(all, all.map((_, i) => (i < dirs ? 1 : 0)), all.length);
};
const many = (ext: string, n: number) => Array.from({ length: n }, (_, i) => `file${i}.${ext}`);

describe("folderStats", () => {
  it("counts files by kind and reads the last part of search-style names", () => {
    const s = folderStats(["a.png", "b.mp4", "c.mp3", "d.pdf", "e.rs", "f.zip", "src\\g.jpg", "sub"], [0, 0, 0, 0, 0, 0, 0, 1], 8);
    expect(s).toMatchObject({ total: 8, files: 7, folders: 1, images: 2, videos: 1, audio: 1, docs: 1, code: 1, archives: 1 });
  });
});

describe("chooseView", () => {
  it("leaves an empty folder alone", () => {
    expect(chooseView(files([]))).toBeNull();
  });

  it("shows folders full of pictures or videos as a bento", () => {
    expect(chooseView(files(many("jpg", 30)))).toMatchObject({ mode: "bento" });
    expect(chooseView(files([...many("png", 10), ...many("mp4", 5), ...many("txt", 3)]))).toMatchObject({ mode: "bento" });
    expect(chooseView(files(many("mp4", 20)))?.reason).toContain("videos");
    expect(chooseView(files(many("png", 20)))?.reason).toContain("pictures");
  });

  it("uses large icons for a few pictures, and for too many pictures to lay out", () => {
    expect(chooseView(files(many("png", 5)))).toMatchObject({ mode: "grid", size: 160 });
    expect(chooseView(files(many("png", BENTO_LIMIT + 10)))).toMatchObject({ mode: "grid", size: 96 });
  });

  it("needs mostly media: a mix stays a list", () => {
    expect(chooseView(files([...many("png", 8), ...many("pdf", 10)]))?.mode).toBe("details");
    expect(chooseView(files([...many("png", 3), ...many("pdf", 3)]))?.mode).toBe("details");
  });

  it("shows music as content rows, and folders as tiles", () => {
    expect(chooseView(files(many("mp3", 12)))).toMatchObject({ mode: "content" });
    expect(chooseView(files(many("mp3", 3)))?.mode).toBe("details");
    expect(chooseView(files(["a.txt"], 9))).toMatchObject({ mode: "tiles" });
    expect(chooseView(files([], 2))?.mode).toBe("details");
  });

  it("keeps documents and code in the details list, and huge folders too", () => {
    expect(chooseView(files([...many("pdf", 10), ...many("rs", 10)]))).toMatchObject({ mode: "details" });
    expect(chooseView({ total: HUGE_FOLDER, files: HUGE_FOLDER, folders: 0, images: HUGE_FOLDER, videos: 0, audio: 0, docs: 0, code: 0, archives: 0, repo: false })?.mode).toBe("details");
  });
});

describe("repositories", () => {
  it("always use details, even when full of pictures, music or folders", () => {
    expect(folderStats([".git", "a.png"], [1, 0], 2).repo).toBe(true);
    expect(folderStats([".GIT"], [0], 1).repo).toBe(true);
    expect(folderStats([".hg", ".svn"], [1, 1], 2).repo).toBe(true);
    expect(folderStats([".github", "gitignore.txt"], [1, 0], 2).repo).toBe(false);
    for (const names of [[".git", ...many("jpg", 40)], [".git", ...many("mp3", 20)]]) {
      expect(chooseView(files(names))).toMatchObject({ mode: "details", reason: expect.stringContaining("repository") });
    }
    const dirsOnly = [".git", "a", "b", "c", "d", "e"];
    expect(chooseView(folderStats(dirsOnly, dirsOnly.map(() => 1), dirsOnly.length))?.mode).toBe("details");
  });
});

describe("remembered views and Auto", () => {
  it("keeps the mark that a view was picked by hand", () => {
    const all = parseFolderViews([
      ["c:\\a", { mode: "grid", manual: true, sort: { key: "name", dir: 1 } }],
      ["c:\\b", { mode: "list", sort: { key: "name", dir: 1 } }],
      ["c:\\c", { mode: "list", manual: "yes", sort: { key: "name", dir: 1 } }],
    ]);
    expect(all[0][1].manual).toBe(true);
    expect(all[1][1].manual).toBeUndefined();
    expect(all[2][1].manual).toBeUndefined();
  });
});
