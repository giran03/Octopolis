import { describe, expect, it } from "vitest";
import { hintsFor, type HintContext } from "./hints";

const base: HintContext = { count: 1, folders: 0, files: 1, archive: false, search: false, canPaste: false, git: false };
const ids = (c: Partial<HintContext>) => hintsFor({ ...base, ...c }).map((x) => x.id);

describe("hintsFor", () => {
  it("shows nothing without a selection", () => {
    expect(ids({ count: 0, files: 0 })).toEqual([]);
  });

  it("offers rename and quick look for one file, batch rename for several", () => {
    expect(ids({})).toContain("file.rename");
    expect(ids({})).toContain("view.quickLook");
    const many = ids({ count: 3, files: 3 });
    expect(many).toContain("file.batchRename");
    expect(many).not.toContain("file.rename");
    expect(many).not.toContain("view.quickLook");
  });

  it("offers pinning only for a single folder", () => {
    expect(ids({ folders: 1, files: 0 })).toContain("sidebar.pin");
    expect(ids({ count: 2, folders: 2, files: 0 })).not.toContain("sidebar.pin");
  });

  it("offers paste only when something can be pasted", () => {
    expect(ids({})).not.toContain("file.paste");
    expect(ids({ canPaste: true })).toContain("file.paste");
  });

  it("limits archives to what works inside them", () => {
    const list = ids({ archive: true });
    expect(list).toContain("file.extract");
    expect(list).not.toContain("file.cut");
    expect(list).not.toContain("file.delete");
  });

  it("adds git and search hints in those contexts", () => {
    expect(ids({ git: true })).toContain("git.stage");
    expect(ids({ search: true })).toContain("file.reveal");
    expect(ids({})).not.toContain("git.stage");
  });
});
