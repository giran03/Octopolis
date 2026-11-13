// Ready-made folder rules. A preset names the folders it works on with {downloads}, {documents}, {pictures} or
// {desktop}, which are filled in with this PC's real folders when it is added.
import { NEW_RULE, type Rule } from "./rules";

export type RulePresetGroup = "downloads" | "cleanup" | "sort";

export interface RulePreset {
  readonly group: RulePresetGroup;
  readonly description: string;
  readonly rule: Omit<Rule, "id">;
}

export const RULE_PRESET_GROUPS: readonly { id: RulePresetGroup; title: string }[] = [
  { id: "downloads", title: "Keep Downloads tidy" },
  { id: "cleanup", title: "Clean up leftovers" },
  { id: "sort", title: "Sort into folders" },
];

const rule = (name: string, extra: Partial<Rule>): Omit<Rule, "id"> => ({ ...NEW_RULE, name, ...extra });

export const RULE_PRESETS: readonly RulePreset[] = [
  {
    group: "downloads",
    description: "Installers you ran once and no longer need, after a month.",
    rule: rule("Old installers", { folder: "{downloads}", patterns: "*.exe; *.msi; *.msix; *.appx", olderThanDays: 30, action: "recycle" }),
  },
  {
    group: "downloads",
    description: "Moves PDFs older than 30 days out of Downloads into Documents.",
    rule: rule("Old PDFs to Documents", { folder: "{downloads}", patterns: "*.pdf", olderThanDays: 30, action: "move", dest: "{documents}\\PDFs" }),
  },
  {
    group: "downloads",
    description: "Zip, 7z, rar and other archives left over after you extracted them.",
    rule: rule("Old archives", { folder: "{downloads}", patterns: "*.zip; *.7z; *.rar; *.tar; *.gz", olderThanDays: 45, action: "recycle" }),
  },
  {
    group: "downloads",
    description: "Anything in Downloads untouched for three months, moved to a holding folder you can review.",
    rule: rule("Stale downloads to review", { folder: "{downloads}", patterns: "", olderThanDays: 90, action: "move", dest: "{downloads}\\Old" }),
  },
  {
    group: "cleanup",
    description: "Half-finished downloads and temporary files that never completed.",
    rule: rule("Unfinished downloads", { folder: "{downloads}", patterns: "*.crdownload; *.part; *.partial; *.tmp; *.download", olderThanDays: 3, action: "recycle" }),
  },
  {
    group: "cleanup",
    description: "Big files (over 500 MB) not touched for three months, anywhere in Downloads.",
    rule: rule("Big and old", { folder: "{downloads}", patterns: "", olderThanDays: 90, minSizeMb: 500, recursive: true, action: "recycle" }),
  },
  {
    group: "cleanup",
    description: "Screenshots older than a month, from the Screenshots folder in Pictures.",
    rule: rule("Old screenshots", { folder: "{pictures}\\Screenshots", patterns: "*.png; *.jpg", olderThanDays: 30, action: "recycle" }),
  },
  {
    group: "cleanup",
    description: "Copies Windows or a browser made with (1), (2)… after the name.",
    rule: rule("Numbered copies", { folder: "{downloads}", patterns: "* (?).*; * (??).*", olderThanDays: 14, action: "recycle" }),
  },
  {
    group: "cleanup",
    description: "Moves loose files on the Desktop that have sat there for two weeks into Documents.",
    rule: rule("Desktop clear-out", { folder: "{desktop}", patterns: "", olderThanDays: 14, action: "move", dest: "{documents}\\From Desktop" }),
  },
  {
    group: "sort",
    description: "Files pictures from Downloads into Pictures\\Year\\Month by when they were last changed.",
    rule: rule("Pictures by month", { folder: "{downloads}", patterns: "*.jpg; *.jpeg; *.png; *.gif; *.webp; *.heic", olderThanDays: 7, action: "move", dest: "{pictures}\\{year}\\{month}" }),
  },
  {
    group: "sort",
    description: "Sorts documents from Downloads into Documents by file type (pdf, docx, xlsx…).",
    rule: rule("Documents by type", { folder: "{downloads}", patterns: "*.pdf; *.doc; *.docx; *.xls; *.xlsx; *.ppt; *.pptx; *.txt", olderThanDays: 14, action: "move", dest: "{documents}\\{ext}" }),
  },
  {
    group: "sort",
    description: "Videos and music from Downloads, filed by year.",
    rule: rule("Media by year", { folder: "{downloads}", patterns: "*.mp4; *.mkv; *.mov; *.avi; *.mp3; *.flac; *.wav", olderThanDays: 14, action: "move", dest: "{documents}\\Media\\{year}" }),
  },
];

const FOLDER_TOKEN = /\{(downloads|documents|pictures|desktop)\}/g;

/** The folder tokens a preset uses, which must be known before it can be added. */
export function presetFolderIds(p: RulePreset): string[] {
  return [...new Set([...`${p.rule.folder}\n${p.rule.dest}`.matchAll(FOLDER_TOKEN)].map((m) => m[1]))];
}

/** A preset as a rule for this PC, or null when one of its folders is unknown here. `folders` maps ids to paths. */
export function resolvePreset(p: RulePreset, folders: Readonly<Record<string, string>>): Omit<Rule, "id"> | null {
  const fill = (text: string) => text.replace(FOLDER_TOKEN, (_, id: string) => folders[id]?.replace(/[\\/]+$/, "") ?? "\u0000");
  const folder = fill(p.rule.folder);
  const dest = fill(p.rule.dest);
  return folder.includes("\u0000") || dest.includes("\u0000") ? null : { ...p.rule, folder, dest };
}
