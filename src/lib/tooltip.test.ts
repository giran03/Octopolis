import { describe, expect, it } from "vitest";
import { parseTooltip } from "./tooltip";

describe("parseTooltip", () => {
  it("parses status bar hint lists into structured hint pairs", () => {
    const raw =
      "Enter Open   ·   F2 Rename   ·   Ctrl+C Copy   ·   Ctrl+X Cut   ·   Delete Recycle   ·   Shift+Space Quick look   ·   Ctrl+Shift+D Add to shelf   ·   Ctrl+Shift+G Tags   ·   Ctrl+Shift+C Copy path   ·   Alt+Enter Properties";
    const parsed = parseTooltip(raw);
    expect(parsed.mode).toBe("hints");
    expect(parsed.hints).toEqual([
      { keys: "Enter", label: "Open" },
      { keys: "F2", label: "Rename" },
      { keys: "Ctrl+C", label: "Copy" },
      { keys: "Ctrl+X", label: "Cut" },
      { keys: "Delete", label: "Recycle" },
      { keys: "Shift+Space", label: "Quick look" },
      { keys: "Ctrl+Shift+D", label: "Add to shelf" },
      { keys: "Ctrl+Shift+G", label: "Tags" },
      { keys: "Ctrl+Shift+C", label: "Copy path" },
      { keys: "Alt+Enter", label: "Properties" },
    ]);
  });

  it("parses parenthesized shortcuts and trailing dot shortcuts", () => {
    expect(parseTooltip("New tab (Ctrl+T)")).toEqual({
      mode: "rich",
      parts: [
        { kind: "text", value: "New tab" },
        { kind: "text", value: " " },
        { kind: "kbd", value: "Ctrl+T" },
      ],
    });

    expect(parseTooltip("Back (Alt+Left). Right-click for the list")).toEqual({
      mode: "rich",
      parts: [
        { kind: "text", value: "Back" },
        { kind: "text", value: " " },
        { kind: "kbd", value: "Alt+Left" },
        { kind: "text", value: ". Right-click for the list" },
      ],
    });

    expect(parseTooltip("Settings · Ctrl+,")).toEqual({
      mode: "rich",
      parts: [
        { kind: "text", value: "Settings" },
        { kind: "text", value: " " },
        { kind: "kbd", value: "Ctrl+," },
      ],
    });

    expect(parseTooltip("Split right (Ctrl+\\)")).toEqual({
      mode: "rich",
      parts: [
        { kind: "text", value: "Split right" },
        { kind: "text", value: " " },
        { kind: "kbd", value: "Ctrl+\\" },
      ],
    });

    expect(parseTooltip("Actual size 100% (1)")).toEqual({
      mode: "rich",
      parts: [
        { kind: "text", value: "Actual size 100%" },
        { kind: "text", value: " " },
        { kind: "kbd", value: "1" },
      ],
    });

    expect(parseTooltip("Hide shelf · Ctrl+Shift+D adds the selection")).toEqual({
      mode: "rich",
      parts: [
        { kind: "text", value: "Hide shelf · " },
        { kind: "kbd", value: "Ctrl+Shift+D" },
        { kind: "text", value: " adds the selection" },
      ],
    });
  });

  it("leaves plain tooltips and non-shortcut parentheses alone", () => {
    expect(parseTooltip("Disk space preview (C:)")).toEqual({ mode: "plain" });
    expect(parseTooltip("Unpin inspector (follow selection)")).toEqual({ mode: "plain" });
    expect(parseTooltip("Recycle Bin · drop items here to delete, or click to open")).toEqual({ mode: "plain" });
    expect(parseTooltip("Folder rules · tidy old files, always previewed first")).toEqual({ mode: "plain" });
  });
});
