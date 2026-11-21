import { describe, expect, it } from "vitest";
import { SETTING_DEFAULTS, sanitizeSettings } from "../state/settings";
import { explorerChangeText, explorerHint, explorerProblems, otherCopy, PROBLEMS_TITLE, staleTarget, useThisCopyQuestion, WIN_E_SWITCH } from "./explorerMode";
import tab from "../components/settings/GeneralTab.tsx?raw";
import type { ExplorerMode } from "./ipc";

const p = <S extends string>(state: S, detail: string | null = null) => ({ state, detail });
const working: ExplorerMode = {
  on: true,
  folders: p("ours"),
  winE: p("ours"),
  catcher: p("working"),
  target: p("thisCopy"),
  record: p("active"),
  menu: false,
  left: [],
  thisCopy: "C:/dev/Octopolis.exe",
  helper: null,
};
const off: ExplorerMode = { ...working, on: false, folders: p("off"), winE: p("absent"), catcher: p("off"), target: null, record: p("none") };

describe("explorerProblems", () => {
  it("is empty when every part is fine, on or off", () => {
    expect(explorerProblems(working)).toEqual([]);
    expect(explorerProblems(off)).toEqual([]);
  });

  it("names the app that keeps folders", () => {
    expect(explorerProblems({ ...working, folders: p("kept", "C:\\Tools\\Other.exe") })).toEqual(["Folders are kept by C:\\Tools\\Other.exe, so they still open there"]);
  });

  it("gives one line per problem", () => {
    const lines = explorerProblems({ ...working, winE: p("other", "x.exe"), catcher: p("notWorking", "no hook"), target: p("missing", "D:\\old\\Octopolis.exe") });
    expect(lines).toEqual(["Win+E is kept by x.exe", "Win+E couldn't be caught: no hook", "Set to a copy of Octopolis that no longer exists: D:\\old\\Octopolis.exe"]);
  });

  it("reports a helper that should run but doesn't (WE-01, WE-11)", () => {
    expect(explorerProblems({ ...working, helper: p("running") })).toEqual([]);
    expect(explorerProblems({ ...working, helper: p("off") })).toEqual([]);
    expect(explorerProblems({ ...working, helper: p("notRunning") })).toEqual(["The Win+E helper isn't running, so Win+E doesn't open Octopolis. Repair starts it"]);
  });

  it("never shows checking as a problem (WE-05)", () => {
    expect(explorerProblems({ ...working, catcher: p("checking") })).toEqual([]);
  });

  it("reports a record problem even while off", () => {
    expect(explorerProblems({ ...off, record: p("unusable", "Can't read it") })).toEqual(["Can't read it"]);
    expect(explorerProblems({ ...off, record: p("unfinished") })).toHaveLength(1);
  });
});

describe("stale entries", () => {
  it("show in the problems row while the switch is off (WE-14)", () => {
    expect(explorerProblems({ ...off, folders: p("stale", "C:/Old/Octopolis.exe") })).toEqual(["Folders point at a missing Octopolis: C:/Old/Octopolis.exe"]);
  });

  it("are reported even while off, and name the missing copy for the confirmation", () => {
    const gone = "C:\\Old\\Octopolis.exe";
    const s = { ...off, folders: p("stale", gone), winE: p("stale", gone) };
    expect(explorerProblems(s)).toEqual([`Folders point at a missing Octopolis: ${gone}`, `Win+E points at a missing Octopolis: ${gone}`]);
    expect(staleTarget(s)).toBe(gone);
    expect(staleTarget(working)).toBeNull();
  });
});

describe("explorerChangeText", () => {
  it("says what was taken and what was kept", () => {
    expect(explorerChangeText(true, working)).toBe("Folders and Win+E now open in Octopolis");
    expect(explorerChangeText(true, { ...working, folders: p("kept", "foo.exe") })).toBe("Win+E now opens Octopolis. Folders are kept by foo.exe");
    expect(explorerChangeText(true, { ...off, folders: p("kept", "a"), winE: p("other", "b") })).toBe("Nothing was changed: other apps keep folders and Win+E");
  });

  it("names a missing Octopolis, never other apps, when only stale entries were found", () => {
    const gone = p("stale", "C:/Old/Octopolis.exe");
    const msg = "Nothing was changed: the entries point at a missing Octopolis. Use Repair to take them over";
    expect(explorerChangeText(true, { ...off, folders: gone, winE: gone })).toBe(msg);
    expect(explorerChangeText(true, { ...off, folders: gone })).toBe(msg);
    expect(explorerChangeText(true, { ...off, winE: gone })).toBe(msg);
    expect(explorerChangeText(true, { ...working, winE: gone })).toBe("Folders now open in Octopolis. Win+E points at a missing Octopolis. Use Repair to take it over");
    expect(explorerChangeText(true, { ...off, folders: p("kept", "a.exe"), winE: gone })).toBe("Nothing was changed. Folders are kept by a.exe. Win+E points at a missing Octopolis. Use Repair to take it over");
  });

  it("mentions values left on turn-off", () => {
    expect(explorerChangeText(false, off)).toBe("Folders open in File Explorer again");
    expect(explorerChangeText(false, { ...off, left: ["a"] })).toBe("Folders open in File Explorer again. 1 setting another app changed was left as it is");
  });
});

describe("another copy of Octopolis (WE-15)", () => {
  const installed = "C:/Program Files/Octopolis/Octopolis.exe";
  const elsewhere: ExplorerMode = { ...working, catcher: p("off"), target: p("otherCopy", installed) };

  it("is never a problem, and the hint names it instead", () => {
    expect(explorerProblems(elsewhere)).toEqual([]);
    expect(otherCopy(elsewhere)).toBe(installed);
    expect(explorerHint(elsewhere)).toBe(`Set up for another copy of Octopolis: ${installed}`);
    expect(explorerHint(working)).toBe("Opens folders and Win+E in Octopolis. Settings another app owns are left alone.");
    expect(otherCopy(working)).toBeNull();
  });

  it("asks before using this copy instead", () => {
    expect(useThisCopyQuestion(elsewhere)).toBe(`Point folders and Win+E at this copy of Octopolis (C:/dev/Octopolis.exe) instead of ${installed}?`);
  });

  it("still reports a real problem next to it", () => {
    expect(explorerProblems({ ...elsewhere, winE: p("other", "x.exe") })).toEqual(["Win+E is kept by x.exe"]);
  });
});

describe("Settings layout (WE-14)", () => {
  const start = tab.indexOf("function ExplorerModeSection");
  const section = tab.slice(start, tab.indexOf('label="Help in Open and Save dialogs"', start));

  it("has one problems row with one Repair button, and no per-problem rows", () => {
    expect(PROBLEMS_TITLE).toBe("Something isn't working");
    expect(section.match(/>\s*Repair\s*</g)).toHaveLength(1);
    expect(section).toContain("<Show when={problems().length > 0}>");
    expect(section).not.toContain("Win+E still opens File Explorer?");
    expect(section).not.toContain("Catch Win+E myself");
  });

  it("shows no problems row when everything works", () => {
    expect(explorerProblems(working)).toHaveLength(0);
    expect(explorerProblems({ ...working, catcher: p("notWorking", "no hook"), folders: p("kept", "a.exe") })).toHaveLength(2);
  });

  it("renames the Win+E switch but keeps the stored catchWinE value", () => {
    expect(WIN_E_SWITCH).toEqual({ label: "Win+E opens Octopolis", hint: "Turn off to keep Win+E for File Explorer." });
    expect(section).toContain("checked={settings.catchWinE()} onChange={(catchWinE) => settings.set({ catchWinE })}");
    expect(SETTING_DEFAULTS.catchWinE).toBe(true);
    expect(sanitizeSettings({ catchWinE: false }).catchWinE).toBe(false);
  });
});
