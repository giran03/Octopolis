// "Show in folder" from other apps. Tells Windows which folders the tabs are
// showing, and selects the files other apps ask for in the tab that has them.
import { createEffect, createRoot } from "solid-js";
import { explorerCatchSet, SHOW_ITEMS_EVENT, shellWindowsSync, type ShowItems } from "../lib/ipc";
import { baseName, samePath } from "../lib/paths";
import { settings } from "./settings";
import { workspace } from "./workspace";

/** Folders worth listing: real folders only, not archives or search results. */
export function listedFolders(tabs: readonly { path: () => string; archive: () => string | null }[]): string[] {
  const out: string[] = [];
  for (const t of tabs) {
    const p = t.path();
    if (!p || t.archive() || /^shell:/i.test(p) || p.startsWith("::")) continue;
    if (!out.some((o) => samePath(o, p))) out.push(p);
  }
  return out;
}

/** Brings the tab showing `folder` forward and selects the items. Prefers the tab already in front. */
export function showItems({ folder, items }: ShowItems): void {
  const names = items.map(baseName);
  const active = workspace.activeTab();
  if (active && samePath(active.path(), folder)) {
    void active.navigate(active.path(), names);
    return;
  }
  for (const paneId of workspace.paneIds()) {
    const tab = workspace.paneModel(paneId).tabs().find((t) => samePath(t.path(), folder));
    if (!tab) continue;
    workspace.selectTab(paneId, tab.id);
    void tab.navigate(tab.path(), names);
    return;
  }
  // The tab was closed in the moment between the request and now: open the folder again.
  workspace.newTab(workspace.activePaneId(), folder);
  void workspace.activeTab()?.navigate(folder, names);
}

let started = false;

/** Call once, after the first tabs exist. */
export function startShellWindows(): void {
  if (started) return;
  started = true;
  createRoot(() => {
    createEffect(() => void shellWindowsSync(listedFolders(workspace.allTabs())).catch(() => undefined));
    createEffect(() => void explorerCatchSet(settings.catchExplorer()).catch(() => undefined));
  });
  void import("@tauri-apps/api/event").then(({ listen }) => listen<ShowItems>(SHOW_ITEMS_EVENT, (e) => showItems(e.payload))).catch(() => undefined);
}
