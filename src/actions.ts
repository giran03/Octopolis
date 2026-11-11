// File actions shared by keyboard shortcuts, the context menu and the toolbar.
import { createFolder, errorText, openPath, renameItem, revealInExplorer } from "./lib/ipc";
import { isDir } from "./lib/listing";
import { baseName, joinPath, sameVolume } from "./lib/paths";
import { ops } from "./state/ops";
import type { TabModel } from "./state/tab";
import { ui } from "./state/ui";

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
  if (isDir(l, entry)) void tab.navigate(full);
  else openPath(full).catch((e) => ui.toast(`Couldn't open ${l.names[entry]}: ${errorText(e)}`));
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
  ops.setClip({ mode, paths });
  ui.toast(`${mode === "cut" ? "Cut" : "Copied"} ${paths.length === 1 ? `"${baseName(paths[0])}"` : `${paths.length} items`}`);
}

export function deleteSelection(tab: TabModel, permanent: boolean) {
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
  const sel = [...tab.selection()];
  const entry = sel.length === 1 ? sel[0] : tab.view()[tab.focus()];
  if (entry !== undefined) tab.setRenaming(entry);
}

export async function commitRename(tab: TabModel, entry: number, newName: string) {
  tab.setRenaming(null);
  const l = tab.listing();
  const old = l.names[entry];
  const name = newName.trim();
  if (!name || name === old) return;
  try {
    await renameItem(joinPath(l.path, old), name);
    await tab.navigate(tab.path(), [name]);
  } catch (e) {
    ui.toast(errorText(e));
  }
}

export async function newFolder(tab: TabModel) {
  try {
    const created = await createFolder(tab.path(), "New folder");
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
export function dropPaths(sources: readonly string[], dest: string, forceCopy: boolean) {
  if (sources.length === 0) return;
  const move = !forceCopy && sources.every((s) => sameVolume(s, dest));
  const what = sources.length === 1 ? `"${baseName(sources[0])}"` : `${sources.length} items`;
  void ops.run({ kind: move ? "move" : "copy", sources: [...sources], dest }, `${move ? "Moving" : "Copying"} ${what}`);
}
