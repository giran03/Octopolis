import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({ SHOW_ITEMS_EVENT: "x", shellWindowsSync: () => Promise.resolve() }));
vi.mock("./workspace", () => ({ workspace: {} }));
vi.mock("./settings", () => ({ settings: {} }));

import { listedFolders } from "./shellWindows";

const tab = (path: string, archive: string | null = null) => ({ path: () => path, archive: () => archive });

describe("listedFolders", () => {
  it("lists each real folder once", () => {
    expect(listedFolders([tab("C:\\a"), tab("c:\\A\\"), tab("D:\\b")])).toEqual(["C:\\a", "D:\\b"]);
  });

  it("skips archives, shell places and empty tabs", () => {
    expect(listedFolders([tab("C:\\x.zip\\inner", "C:\\x.zip"), tab("shell:Downloads"), tab("::{20D04FE0-3AEA-1069-A2D8-08002B30309D}"), tab("")])).toEqual([]);
  });
});
