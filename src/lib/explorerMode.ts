import type { ExplorerMode } from "./ipc";

/**
 * One line per problem with "Use Octopolis instead of File Explorer". Settings shows them all in one
 * "Something isn't working" row with one Repair button (WE-14); no row when this is empty.
 * Record problems (and entries with no record that point at a missing copy) show even while off.
 */
export function explorerProblems(s: ExplorerMode): string[] {
  const out: string[] = [];
  if (s.record.state === "unusable") out.push(s.record.detail ?? "Octopolis's record of what it changed can't be used");
  if (s.record.state === "unfinished") out.push("A change to these settings didn't finish. Repair finishes it");
  if (s.folders.state === "stale") out.push(`Folders point at a missing Octopolis: ${s.folders.detail ?? ""}`);
  if (s.winE.state === "stale") out.push(`Win+E points at a missing Octopolis: ${s.winE.detail ?? ""}`);
  if (!s.on) return out;
  if (s.folders.state === "kept") out.push(`Folders are kept by ${s.folders.detail ?? "another app"}, so they still open there`);
  if (s.folders.state === "off") out.push("Folders still open in File Explorer");
  if (s.winE.state === "other") out.push(`Win+E is kept by ${s.winE.detail ?? "another app"}`);
  if (s.winE.state === "absent") out.push("Win+E isn't set up");
  if (s.catcher.state === "notWorking") out.push(`Win+E couldn't be caught: ${s.catcher.detail ?? "unknown reason"}`);
  if (s.helper?.state === "notRunning") out.push("The Win+E helper isn't running, so Win+E doesn't open Octopolis. Repair starts it");
  // Another copy that exists is information, not a problem (WE-15): see explorerHint.
  if (s.target?.state === "missing") out.push(`Set to a copy of Octopolis that no longer exists: ${s.target.detail ?? ""}`);
  return out;
}

/** The toast after turning the switch on or off. */
export function explorerChangeText(next: boolean, s: ExplorerMode): string {
  if (!next) {
    const left = s.left.length;
    return left ? `Folders open in File Explorer again. ${left} setting${left === 1 ? "" : "s"} another app changed ${left === 1 ? "was" : "were"} left as ${left === 1 ? "it is" : "they are"}` : "Folders open in File Explorer again";
  }
  const folders = s.folders.state === "ours";
  const winE = s.winE.state === "ours";
  if (folders && winE) return "Folders and Win+E now open in Octopolis";
  // Name the real reason for each part left as it was (WE-14).
  const foldersWhy = s.folders.state === "stale" ? "Folders point at a missing Octopolis. Use Repair to take them over" : `Folders are kept by ${s.folders.detail ?? "another app"}`;
  const winEWhy = s.winE.state === "stale" ? "Win+E points at a missing Octopolis. Use Repair to take it over" : `Win+E is kept by ${s.winE.detail ?? "another app"}`;
  if (folders) return `Folders now open in Octopolis. ${winEWhy}`;
  if (winE) return `Win+E now opens Octopolis. ${foldersWhy}`;
  const foldersStale = s.folders.state === "stale";
  const winEStale = s.winE.state === "stale";
  if (foldersStale && (winEStale || s.winE.state === "absent")) return "Nothing was changed: the entries point at a missing Octopolis. Use Repair to take them over";
  if (winEStale && s.folders.state === "off") return "Nothing was changed: the entries point at a missing Octopolis. Use Repair to take them over";
  if (foldersStale || winEStale) return `Nothing was changed. ${foldersWhy}. ${winEWhy}`;
  return "Nothing was changed: other apps keep folders and Win+E";
}

/** The missing Octopolis.exe that Repair would take entries over from, after asking (WE-08). */
export function staleTarget(s: ExplorerMode): string | null {
  if (s.folders.state === "stale") return s.folders.detail;
  if (s.winE.state === "stale") return s.winE.detail;
  return null;
}

/** Title of the single problems row (WE-14). */
export const PROBLEMS_TITLE = "Something isn't working";
/** The switch formerly called "Catch Win+E myself"; it keeps the stored `catchWinE` setting (WE-14). */
export const WIN_E_SWITCH = { label: "Win+E opens Octopolis", hint: "Turn off to keep Win+E for File Explorer." } as const;
const MAIN_HINT = "Opens folders and Win+E in Octopolis. Settings another app owns are left alone.";

/** The other existing copy of Octopolis the entries point at, or null (WE-15). */
export function otherCopy(s: ExplorerMode | null | undefined): string | null {
  return s?.target?.state === "otherCopy" ? s.target.detail : null;
}

/** Hint under the main switch: names the other copy when the entries point at one (WE-14, WE-15). */
export function explorerHint(s: ExplorerMode | null | undefined): string {
  const other = otherCopy(s);
  return other ? `Set up for another copy of Octopolis: ${other}` : MAIN_HINT;
}

/** The question "Use this copy instead" asks first (WE-15). */
export function useThisCopyQuestion(s: ExplorerMode): string {
  return `Point folders and Win+E at this copy of Octopolis (${s.thisCopy}) instead of ${otherCopy(s) ?? "the other copy"}?`;
}
