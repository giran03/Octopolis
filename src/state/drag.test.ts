import { describe, expect, it } from "vitest";
import { dragState, endDrag, isDragging, onDragReset, tabDrag } from "./drag";

describe("ending a drag", () => {
  it("clears the shared drag state and runs every registered reset", () => {
    dragState.paths = ["C:\a"];
    dragState.dirs = ["C:\a"];
    dragState.allDirs = true;
    dragState.archive = "C:\z.zip";
    tabDrag.current = { pane: "p", tab: "t", title: "T" };
    let calls = 0;
    const off = onDragReset(() => calls++);
    endDrag();
    expect(calls).toBe(1);
    expect(dragState).toMatchObject({ paths: [], dirs: [], allDirs: false, archive: null });
    expect(tabDrag.current).toBeNull();
    expect(isDragging()).toBe(false);
    off();
    endDrag();
    expect(calls).toBe(1);
  });
});
