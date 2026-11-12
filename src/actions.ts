// File actions shared by keyboard shortcuts, the context menu and the toolbar.
import type { ArchiveFormat, GitChange, LinkKind } from "./lib/ipc";
import { GROUP_KEYS, GROUP_TITLES } from "./lib/group";
import { openTerminalHere, pickFolderDialog, createFile, createFolder, createLinks, gitChange, openInEditor, runCustomAction, setCloudPin, ejectDrive, errorText, extractAndOpen, listTemplates, nativeMenu, openPath, openWith, renameItem, revealInExplorer, runAsAdmin, templatesFolder } from "./lib/ipc";
import { baseOf, isDir } from "./lib/listing";
import { baseName, joinPath, parentPath, samePath, sameVolume } from "./lib/paths";
import { extensionOf, invertSelection, namePattern, selectWhere } from "./lib/selection";
import { formatPaths, PATH_FORMATS, type PathFormat } from "./lib/pathFormats";
import { parsePreset } from "./lib/session";
import { countStatuses, isDifference } from "./lib/compare";
import { leaves } from "./lib/layout";
import { compare } from "./state/compare";
import { savedSearches } from "./state/savedSearches";
import { customActions } from "./state/customActions";
import { actionApplies, expandCommand, type CustomAction } from "./lib/customActions";
import { ops } from "./state/ops";
import { loadJson, saveJson, settings } from "./state/settings";
import { shelf } from "./state/shelf";
import type { TabModel } from "./state/tab";
import { ui } from "./state/ui";
import { workspace } from "./state/workspace";

export const ARCHIVE_NAME = /\.(zip|jar|nupkg|vsix|apk|7z|tar|tgz|tbz2?|tar\.gz|tar\.bz2)$/i;

/** Archives are read-only; returns true (and explains) when `tab` is inside one. */
function blockedInArchive(tab: TabModel): boolean {
  if (!tab.archive()) return false;
  ui.toast("Archives are read-only here. Copy items out to change them.");
  return true;
}

/** The focused entry when nothing is selected, otherwise the selection. */
/** Opens files in the editor from Settings, or each file type's editor. */
export async function editFiles(paths: readonly string[]) {
  for (const path of paths.slice(0, 20)) {
    try {
      await openInEditor(path, settings.editorPath() || null);
    } catch (e) {
      ui.toast(`Couldn't open an editor: ${errorText(e)}`);
      return;
    }
  }
}

export const editSelection = (tab: TabModel) => void editFiles(targets(tab));

export function targets(tab: TabModel): string[] {
  const picked = tab.selectedPaths();
  if (picked.length) return picked;
  const entry = tab.view()[tab.focus()];
  return entry === undefined ? [] : [tab.pathOf(entry)];
}

/** The path of the selected item when it is exactly one real folder (not inside an archive). */
export function singleFolderPath(tab: TabModel): string | null {
  if (tab.archive() || tab.selection().size !== 1) return null;
  const l = tab.listing();
  const entry = [...tab.selection()][0];
  return entry < l.count && isDir(l, entry) ? tab.pathOf(entry) : null;
}

/** Plain-text and source files, which open in the chosen editor instead of the Windows default. */
const TEXT_FILE = /\.(txt|md|markdown|mdx|log|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|env|properties|xml|csv|tsv|html?|css|scss|sass|less|js|mjs|cjs|jsx|ts|mts|cts|tsx|vue|svelte|astro|py|pyi|rb|php|java|kt|kts|scala|groovy|gradle|go|rs|c|h|cc|cpp|cxx|hpp|hh|cs|fs|vb|swift|m|mm|dart|lua|pl|r|jl|sql|graphql|gql|proto|sh|bash|zsh|ps1|psm1|psd1|bat|cmd|dockerfile|makefile|cmake|tf|gitignore|gitattributes|editorconfig|lock|diff|patch|tex|rst|srt)$/i;

/** The program for a double-clicked file: the editor from Settings for text files, else null (Windows decides). */
const opener = (tab: TabModel, name: string): ((path: string) => Promise<void>) => {
  if (tab.archive()) return extractAndOpen;
  if (settings.editorPath() && settings.editorOpensText() && TEXT_FILE.test(name)) return (path) => openInEditor(path, settings.editorPath());
  return openPath;
};

export function openEntry(tab: TabModel, entry: number) {
  const l = tab.listing();
  if (entry >= l.count) return;
  const full = tab.pathOf(entry);
  if (isDir(l, entry) || ARCHIVE_NAME.test(l.names[entry])) return void tab.navigate(full);
  opener(tab, l.names[entry])(full).catch((e) => ui.toast(`Couldn't open ${l.names[entry]}: ${errorText(e)}`));
}

/** Opens a folder (or archive) in a new tab of the active pane; files open normally. */
export function openInNewTab(path: string, background = true) {
  workspace.newTab(workspace.activePaneId(), path, background);
}

/** Middle-click or Ctrl+double-click on a list entry. */
export function openEntryInTab(tab: TabModel, entry: number, background = true) {
  const l = tab.listing();
  if (entry >= l.count) return;
  if (isDir(l, entry) || ARCHIVE_NAME.test(l.names[entry])) openInNewTab(tab.pathOf(entry), background);
  else openEntry(tab, entry);
}

/** Opens a path from a view that isn't index-based (Miller columns). */
export function openFromPath(tab: TabModel, path: string) {
  if (ARCHIVE_NAME.test(path)) return void tab.navigate(path);
  opener(tab, path)(path).catch((e) => ui.toast(errorText(e)));
}

export function openSelection(tab: TabModel) {
  const sel = [...tab.selection()];
  const entries = sel.length ? sel : [tab.view()[tab.focus()]].filter((e) => e !== undefined);
  const l = tab.listing();
  const dir = entries.find((e) => isDir(l, e));
  // Several folders can't all be shown in one tab: open the first one.
  if (dir !== undefined) return openEntry(tab, dir);
  entries.forEach((e) => openEntry(tab, e));
}

export function copySelection(tab: TabModel, mode: "copy" | "cut") {
  const paths = targets(tab);
  if (paths.length === 0) return;
  if (mode === "cut" && blockedInArchive(tab)) return;
  ops.setClip({ mode, paths, archive: tab.archive() });
  ui.toast(`${mode === "cut" ? "Cut" : "Copied"} ${paths.length === 1 ? `"${baseName(paths[0])}"` : `${paths.length} items`}`);
}

/** Moves `paths` to the Recycle Bin, asking first when "Confirm before deleting" is enabled. */
export function recyclePaths(paths: readonly string[]) {
  if (paths.length === 0) return;
  if (!settings.confirmRecycle()) return ops.remove([...paths], false);
  ui.ask({
    title: "Move to Recycle Bin?",
    body: paths.length === 1 ? `"${baseName(paths[0])}" will be moved to the Recycle Bin.` : `These ${paths.length} items will be moved to the Recycle Bin.`,
    confirmLabel: "Move to Recycle Bin",
    onConfirm: () => ops.remove([...paths], false),
  });
}

export function deleteSelection(tab: TabModel, permanent: boolean) {
  if (blockedInArchive(tab)) return;
  const paths = targets(tab);
  if (paths.length === 0) return;
  if (!permanent) return recyclePaths(paths);
  const what = paths.length === 1 ? `"${baseName(paths[0])}"` : `these ${paths.length} items`;
  ui.ask({
    title: "Delete permanently?",
    body: `${what} will be deleted without going to the Recycle Bin. This can't be undone.`,
    confirmLabel: "Delete",
    danger: true,
    onConfirm: () => ops.remove(paths, true),
  });
}

export function startRename(tab: TabModel) {
  if (blockedInArchive(tab)) return;
  if (tab.selection().size > 1) return ui.setBatchRenameOpen(true);
  const sel = [...tab.selection()];
  const entry = sel.length === 1 ? sel[0] : tab.view()[tab.focus()];
  if (entry !== undefined) tab.setRenaming(entry);
}

export async function commitRename(tab: TabModel, entry: number, newName: string) {
  tab.setRenaming(null);
  const l = tab.listing();
  // Search results are relative paths; only the last segment is renamed.
  const old = l.names[entry];
  const name = newName.trim();
  if (!name || name === baseOf(old)) return;
  try {
    const from = joinPath(l.path, old);
    const to = await renameItem(from, name);
    ops.record({ kind: "move", label: `Rename to "${name}"`, pairs: [[from, to]] });
    if (tab.search()) await tab.refresh();
    else await tab.navigate(tab.path(), [name]);
  } catch (e) {
    ui.toast(errorText(e));
  }
}

export function nativeContextMenu(tab: TabModel) {
  const paths = targets(tab);
  if (tab.archive()) return ui.toast("The Windows menu is not available inside archives.");
  nativeMenu(paths.length ? paths : [tab.path()]).catch((e) => ui.toast(errorText(e)));
}

export function addToShelf(tab: TabModel) {
  const paths = targets(tab);
  if (paths.length) shelf.add(paths);
}

const PRESETS_KEY = "octopolis.presets.v1";
type Presets = Record<string, unknown>;

export function savePreset() {
  ui.askText({
    title: "Save workspace",
    label: "Name",
    onSubmit: (name) => {
      saveJson(PRESETS_KEY, { ...loadJson<Presets>(PRESETS_KEY, {}), [name]: workspace.snapshotLayout() });
      ui.toast(`Saved workspace "${name}"`);
    },
  });
}

export function openPresetMenu() {
  const all = loadJson<Presets>(PRESETS_KEY, {});
  const names = Object.keys(all);
  if (names.length === 0) return ui.toast("No saved workspaces yet");
  ui.openMenu(window.innerWidth / 2 - 110, 120, [
    ...names.map((n) => ({
      label: n,
      run: () => {
        const preset = parsePreset(all[n]);
        if (!preset || !workspace.restoreLayout(preset)) ui.toast(`Workspace "${n}" is damaged and can't be opened`);
      },
    })),
    "separator" as const,
    ...names.map((n) => ({
      label: `Delete "${n}"`,
      danger: true,
      run: () => {
        const copy = { ...all };
        delete copy[n];
        saveJson(PRESETS_KEY, copy);
      },
    })),
  ]);
}

/** "Paste as link": links to the copied items instead of copies of them. */
export async function pasteAsLink(tab: TabModel, kind: LinkKind) {
  if (blockedInArchive(tab)) return;
  const c = ops.clip();
  if (!c || c.archive || c.paths.length === 0) return ui.toast("Copy the items to link to first");
  try {
    const [made, errors] = await createLinks(kind, [...c.paths], tab.path());
    if (made.length) await tab.navigate(tab.path(), made.map(baseName));
    if (errors.length) ui.toast(made.length ? `Made ${made.length} link${made.length === 1 ? "" : "s"}. ${errors[0]}` : `Couldn't make the link: ${errors[0]}`);
  } catch (e) {
    ui.toast(`Couldn't make the link: ${errorText(e)}`);
  }
}

export function openPasteAsLinkMenu(tab: TabModel, x = window.innerWidth / 2 - 110, y = 120) {
  ui.openMenu(x, y, [
    { label: "Symbolic link", run: () => void pasteAsLink(tab, "symbolic") },
    { label: "Junction (folders)", run: () => void pasteAsLink(tab, "junction") },
    { label: "Hard link (files, same drive)", run: () => void pasteAsLink(tab, "hard") },
  ]);
}

/** The active tab of the other pane (the next one after the active pane). */
export function otherPaneTab(): TabModel | null {
  const ids = leaves(workspace.layout());
  if (ids.length < 2) return null;
  const at = ids.indexOf(workspace.activePaneId());
  return workspace.paneModel(ids[(at + 1) % ids.length]).activeTab() ?? null;
}

/** Turns folder compare on (between the two panes) or off. */
export function toggleCompare() {
  if (compare.active()) {
    compare.stop();
    return ui.toast("Compare off");
  }
  const here = workspace.activeTab();
  const there = otherPaneTab();
  if (!here) return;
  if (!there) {
    workspace.split("row");
    return ui.toast("Open the folder to compare with in the new pane, then compare again");
  }
  if (samePath(here.path(), there.path())) return ui.toast("Both panes show the same folder. Open another folder in one of them first");
  compare.start(here, there);
  const n = countStatuses(compare.statusOf(here) ?? new Map());
  ui.toast(`Compared with ${baseName(there.path()) || there.path()}: ${n.only} only here, ${n.newer} newer here, ${n.older} older here, ${n.differs} different size`);
}

/** Selects what the other pane lacks or has an older copy of. */
export function selectDifferences(tab: TabModel) {
  const statuses = compare.statusOf(tab);
  if (!statuses) return ui.toast("Turn on Compare first (two panes)");
  const l = tab.listing();
  const picked = new Set([...tab.view()].filter((e) => isDifference(statuses.get(baseOf(l.names[e]).toLowerCase()))));
  tab.setSelection(picked);
  ui.toast(picked.size ? `Selected ${picked.size} item${picked.size === 1 ? "" : "s"} that differ` : "Nothing differs");
}

/** Copies or moves the selection into the other pane's folder (conflicts ask first). */
export function sendToOtherPane(tab: TabModel, kind: "copy" | "move") {
  if (kind === "move" && blockedInArchive(tab)) return;
  const there = otherPaneTab();
  if (!there) return ui.toast("Open a second pane first (Ctrl+\)");
  if (there.archive()) return ui.toast("Archives are read-only here.");
  const paths = targets(tab);
  if (paths.length === 0) return;
  if (tab.archive()) return dropPaths(paths, there.path(), true, tab.archive());
  void ops.transfer(kind, paths, there.path());
}

/** Copy or move the selection to a folder chosen in the Windows folder picker. */
export async function transferToPicked(tab: TabModel, kind: "copy" | "move") {
  if (kind === "move" && blockedInArchive(tab)) return;
  const paths = targets(tab);
  if (paths.length === 0) return;
  let dest: string | null;
  try {
    dest = await pickFolderDialog(otherPaneTab()?.path() ?? tab.path());
  } catch (e) {
    return void ui.toast(`Couldn't open the folder picker: ${errorText(e)}`);
  }
  if (!dest) return;
  if (tab.archive()) return dropPaths(paths, dest, true, tab.archive());
  void ops.transfer(kind, paths, dest);
}

/** Opens a folder in the editor chosen in Settings (the project, for editors that take folders). */
export async function openFolderInEditor(path: string) {
  const editor = settings.editorPath();
  if (!editor) {
    ui.toast("Choose an editor first", { label: "Settings", onClick: () => ui.openSettings("general") });
    return;
  }
  try {
    await openInEditor(path, editor);
  } catch (e) {
    ui.toast(`Couldn't open the editor: ${errorText(e)}`);
  }
}

const IMAGE_FILE = /\.(jpe?g|png|gif|bmp|webp)$/i;

/** Opens the resize / convert dialog for the pictures in the selection. */
export function openImageTools(tab: TabModel) {
  if (tab.archive()) return;
  const pics = targets(tab).filter((p) => IMAGE_FILE.test(p));
  if (pics.length === 0) return void ui.toast("Select a picture first (JPEG, PNG, GIF, BMP or WebP)");
  ui.setImageToolsPaths(pics);
}

export function openTerminalAt(path: string) {
  openTerminalHere(path).catch((e) => ui.toast(`Couldn't open a terminal: ${errorText(e)}`));
}

export function invertSelected(tab: TabModel) {
  tab.setSelection(invertSelection(tab.view(), tab.selection()));
}

/** Selects every item of the focused item's type: same extension, or all folders. */
export function selectSameType(tab: TabModel) {
  const l = tab.listing();
  const entry = [...tab.selection()][0] ?? tab.view()[tab.focus()];
  if (entry === undefined) return;
  const folder = isDir(l, entry);
  const ext = extensionOf(l.names[entry]);
  // Folders never match a file's extension.
  const picked = new Set([...tab.view()].filter((e) => (folder ? isDir(l, e) : !isDir(l, e) && extensionOf(l.names[e]) === ext)));
  tab.setSelection(picked);
  ui.toast(`Selected ${picked.size} item${picked.size === 1 ? "" : "s"}`);
}

export function selectByPattern(tab: TabModel) {
  ui.askText({
    title: "Select by pattern",
    label: "Pattern, e.g. *.jpg; IMG_* or re:^\\d+",
    onSubmit: (text) => {
      try {
        const picked = selectWhere(tab.view(), tab.listing().names, namePattern(text));
        tab.setSelection(picked);
        ui.toast(picked.size ? `Selected ${picked.size} item${picked.size === 1 ? "" : "s"}` : "Nothing matches");
      } catch (e) {
        ui.toast(`That pattern isn't valid: ${errorText(e)}`);
      }
    },
  });
}

export function pasteInto(tab: TabModel) {
  if (!blockedInArchive(tab)) ops.paste(tab.path());
}

export function openBatchRename(tab: TabModel) {
  if (!blockedInArchive(tab) && tab.selection().size > 0) ui.setBatchRenameOpen(true);
}

/** OneDrive: keep the selected files on this device, or free the space they take. */
export async function setCloudKeep(tab: TabModel, keep: boolean) {
  const paths = targets(tab);
  if (paths.length === 0) return;
  try {
    await setCloudPin(paths, keep);
    ui.toast(keep ? "These items will be kept on this device" : "Freeing up space. The items stay available online");
    void tab.refresh();
  } catch (e) {
    ui.toast(errorText(e));
  }
}

/** Runs one of the user's custom actions on the selection. */
export function runAction(tab: TabModel, action: CustomAction) {
  if (tab.archive()) return ui.toast("Copy the items out of the archive first");
  const paths = targets(tab);
  const command = expandCommand(action.command, paths, tab.path());
  runCustomAction(command, tab.path(), action.mode === "console").catch((e) => ui.toast(`Couldn't run "${action.name}": ${errorText(e)}`));
}

/** Custom actions that fit the selection, for menus. */
export function actionsFor(tab: TabModel): readonly CustomAction[] {
  const names = targets(tab).map(baseName);
  return customActions.list().filter((a) => actionApplies(a, names));
}

/** The Actions… menu: actions that fit the selection, then a way to edit them. */
export function openActionsMenu(tab: TabModel, x = window.innerWidth / 2 - 110, y = 120) {
  const fits = actionsFor(tab);
  ui.openMenu(x, y, [
    ...fits.map((a) => ({ label: a.name, run: () => runAction(tab, a) })),
    ...(fits.length ? ["separator" as const] : []),
    { label: customActions.list().length ? "Edit custom actions…" : "Add a custom action…", run: () => ui.setActionsEditorOpen(true) },
  ]);
}

/** Stage / unstage / discard for the selection in a Git folder. Discard asks first. */
export function gitAct(tab: TabModel, action: GitChange) {
  const paths = targets(tab);
  if (!paths.length) return;
  const run = () =>
    gitChange(paths, action)
      .then(() => {
        ui.toast(action === "stage" ? "Staged" : action === "unstage" ? "Unstaged" : "Changes discarded");
        void tab.refresh();
      })
      .catch((e) => ui.toast(`Git: ${errorText(e)}`));
  if (action !== "discard") return void run();
  ui.ask({
    title: "Discard changes?",
    body: `Uncommitted changes to ${paths.length === 1 ? `"${baseName(paths[0])}"` : `${paths.length} items`} will be thrown away and the last committed version restored. This can't be undone.`,
    confirmLabel: "Discard changes",
    danger: true,
    onConfirm: () => void run(),
  });
}

export function editTags(tab: TabModel) {
  if (tab.archive()) return ui.toast("Items inside archives can't be tagged");
  const paths = targets(tab);
  if (paths.length) ui.setTagPaths(paths);
}

/** Saves the tab's current search to the sidebar. */
export function saveSearch(tab: TabModel) {
  const s = tab.search();
  if (!s) return ui.toast("Search a folder first (Ctrl+Shift+F), then save the search");
  ui.askText({
    title: "Save this search",
    label: "Name",
    initial: s.query || `Everything in ${baseName(tab.path()) || tab.path()}`,
    onSubmit: (name) => {
      savedSearches.add({ name, root: tab.path(), query: s.query });
      ui.toast(`Saved "${name}" to the sidebar`);
    },
  });
}

export function showProperties(tab: TabModel) {
  if (tab.archive()) return ui.toast("Properties are not available inside archives");
  const paths = targets(tab);
  ui.setPropertiesPaths(paths.length ? paths : [tab.path()]);
}

export function whoLocks(tab: TabModel) {
  const paths = targets(tab);
  if (paths.length) ui.setLockPaths(paths);
}

/** Extracts an archive (or selected items inside one) next to the archive. */
export function extractHere(tab: TabModel) {
  const paths = targets(tab);
  const inside = tab.archive();
  if (inside) {
    const dest = parentPath(inside) ?? inside;
    return void ops.run({ kind: "extract", archive: inside, items: paths.map((p) => p.slice(inside.length + 1)), dest }, `Extracting ${paths.length} item${paths.length === 1 ? "" : "s"}`);
  }
  ui.toast("Open the archive, select items, then extract them");
}

export async function newFolder(tab: TabModel) {
  if (blockedInArchive(tab)) return;
  try {
    const created = await createFolder(tab.path(), "New folder");
    ops.record({ kind: "newFolder", label: `New folder "${baseName(created)}"`, path: created });
    await tab.navigate(tab.path(), [baseName(created)]);
    const entry = [...tab.selection()][0];
    if (entry !== undefined) tab.setRenaming(entry);
  } catch (e) {
    ui.toast(`Couldn't create a folder: ${errorText(e)}`);
  }
}

/** Creates a file (empty, or from a template) in the tab's folder and starts renaming it. */
export async function newFile(tab: TabModel, name = "New text document.txt", template?: string) {
  if (blockedInArchive(tab)) return;
  try {
    const created = await createFile(tab.path(), name, template);
    ops.record({ kind: "newFile", label: `New file "${baseName(created)}"`, path: created });
    await tab.navigate(tab.path(), [baseName(created)]);
    const entry = [...tab.selection()][0];
    if (entry !== undefined) tab.setRenaming(entry);
  } catch (e) {
    ui.toast(`Couldn't create a file: ${errorText(e)}`);
  }
}

/** Built-in kinds of new file, before the user's own templates. */
const NEW_FILE_KINDS: readonly { label: string; name: string }[] = [
  { label: "Text document", name: "New text document.txt" },
  { label: "Markdown document", name: "New document.md" },
  { label: "Empty file (no extension)", name: "New file" },
];

/** The "New file" menu: built-in kinds, the templates folder's files, and a way to add templates. */
export async function openNewFileMenu(tab: TabModel, x = window.innerWidth / 2 - 110, y = 120) {
  if (blockedInArchive(tab)) return;
  const templates = await listTemplates().catch(() => [] as string[]);
  ui.openMenu(x, y, [
    ...NEW_FILE_KINDS.map((k) => ({ label: k.label, run: () => void newFile(tab, k.name) })),
    ...(templates.length ? ["separator" as const, ...templates.map((t) => ({ label: t, run: () => void newFile(tab, t, t) }))] : []),
    "separator" as const,
    {
      label: templates.length ? "Open templates folder" : "Add your own templates…",
      run: () =>
        void templatesFolder()
          .then((dir) => {
            openInNewTab(dir, false);
            if (!templates.length) ui.toast("Put files here to use them as templates for new files");
          })
          .catch((e) => ui.toast(errorText(e))),
    },
  ]);
}

const ARCHIVE_FORMATS: readonly { format: ArchiveFormat; label: string; ext: string }[] = [
  { format: "zip", label: "Zip archive (.zip)", ext: ".zip" },
  { format: "sevenZ", label: "7-Zip archive (.7z)", ext: ".7z" },
  { format: "tarGz", label: "Tar archive (.tar.gz)", ext: ".tar.gz" },
];

/** A name for the archive: the item's own name for one item, else the folder's. */
function archiveBaseName(tab: TabModel, paths: readonly string[]): string {
  if (paths.length === 1) {
    const name = baseName(paths[0]);
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
  }
  return baseName(tab.path()) || "Archive";
}

/** Packs the selection into a new archive in the current folder. */
export function compressSelection(tab: TabModel, format: ArchiveFormat) {
  if (blockedInArchive(tab)) return;
  const paths = targets(tab);
  if (paths.length === 0) return ui.toast("Select what to compress");
  const kind = ARCHIVE_FORMATS.find((f) => f.format === format)!;
  ui.askText({
    title: `Compress to ${kind.ext}`,
    label: "Archive name",
    initial: archiveBaseName(tab, paths),
    submitLabel: "Compress",
    onSubmit: (name) => void ops.run({ kind: "compress", sources: [...paths], dest: tab.path(), name, format }, `Compressing ${paths.length === 1 ? `"${baseName(paths[0])}"` : `${paths.length} items`}`),
  });
}

export function openCompressMenu(tab: TabModel, x = window.innerWidth / 2 - 110, y = 120) {
  ui.openMenu(x, y, ARCHIVE_FORMATS.map((f) => ({ label: f.label, run: () => compressSelection(tab, f.format) })));
}

/** A small menu to group the list by type, date, size or first letter (or not at all). */
export function openGroupMenu(tab: TabModel, x = window.innerWidth / 2 - 110, y = 120) {
  const current = tab.groupBy();
  ui.openMenu(x, y, GROUP_KEYS.map((key) => ({ label: `${key === current ? "✓ " : "   "}${key === "none" ? "No grouping" : GROUP_TITLES[key]}`, run: () => tab.setGroupBy(key) })));
}

/** Steps through the grouping choices: none, type, date, size, name. */
export function cycleGroup(tab: TabModel) {
  const next = GROUP_KEYS[(GROUP_KEYS.indexOf(tab.groupBy()) + 1) % GROUP_KEYS.length];
  tab.setGroupBy(next);
  ui.toast(next === "none" ? "Grouping off" : `Grouped by ${GROUP_TITLES[next].toLowerCase()}`);
}

/** Copies the target paths, or the given ones (e.g. just the folder), as text. */
export function copyPaths(tab: TabModel, explicit?: readonly string[]) {
  return copyPathsAs(tab, "plain", explicit);
}

/** Copies the target paths (or the folder, when nothing is picked) in one of the "Copy as" formats. */
export async function copyPathsAs(tab: TabModel, format: PathFormat, explicit?: readonly string[]) {
  const picked = explicit ?? targets(tab);
  const paths = picked.length ? picked : [tab.path()];
  await writeClipboardText(formatPaths(paths, format, tab.path()));
  const what = format === "name" ? "name" : "path";
  ui.toast(paths.length > 1 ? `Copied ${paths.length} ${what}s` : `Copied ${what}`);
}

/** The "Copy as" menu, opened where the context menu was. */
export function openCopyAsMenu(tab: TabModel, x = window.innerWidth / 2 - 110, y = 120) {
  ui.openMenu(x, y, PATH_FORMATS.map((f) => ({ label: f.label, shortcut: f.example, run: () => void copyPathsAs(tab, f.id) })));
}

async function writeClipboardText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

/** Programs and scripts Windows can start with administrator rights (mirrors the backend's list). */
export const ADMIN_RUNNABLE = /\.(exe|bat|cmd|msi|ps1|com)$/i;

export function openWithDialog(tab: TabModel) {
  const path = targets(tab)[0];
  if (!path || tab.archive()) return ui.toast(tab.archive() ? "Copy the file out of the archive first" : "Select a file first");
  openWith(path).catch((e) => ui.toast(errorText(e)));
}

export function runSelectedAsAdmin(tab: TabModel) {
  const path = targets(tab)[0];
  if (!path || tab.archive() || !ADMIN_RUNNABLE.test(path)) return ui.toast("Select a program or script to run as administrator");
  runAsAdmin(path).catch((e) => ui.toast(`Couldn't run as administrator: ${errorText(e)}`));
}

/**
 * Safely ejects a drive. Tabs showing it move to the home folder first, so
 * Octopolis's own folder watchers don't keep the drive busy.
 */
export async function ejectDriveSafely(root: string, home: string, onDone?: () => void) {
  const onDrive = (p: string) => p.toLowerCase().startsWith(root.toLowerCase());
  const moved = workspace.allTabs().filter((t) => onDrive(t.path()));
  await Promise.all(moved.map((t) => t.navigate(home)));
  const label = root.replace(/\\$/, "");
  ui.toast(`Ejecting ${label}…`);
  try {
    await ejectDrive(root);
    ui.toast(`${label} can be removed safely`);
  } catch (e) {
    ui.toast(`Couldn't eject ${label}: ${errorText(e)}`);
  } finally {
    onDone?.();
  }
}

export function reveal(tab: TabModel, explicit?: string) {
  const path = explicit ?? targets(tab)[0] ?? tab.path();
  revealInExplorer(path).catch((e) => ui.toast(errorText(e)));
}

/** Drag-and-drop transfer: move within a drive, copy across drives, Ctrl forces copy. */
export function dropPaths(sources: readonly string[], dest: string, forceCopy: boolean, archive?: string | null, destReadOnly?: boolean) {
  if (sources.length === 0) return;
  if (destReadOnly) return ui.toast("Archives are read-only here.");
  if (archive) {
    const items = sources.map((s) => s.slice(archive.length + 1));
    return void ops.run({ kind: "extract", archive, items, dest }, `Extracting ${sources.length} item${sources.length === 1 ? "" : "s"}`);
  }
  const move = !forceCopy && sources.every((s) => sameVolume(s, dest));
  void ops.transfer(move ? "move" : "copy", sources, dest);
}
