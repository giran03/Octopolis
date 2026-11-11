// Every user-invokable action, with its default shortcuts. The keyboard
// handler, the command palette and the shortcuts editor all read this list.
import * as A from "./actions";
import { listHandles } from "./components/Pane";
import { moveFocus, selectAll, selectAt, type NavKey } from "./lib/selection";
import { ops } from "./state/ops";
import { settings } from "./state/settings";
import type { TabModel } from "./state/tab";
import { ui } from "./state/ui";
import { workspace } from "./state/workspace";

export type Category = "File" | "Navigate" | "Tabs" | "Panes" | "View" | "Search" | "App" | "List";

export interface Command {
  readonly id: string;
  readonly title: string;
  readonly category: Category;
  /** Default shortcuts; a sequence like "ctrl+k ctrl+s" is a chord. */
  readonly keys?: readonly string[];
  /** Extra keys active in Vim mode. */
  readonly vimKeys?: readonly string[];
  /** Also runs while a text field has focus. */
  readonly global?: boolean;
  /** Hidden from the palette (raw list movement). */
  readonly hidden?: boolean;
  /** When false the key is not consumed and keeps its normal meaning. */
  readonly when?: () => boolean;
  readonly run: () => void;
}

const tab = () => workspace.activeTab();
const withTab = (fn: (t: TabModel) => void) => () => {
  const t = tab();
  if (t) fn(t);
};

/** Moves the list focus; Shift (or Vim visual mode) extends the selection. */
export function moveTo(t: TabModel, pos: number, extend: boolean, keepSelection = false) {
  t.setFocus(pos);
  if (!keepSelection) {
    const r = selectAt(t.view(), t.selection(), t.anchor(), pos, { ctrl: false, shift: extend || ui.visual() });
    t.setSelection(r.selection);
    t.setAnchor(r.anchor);
  }
  listHandles.get(t)?.ensureVisible(pos);
}

const move = (key: NavKey) =>
  withTab((t) => moveTo(t, moveFocus(t.view().length, t.focus(), key, listHandles.get(t)?.pageRows() ?? 20), false));

function toggleFlatView(t: TabModel) {
  const s = t.search();
  if (s && s.query === "") t.exitSearch();
  else void t.runSearch("");
}

export const COMMANDS: readonly Command[] = [
  // Navigate
  { id: "nav.back", title: "Go back", category: "Navigate", keys: ["alt+arrowleft"], run: withTab((t) => t.back()) },
  { id: "nav.forward", title: "Go forward", category: "Navigate", keys: ["alt+arrowright"], run: withTab((t) => t.forward()) },
  { id: "nav.up", title: "Go to parent folder", category: "Navigate", keys: ["alt+arrowup", "backspace"], vimKeys: ["h"], run: withTab((t) => t.up()) },
  { id: "nav.refresh", title: "Refresh", category: "Navigate", keys: ["f5", "ctrl+r"], run: withTab((t) => void t.refresh()) },
  { id: "nav.editPath", title: "Edit path", category: "Navigate", keys: ["ctrl+l"], global: true, run: () => ui.requestFocus(workspace.activePaneId(), "path") },
  { id: "palette.go", title: "Go to folder…", category: "Navigate", keys: ["ctrl+p"], global: true, run: () => ui.openPalette("go") },

  // File
  { id: "file.open", title: "Open", category: "File", keys: ["enter"], vimKeys: ["l"], run: withTab(A.openSelection) },
  { id: "file.rename", title: "Rename", category: "File", keys: ["f2"], run: withTab(A.startRename) },
  { id: "file.newFolder", title: "New folder", category: "File", keys: ["ctrl+shift+n"], run: withTab((t) => void A.newFolder(t)) },
  { id: "file.copy", title: "Copy", category: "File", keys: ["ctrl+c"], vimKeys: ["y y"], run: withTab((t) => A.copySelection(t, "copy")) },
  { id: "file.cut", title: "Cut", category: "File", keys: ["ctrl+x"], vimKeys: ["d d"], run: withTab((t) => A.copySelection(t, "cut")) },
  { id: "file.paste", title: "Paste", category: "File", keys: ["ctrl+v"], vimKeys: ["p"], run: withTab((t) => ops.paste(t.path())) },
  { id: "file.delete", title: "Delete (Recycle Bin)", category: "File", keys: ["delete"], run: withTab((t) => A.deleteSelection(t, false)) },
  { id: "file.deletePermanently", title: "Delete permanently", category: "File", keys: ["shift+delete"], run: withTab((t) => A.deleteSelection(t, true)) },
  { id: "file.copyPath", title: "Copy path", category: "File", keys: ["ctrl+shift+c"], run: withTab((t) => void A.copyPaths(t)) },
  { id: "file.reveal", title: "Show in Windows Explorer", category: "File", run: withTab((t) => A.reveal(t)) },
  { id: "file.selectAll", title: "Select all", category: "File", keys: ["ctrl+a"], run: withTab((t) => t.setSelection(selectAll(t.view()))) },

  // Search and view
  { id: "view.filter", title: "Filter this folder", category: "Search", keys: ["ctrl+f"], vimKeys: ["/"], global: true, run: () => ui.requestFocus(workspace.activePaneId(), "filter") },
  {
    id: "search.tree",
    title: "Search in subfolders",
    category: "Search",
    keys: ["ctrl+shift+f"],
    global: true,
    run: () => {
      const t = tab();
      if (t && !t.search()) void t.runSearch("");
      ui.requestFocus(workspace.activePaneId(), "filter");
    },
  },
  { id: "search.flat", title: "Toggle flat view (all files in subfolders)", category: "Search", keys: ["ctrl+shift+e"], run: withTab(toggleFlatView) },
  { id: "view.hidden", title: "Show or hide hidden items", category: "View", keys: ["ctrl+h"], global: true, run: settings.toggleHidden },
  { id: "view.sidebar", title: "Show or hide the sidebar", category: "View", keys: ["ctrl+b"], global: true, run: settings.toggleSidebar },

  // Tabs and panes
  { id: "tab.new", title: "New tab", category: "Tabs", keys: ["ctrl+t"], global: true, run: () => workspace.newTab() },
  { id: "tab.close", title: "Close tab", category: "Tabs", keys: ["ctrl+w"], global: true, run: () => {
      const t = tab();
      if (t) workspace.closeTab(workspace.activePaneId(), t.id);
    } },
  { id: "tab.reopen", title: "Reopen closed tab", category: "Tabs", keys: ["ctrl+shift+t"], global: true, run: () => workspace.reopenTab() },
  { id: "tab.next", title: "Next tab", category: "Tabs", keys: ["ctrl+tab"], global: true, run: () => workspace.cycleTab(1) },
  { id: "tab.prev", title: "Previous tab", category: "Tabs", keys: ["ctrl+shift+tab"], global: true, run: () => workspace.cycleTab(-1) },
  { id: "pane.splitRight", title: "Split pane right", category: "Panes", keys: ["ctrl+\\"], global: true, run: () => workspace.split("row") },
  { id: "pane.splitDown", title: "Split pane down", category: "Panes", keys: ["ctrl+shift+\\"], global: true, run: () => workspace.split("column") },
  { id: "pane.close", title: "Close pane", category: "Panes", keys: ["ctrl+shift+w"], global: true, run: () => workspace.closePane(workspace.activePaneId()) },
  { id: "pane.next", title: "Next pane", category: "Panes", keys: ["f6"], global: true, run: () => workspace.cyclePane(1) },
  { id: "pane.prev", title: "Previous pane", category: "Panes", keys: ["shift+f6"], global: true, run: () => workspace.cyclePane(-1) },
  { id: "pane.switch", title: "Switch to the other pane", category: "Panes", keys: ["tab"], hidden: true, when: () => workspace.paneCount() > 1, run: () => workspace.cyclePane(1) },

  // App
  { id: "palette.commands", title: "Show all commands", category: "App", keys: ["ctrl+shift+p"], global: true, run: () => ui.openPalette("commands") },
  { id: "app.shortcuts", title: "Keyboard shortcuts", category: "App", keys: ["ctrl+k ctrl+s"], global: true, run: () => ui.setShortcutsOpen(true) },
  { id: "app.vim", title: "Toggle Vim keys (h j k l, gg, G, yy, dd, p, v)", category: "App", run: () => {
      settings.toggleVim();
      ui.setVisual(false);
      ui.toast(settings.vimMode() ? "Vim keys on" : "Vim keys off");
    } },

  // List movement (Vim layer; arrows are handled directly)
  { id: "list.down", title: "Move down", category: "List", vimKeys: ["j"], hidden: true, run: move("ArrowDown") },
  { id: "list.up", title: "Move up", category: "List", vimKeys: ["k"], hidden: true, run: move("ArrowUp") },
  { id: "list.top", title: "Go to first item", category: "List", vimKeys: ["g g"], hidden: true, run: move("Home") },
  { id: "list.bottom", title: "Go to last item", category: "List", vimKeys: ["shift+g"], hidden: true, run: move("End") },
  { id: "list.visual", title: "Visual selection mode", category: "List", vimKeys: ["v"], hidden: true, run: () => {
      ui.setVisual(!ui.visual());
      ui.toast(ui.visual() ? "Visual mode: move to extend the selection" : "Visual mode off");
    } },
  { id: "list.clear", title: "Clear selection or filter", category: "List", keys: ["escape"], hidden: true, run: withTab((t) => {
      if (ui.visual()) return ui.setVisual(false);
      if (t.search()) return t.exitSearch();
      if (t.filter()) return t.setFilter("");
      t.setSelection(new Set<number>());
    }) },
];

const byId = new Map(COMMANDS.map((c) => [c.id, c]));
export const commandById = (id: string) => byId.get(id);
