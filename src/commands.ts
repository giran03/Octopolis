// Every user-invokable action, with its default shortcuts. The keyboard
// handler, the command palette and the shortcuts editor all read this list.
import * as A from "./actions";
import { listHandles } from "./components/Pane";
import { quitApp } from "./lib/ipc";
import { rules } from "./state/rules";
import { moveFocus, selectAll, selectAt, type NavKey } from "./lib/selection";
import { customActions } from "./state/customActions";
import { guide } from "./state/guide";
import { ops } from "./state/ops";
import { settings } from "./state/settings";
import { shelf } from "./state/shelf";
import { sidebar } from "./state/sidebar";
import type { TabModel } from "./state/tab";
import { ui } from "./state/ui";
import { inspector } from "./state/inspector";
import { workspace } from "./state/workspace";

export type Category = "File" | "Navigate" | "Tabs" | "Panes" | "View" | "Search" | "App" | "List" | "Actions";

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
  { id: "nav.back", title: "Go back", category: "Navigate", keys: ["alt+arrowleft", "browserback"], run: withTab((t) => t.back()) },
  { id: "nav.forward", title: "Go forward", category: "Navigate", keys: ["alt+arrowright", "browserforward"], run: withTab((t) => t.forward()) },
  { id: "nav.up", title: "Go to parent folder", category: "Navigate", keys: ["alt+arrowup", "backspace"], vimKeys: ["h"], run: withTab((t) => t.up()) },
  { id: "nav.refresh", title: "Refresh", category: "Navigate", keys: ["f5", "ctrl+r"], run: withTab((t) => void t.refresh()) },
  { id: "nav.editPath", title: "Edit path", category: "Navigate", keys: ["ctrl+l"], global: true, run: () => ui.requestFocus(workspace.activePaneId(), "path") },
  { id: "palette.go", title: "Go to folder…", category: "Navigate", keys: ["ctrl+p"], global: true, run: () => ui.openPalette("go") },

  // File
  { id: "file.open", title: "Open", category: "File", keys: ["enter"], vimKeys: ["l"], run: withTab(A.openSelection) },
  { id: "file.rename", title: "Rename", category: "File", keys: ["f2"], run: withTab(A.startRename) },
  { id: "file.newFolder", title: "New folder", category: "File", keys: ["ctrl+shift+n"], run: withTab((t) => void A.newFolder(t)) },
  { id: "file.newFile", title: "New text file", category: "File", keys: ["ctrl+alt+n"], run: withTab((t) => void A.newFile(t)) },
  { id: "file.newFromTemplate", title: "New file from template…", category: "File", run: withTab((t) => void A.openNewFileMenu(t)) },
  { id: "file.copy", title: "Copy", category: "File", keys: ["ctrl+c"], vimKeys: ["y y"], run: withTab((t) => A.copySelection(t, "copy")) },
  { id: "file.cut", title: "Cut", category: "File", keys: ["ctrl+x"], vimKeys: ["d d"], run: withTab((t) => A.copySelection(t, "cut")) },
  { id: "file.paste", title: "Paste", category: "File", keys: ["ctrl+v"], vimKeys: ["p"], run: withTab(A.pasteInto) },
  { id: "file.delete", title: "Delete (Recycle Bin)", category: "File", keys: ["delete"], run: withTab((t) => A.deleteSelection(t, false)) },
  { id: "file.deletePermanently", title: "Delete permanently", category: "File", keys: ["shift+delete"], run: withTab((t) => A.deleteSelection(t, true)) },
  { id: "file.pasteAsLink", title: "Paste as link…", category: "File", run: withTab((t) => A.openPasteAsLinkMenu(t)) },
  { id: "file.copyPath", title: "Copy path", category: "File", keys: ["ctrl+shift+c"], run: withTab((t) => void A.copyPaths(t)) },
  { id: "file.copyPathAs", title: "Copy path as…", category: "File", keys: ["ctrl+alt+c"], run: withTab((t) => A.openCopyAsMenu(t)) },
  { id: "file.undo", title: "Undo", category: "File", keys: ["ctrl+z"], vimKeys: ["u"], run: () => void ops.undo() },
  { id: "file.redo", title: "Redo", category: "File", keys: ["ctrl+y", "ctrl+shift+z"], run: () => void ops.redo() },
  { id: "file.batchRename", title: "Batch rename…", category: "File", keys: ["ctrl+shift+r"], run: withTab(A.openBatchRename) },
  { id: "tools.actions", title: "Run a custom action…", category: "File", run: withTab((t) => A.openActionsMenu(t)) },
  { id: "tools.editActions", title: "Edit custom actions…", category: "App", run: () => ui.setActionsEditorOpen(true) },
  { id: "git.stage", title: "Git: stage selection", category: "File", run: withTab((t) => A.gitAct(t, "stage")) },
  { id: "git.unstage", title: "Git: unstage selection", category: "File", run: withTab((t) => A.gitAct(t, "unstage")) },
  { id: "git.discard", title: "Git: discard changes to selection…", category: "File", run: withTab((t) => A.gitAct(t, "discard")) },
  { id: "git.hideIgnored", title: "Show or hide files Git ignores", category: "View", run: () => settings.set({ hideGitIgnored: !settings.hideGitIgnored() }) },
  { id: "file.tags", title: "Tags and color labels…", category: "File", keys: ["ctrl+shift+g"], run: withTab(A.editTags) },
  { id: "search.save", title: "Save this search to the sidebar…", category: "Search", run: withTab(A.saveSearch) },
  { id: "file.properties", title: "Properties", category: "File", keys: ["alt+enter"], run: withTab(A.showProperties) },
  { id: "file.whoLocks", title: "What is locking this?", category: "File", keys: ["ctrl+shift+l"], run: withTab(A.whoLocks) },
  { id: "file.compress", title: "Compress to zip…", category: "File", run: withTab((t) => A.compressSelection(t, "zip")) },
  { id: "file.compressAs", title: "Compress to…", category: "File", run: withTab((t) => A.openCompressMenu(t)) },
  { id: "file.extract", title: "Extract selected items from the archive", category: "File", run: withTab(A.extractHere) },
  { id: "file.reveal", title: "Show in Windows Explorer", category: "File", run: withTab((t) => A.reveal(t)) },
  { id: "file.edit", title: "Open in editor", category: "File", keys: ["ctrl+shift+o"], run: withTab(A.editSelection) },
  { id: "file.openWith", title: "Open with…", category: "File", run: withTab(A.openWithDialog) },
  { id: "file.run", title: "Run file", category: "File", run: withTab(A.runSelected) },
  { id: "file.install", title: "Install file", category: "File", run: withTab(A.installSelected) },
  { id: "file.runAsAdmin", title: "Run as administrator", category: "File", keys: ["ctrl+shift+enter"], run: withTab(A.runSelectedAsAdmin) },
  { id: "file.selectAll", title: "Select all", category: "File", keys: ["ctrl+a"], run: withTab((t) => t.setSelection(selectAll(t.view()))) },
  { id: "file.invertSelection", title: "Invert selection", category: "File", keys: ["ctrl+shift+i"], run: withTab(A.invertSelected) },
  { id: "file.selectSameType", title: "Select items of the same type", category: "File", run: withTab(A.selectSameType) },
  { id: "file.selectPattern", title: "Select matching…", category: "File", keys: ["ctrl+shift+a"], run: withTab(A.selectByPattern) },

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
  { id: "sidebar.pin", title: "Pin or unpin this folder in the sidebar", category: "View", run: withTab((t) => sidebar.togglePin(t.path())) },
  { id: "view.quickLook", title: "Quick look (full-window preview)", category: "View", keys: ["shift+space"], run: inspector.toggleQuickLook },
  { id: "view.inspector", title: "Show or hide the inspector", category: "View", keys: ["ctrl+i", "space"], run: settings.toggleInspector },
  { id: "view.sizes", title: "Calculate folder sizes", category: "View", keys: ["ctrl+shift+s"], run: withTab((t) => (t.sizesLive() ? t.clearSizes() : t.computeSizes())) },
  { id: "view.treemap", title: "Toggle disk space treemap", category: "View", keys: ["ctrl+shift+m"], run: withTab((t) => {
      if (!t.treemap() && !t.sizesLive()) t.computeSizes();
      t.setTreemap(!t.treemap());
    }) },
  { id: "transfer.verify", title: "Toggle verifying copies with checksums", category: "App", run: () => {
      settings.toggleVerify();
      ui.toast(settings.verifyCopies() ? "Copies will be verified with BLAKE3" : "Copy verification off");
    } },
  { id: "transfer.limit", title: "Cycle transfer speed limit", category: "App", run: () => {
      const steps = [null, 10, 50, 100, 500];
      const mb = settings.speedLimit() === null ? null : settings.speedLimit()! / 1048576;
      const next = steps[(steps.indexOf(mb) + 1) % steps.length];
      settings.setSpeedLimit(next === null ? null : next * 1048576);
      ui.toast(next === null ? "Transfer speed: unlimited" : `Transfer speed limit: ${next} MB/s`);
    } },
  { id: "view.terminal", title: "Show or hide the terminal", category: "View", keys: ["ctrl+`"], global: true, run: settings.toggleTerminal },
  { id: "view.details", title: "Details view", category: "View", keys: ["ctrl+1"], run: withTab((t) => t.setViewMode("details")) },
  { id: "view.grid", title: "Icon view (keeps the current icon size)", category: "View", keys: ["ctrl+2"], run: withTab((t) => t.setViewMode("grid")) },
  { id: "view.auto", title: "Auto view (choose from what the folder holds)", category: "View", keys: ["ctrl+shift+0"], run: withTab((t) => { settings.set({ autoView: true }); t.useAutoView(); }) },
  { id: "view.xl", title: "Extra large icons", category: "View", keys: ["ctrl+shift+1"], run: withTab((t) => t.setView("grid", 256)) },
  { id: "view.large", title: "Large icons", category: "View", keys: ["ctrl+shift+2"], run: withTab((t) => t.setView("grid", 160)) },
  { id: "view.medium", title: "Medium icons", category: "View", keys: ["ctrl+shift+3"], run: withTab((t) => t.setView("grid", 96)) },
  { id: "view.small", title: "Small icons", category: "View", keys: ["ctrl+shift+4"], run: withTab((t) => t.setView("grid", 56)) },
  { id: "view.list", title: "List view", category: "View", keys: ["ctrl+shift+5"], run: withTab((t) => t.setViewMode("list")) },
  { id: "view.detailsAlt", title: "Details view (Explorer shortcut)", category: "View", keys: ["ctrl+shift+6"], run: withTab((t) => t.setViewMode("details")) },
  { id: "view.tiles", title: "Tiles view", category: "View", keys: ["ctrl+shift+7"], run: withTab((t) => t.setViewMode("tiles")) },
  { id: "view.bento", title: "Bento view (pictures that fill each row)", category: "View", keys: ["ctrl+shift+9"], run: withTab((t) => t.setViewMode("bento")) },
  { id: "view.content", title: "Content view", category: "View", keys: ["ctrl+shift+8"], run: withTab((t) => t.setViewMode("content")) },
  { id: "view.zoomIn", title: "Zoom the view in (larger icons)", category: "View", run: withTab((t) => A.zoomView(t, 1)) },
  { id: "view.zoomOut", title: "Zoom the view out (smaller icons, then List)", category: "View", run: withTab((t) => A.zoomView(t, -1)) },
  { id: "view.columns", title: "Column (Miller) view", category: "View", keys: ["ctrl+3"], run: withTab((t) => t.setViewMode("columns")) },
  { id: "view.customizeColumns", title: "Customize Details columns…", category: "View", run: () => ui.setColumnsOpen(true) },
  { id: "shelf.toggle", title: "Show or hide the shelf", category: "File", run: () => shelf.setOpen(!shelf.open()) },
  { id: "shelf.add", title: "Add selection to the shelf", category: "File", keys: ["ctrl+shift+d"], run: withTab(A.addToShelf) },
  { id: "file.nativeMenu", title: "Windows context menu", category: "File", keys: ["shift+f10"], run: withTab(A.nativeContextMenu) },
  { id: "workspace.save", title: "Save workspace…", category: "Panes", run: A.savePreset },
  { id: "workspace.load", title: "Open saved workspace…", category: "Panes", run: A.openPresetMenu },
  { id: "app.quit", title: "Quit Octopolis", category: "App", keys: ["ctrl+q"], global: true, run: () => void quitApp() },
  { id: "app.settings", title: "Settings", category: "App", keys: ["ctrl+,"], global: true, run: () => ui.openSettings() },
  { id: "app.settingsGeneral", title: "Settings: General", category: "App", global: true, run: () => ui.openSettings("general") },
  { id: "app.settingsAppearance", title: "Settings: Appearance", category: "App", global: true, run: () => ui.openSettings("appearance") },
  { id: "app.settingsAdvanced", title: "Settings: Advanced", category: "App", global: true, run: () => ui.openSettings("advanced") },
  { id: "app.settingsAbout", title: "Settings: About", category: "App", global: true, run: () => ui.openSettings("about") },
  { id: "app.updates", title: "Check for updates", category: "App", global: true, run: () => ui.openSettings("updates") },
  { id: "tools.cleanup", title: "Clean up this folder…", category: "Search", run: withTab((t) => (t.archive() ? ui.toast("Not available inside archives") : ui.setCleanupRoot(t.path()))) },
  { id: "tools.duplicates", title: "Find duplicate files in this folder…", category: "Search", run: withTab((t) => (t.archive() ? ui.toast("Not available inside archives") : ui.setDuplicatesRoot(t.path()))) },
  { id: "pane.swap", title: "Swap the two panes", category: "Panes", run: () => workspace.swapPanes() },
  { id: "pane.sync", title: "Toggle synchronized browsing between panes", category: "Panes", run: () => workspace.toggleSynced() },
  { id: "view.groupBy", title: "Group the list by… (type, date, size, name)", category: "View", run: withTab((t) => A.openGroupMenu(t)) },
  { id: "view.groupCycle", title: "Cycle grouping (none, type, date, size, name)", category: "View", run: withTab((t) => A.cycleGroup(t)) },
  { id: "tools.imageTools", title: "Resize or convert the selected pictures…", category: "File", run: withTab((t) => A.openImageTools(t)) },
  { id: "tools.rules", title: "Folder rules (tidy old files)…", category: "App", run: () => ui.setRulesOpen(true) },
  { id: "app.welcome", title: "Show the welcome tour", category: "App", run: () => ui.setWelcomeOpen(true) },
  { id: "view.activity", title: "Show recent file operations", category: "View", run: () => ui.setOpsHistoryOpen(true) },
  { id: "search.recent", title: "Find files changed in the last 7 days (this folder and below)", category: "View", run: withTab((t) => void t.runSearch("dm:week type:file")) },
  { id: "search.large", title: "Find files over 100 MB (this folder and below)", category: "View", run: withTab((t) => void t.runSearch("size:>100mb type:file")) },
  { id: "tools.folderInEditor", title: "Open this folder in the editor", category: "App", run: withTab((t) => void A.openFolderInEditor(t.path())) },
  { id: "tools.terminalHere", title: "Open a terminal in this folder", category: "App", run: withTab((t) => A.openTerminalAt(t.path())) },
  { id: "file.copyTo", title: "Copy selection to a folder…", category: "File", run: withTab((t) => void A.transferToPicked(t, "copy")) },
  { id: "file.moveTo", title: "Move selection to a folder…", category: "File", run: withTab((t) => void A.transferToPicked(t, "move")) },
  { id: "tools.freeSpace", title: "Free up space…", category: "App", run: () => ui.setSystemCleanupOpen(true) },
  { id: "view.recycleBin", title: "Open the Recycle Bin", category: "View", run: () => ui.setRecycleBinOpen(true) },
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
  { id: "pane.compare", title: "Compare folders in the two panes", category: "Panes", run: A.toggleCompare },
  { id: "pane.selectDifferences", title: "Select items that differ from the other pane", category: "Panes", run: withTab(A.selectDifferences) },
  { id: "pane.copyToOther", title: "Copy selection to the other pane", category: "Panes", keys: ["ctrl+shift+arrowright"], run: withTab((t) => A.sendToOtherPane(t, "copy")) },
  { id: "pane.moveToOther", title: "Move selection to the other pane", category: "Panes", run: withTab((t) => A.sendToOtherPane(t, "move")) },
  { id: "pane.close", title: "Close pane", category: "Panes", keys: ["ctrl+shift+w"], global: true, run: () => workspace.closePane(workspace.activePaneId()) },
  { id: "pane.next", title: "Next pane", category: "Panes", keys: ["f6"], global: true, run: () => workspace.cyclePane(1) },
  { id: "pane.prev", title: "Previous pane", category: "Panes", keys: ["shift+f6"], global: true, run: () => workspace.cyclePane(-1) },
  { id: "pane.switch", title: "Switch to the other pane", category: "Panes", keys: ["tab"], hidden: true, when: () => workspace.paneCount() > 1, run: () => workspace.cyclePane(1) },

  // App
  { id: "palette.commands", title: "Show all commands", category: "App", keys: ["ctrl+shift+p"], global: true, run: () => ui.openPalette("commands") },
  { id: "app.guide", title: "Open the Octopolis guide", category: "App", keys: ["f1"], global: true, run: () => void guide.open() },
  { id: "app.shortcuts", title: "Keyboard shortcuts", category: "App", keys: ["ctrl+k ctrl+s"], global: true, run: () => ui.openSettings("shortcuts") },
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
      if (ops.clip()) return ops.clearClip();
      t.setSelection(new Set<number>());
    }) },
];

const byId = new Map(COMMANDS.map((c) => [c.id, c]));
/** One palette entry (and shortcut slot) for each enabled custom action. */
export const actionCommands = (): Command[] =>
  customActions.list().filter((a) => a.enabled).map((a) => ({
    id: `action:${a.id}`,
    title: a.name,
    category: "Actions" as const,
    run: () => {
      const t = workspace.activeTab();
      if (t) A.runActionById(t, a.id);
    },
  }));
/** One palette entry for each enabled folder rule: it opens that rule's preview, so nothing runs unseen. */
export const ruleCommands = (): Command[] =>
  rules.list().filter((r) => r.enabled).map((r) => ({
    id: `rule:${r.id}`,
    title: `Run folder rule: ${r.name}…`,
    category: "Actions" as const,
    run: () => rules.requestRun(r.id),
  }));
export const allCommands = (): readonly Command[] => [...COMMANDS, ...actionCommands(), ...ruleCommands()];
export const commandById = (id: string) => byId.get(id) ?? (id.startsWith("action:") ? actionCommands().find((c) => c.id === id) : id.startsWith("rule:") ? ruleCommands().find((c) => c.id === id) : undefined);
