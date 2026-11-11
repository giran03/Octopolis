// The keyboard map. One window-level handler drives the active tab.
import * as A from "./actions";
import { listHandles } from "./components/Pane";
import { moveFocus, NAV_KEYS, selectAll, selectAt, typeAhead, type NavKey } from "./lib/selection";
import { ops } from "./state/ops";
import { settings } from "./state/settings";
import type { TabModel } from "./state/tab";
import { ui } from "./state/ui";
import { workspace } from "./state/workspace";

const TYPE_AHEAD_RESET_MS = 700;
let typed = "";
let typedAt = 0;

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/** Shortcuts that work everywhere, even while typing in a field. */
function windowKeys(e: KeyboardEvent): boolean {
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const pane = workspace.activePaneId();
  if (ctrl && k === "t") workspace.newTab();
  else if (ctrl && k === "w" && e.shiftKey) workspace.closePane(pane);
  else if (ctrl && k === "w") {
    const tab = workspace.activeTab();
    if (tab) workspace.closeTab(pane, tab.id);
  }
  else if (ctrl && e.key === "Tab") workspace.cycleTab(e.shiftKey ? -1 : 1);
  else if (ctrl && (e.code === "Backslash" || k === "\\" || k === "|")) workspace.split(e.shiftKey ? "column" : "row");
  else if (ctrl && k === "l") ui.requestFocus(pane, "path");
  else if (ctrl && k === "f") ui.requestFocus(pane, "filter");
  else if (ctrl && k === "b") settings.toggleSidebar();
  else if (ctrl && k === "h") settings.toggleHidden();
  else if (e.key === "F6") workspace.cyclePane(e.shiftKey ? -1 : 1);
  else return false;
  return true;
}

function moveTo(tab: TabModel, pos: number, e: KeyboardEvent) {
  tab.setFocus(pos);
  if (!e.ctrlKey) {
    const r = selectAt(tab.view(), tab.selection(), tab.anchor(), pos, { ctrl: false, shift: e.shiftKey });
    tab.setSelection(r.selection);
    tab.setAnchor(r.anchor);
  }
  listHandles.get(tab)?.ensureVisible(pos);
}

/** Shortcuts for the file list; skipped while typing in a field. */
function listKeys(e: KeyboardEvent, tab: TabModel): boolean {
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const handle = listHandles.get(tab);

  if (NAV_KEYS.has(e.key) && !e.altKey) {
    moveTo(tab, moveFocus(tab.view().length, tab.focus(), e.key as NavKey, handle?.pageRows() ?? 20), e);
  } else if (e.key === " " && ctrl) {
    const r = selectAt(tab.view(), tab.selection(), tab.anchor(), tab.focus(), { ctrl: true, shift: false });
    tab.setSelection(r.selection);
  } else if (e.key === "Enter") A.openSelection(tab);
  else if (e.key === "Backspace" || (e.altKey && e.key === "ArrowUp")) tab.up();
  else if (e.altKey && e.key === "ArrowLeft") tab.back();
  else if (e.altKey && e.key === "ArrowRight") tab.forward();
  else if (e.key === "F5" || (ctrl && k === "r")) void tab.refresh();
  else if (e.key === "F2") A.startRename(tab);
  else if (e.key === "Delete") A.deleteSelection(tab, e.shiftKey);
  else if (ctrl && e.shiftKey && k === "n") void A.newFolder(tab);
  else if (ctrl && e.shiftKey && k === "c") void A.copyPaths(tab);
  else if (ctrl && k === "a") tab.setSelection(selectAll(tab.view()));
  else if (ctrl && k === "c") A.copySelection(tab, "copy");
  else if (ctrl && k === "x") A.copySelection(tab, "cut");
  else if (ctrl && k === "v") ops.paste(tab.path());
  else if (e.key === "Tab" && workspace.paneCount() > 1) workspace.cyclePane(e.shiftKey ? -1 : 1);
  else if (e.key === "Escape") {
    if (tab.filter()) tab.setFilter("");
    else tab.setSelection(new Set<number>());
  } else if (e.key.length === 1 && !ctrl && !e.altKey) {
    const now = performance.now();
    typed = now - typedAt > TYPE_AHEAD_RESET_MS ? e.key : typed + e.key;
    typedAt = now;
    const pos = typeAhead(tab.listing().names, tab.view(), tab.focus(), typed);
    if (pos >= 0) moveTo(tab, pos, e);
  } else return false;
  return true;
}

export function onKeyDown(e: KeyboardEvent) {
  if (ui.menu() || ui.confirm()) return;
  if (windowKeys(e)) return e.preventDefault();
  if (isEditable(e.target)) return;
  const tab = workspace.activeTab();
  if (tab && tab.renaming() === null && listKeys(e, tab)) e.preventDefault();
}
