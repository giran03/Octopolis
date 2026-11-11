// File actions shared by keyboard shortcuts, the context menu and the toolbar.
import { createFolder, errorText, extractAndOpen, nativeMenu, openPath, renameItem, revealInExplorer } from "./lib/ipc";
import { baseOf, isDir } from "./lib/listing";
import { baseName, joinPath, sameVolume } from "./lib/paths";
import { ops } from "./state/ops";
import { loadJson, saveJson } from "./state/settings";
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
export function targets(tab: TabModel): string[] {
  const picked = tab.selectedPaths();
  if (picked.length) return picked;
  const entry = tab.view()[tab.focus()];
  return entry === undefined ? [] : [tab.pathOf(entry)];
}

export function openEntry(tab: TabModel, entry: number) {
  const l = tab.listing();
  if (entry >= l.count) return;
  const full = tab.pathOf(entry);
  if (isDir(l, entry) || ARCHIVE_NAME.test(l.names[entry])) return void tab.navigate(full);
  const open = tab.archive() ? extractAndOpen : openPath;
  open(full).catch((e) => ui.toast(`Couldn't open ${l.names[entry]}: ${errorText(e)}`));
}

/** Opens a path from a view that isn't index-based (Miller columns). */
export function openFromPath(tab: TabModel, path: string) {
  const open = tab.archive() ? extractAndOpen : openPath;
  if (ARCHIVE_NAME.test(path)) return void tab.navigate(path);
  open(path).catch((e) => ui.toast(errorText(e)));
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

export function deleteSelection(tab: TabModel, permanent: boolean) {
  if (blockedInArchive(tab)) return;
  const paths = targets(tab);
  if (paths.length === 0) return;
  if (!permanent) return ops.remove(paths, false);
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
type Presets = Record<string, ReturnType<typeof workspace.snapshotLayout>>;

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
    ...names.map((n) => ({ label: n, run: () => workspace.restoreLayout(all[n]) })),
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

export function pasteInto(tab: TabModel) {
  if (!blockedInArchive(tab)) ops.paste(tab.path());
}

export function openBatchRename(tab: TabModel) {
  if (!blockedInArchive(tab) && tab.selection().size > 0) ui.setBatchRenameOpen(true);
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
    const dest = inside.slice(0, inside.lastIndexOf("\\")) || inside;
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

/** Copies the target paths, or the given ones (e.g. just the folder), as text. */
export async function copyPaths(tab: TabModel, explicit?: readonly string[]) {
  const paths = explicit ?? targets(tab);
  const text = (paths.length ? paths : [tab.path()]).join("\r\n");
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
  ui.toast(paths.length > 1 ? `Copied ${paths.length} paths` : "Copied path");
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
  const what = sources.length === 1 ? `"${baseName(sources[0])}"` : `${sources.length} items`;
  void ops.run({ kind: move ? "move" : "copy", sources: [...sources], dest }, `${move ? "Moving" : "Copying"} ${what}`);
}
