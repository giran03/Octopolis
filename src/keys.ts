// The window-level keyboard handler. Shortcuts come from the command
// registry (with user overrides and the optional Vim layer); arrow keys and
// type-to-find are handled here directly.
import { commandById, COMMANDS, moveTo } from "./commands";
import { listHandles } from "./components/Pane";
import { eventToKey } from "./lib/keymap";
import { isDir } from "./lib/listing";
import { moveFocus, NAV_KEYS, selectAt, typeAhead, type NavKey } from "./lib/selection";
import { keybindings } from "./state/keybindings";
import { settings } from "./state/settings";
import { ui } from "./state/ui";
import { workspace } from "./state/workspace";

const TYPE_AHEAD_RESET_MS = 700;
const CHORD_TIMEOUT_MS = 1500;
let typed = "";
let typedAt = 0;
let chordTimer: ReturnType<typeof setTimeout> | undefined;

keybindings.register(COMMANDS);

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/** The terminal owns the keyboard, apart from the key that toggles it. */
function inTerminal(t: EventTarget | null): boolean {
  return !!(t as HTMLElement | null)?.closest?.(".xterm");
}

/** Arrow keys, Ctrl+Space and type-to-find in the file list. */
function listKeys(e: KeyboardEvent): boolean {
  const tab = workspace.activeTab();
  if (!tab || tab.renaming() !== null) return false;
  const ctrl = e.ctrlKey || e.metaKey;
  if (tab.viewMode() === "grid" && !e.altKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
    const cols = listHandles.get(tab)?.columns?.() ?? 1;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key as "ArrowLeft"];
    moveTo(tab, Math.min(Math.max(tab.focus() + step, 0), tab.view().length - 1), e.shiftKey, ctrl);
    return true;
  }
  // Column view: Left goes up a folder, Right opens the focused folder.
  if (tab.viewMode() === "columns" && !e.altKey && !ctrl && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    if (e.key === "ArrowLeft") void tab.up();
    else {
      const entry = tab.view()[tab.focus()];
      if (entry !== undefined && isDir(tab.listing(), entry)) void tab.navigate(tab.pathOf(entry));
    }
    return true;
  }
  if (NAV_KEYS.has(e.key) && !e.altKey) {
    const pos = moveFocus(tab.view().length, tab.focus(), e.key as NavKey, listHandles.get(tab)?.pageRows() ?? 20);
    moveTo(tab, pos, e.shiftKey, ctrl);
    return true;
  }
  if (e.key === " " && ctrl) {
    const r = selectAt(tab.view(), tab.selection(), tab.anchor(), tab.focus(), { ctrl: true, shift: false });
    tab.setSelection(r.selection);
    return true;
  }
  if (e.key.length === 1 && !ctrl && !e.altKey && !settings.vimMode()) {
    const now = performance.now();
    typed = now - typedAt > TYPE_AHEAD_RESET_MS ? e.key : typed + e.key;
    typedAt = now;
    const pos = typeAhead(tab.listing().names, tab.view(), tab.focus(), typed);
    if (pos >= 0) moveTo(tab, pos, false);
    return true;
  }
  return false;
}

export function onKeyDown(e: KeyboardEvent) {
  if (ui.modalOpen() || e.defaultPrevented) return;
  const key = eventToKey(e);
  if (!key) return;
  if (inTerminal(e.target)) {
    if (keybindings.keysFor(commandById("view.terminal")!).includes(key)) {
      e.preventDefault();
      commandById("view.terminal")!.run();
    }
    return;
  }
  const editing = isEditable(e.target);
  const renaming = workspace.activeTab()?.renaming() != null;
  const matcher = editing || renaming ? keybindings.globalMatcher() : keybindings.matcher();

  const result = matcher.feed(key);
  clearTimeout(chordTimer);
  if (result.type === "pending") {
    e.preventDefault();
    chordTimer = setTimeout(() => matcher.reset(), CHORD_TIMEOUT_MS);
    return;
  }
  if (result.type === "run") {
    const cmd = commandById(result.id);
    if (cmd && (!cmd.when || cmd.when())) {
      e.preventDefault();
      cmd.run();
      return;
    }
  }
  if (!editing && listKeys(e)) e.preventDefault();
}

/** Mouse side buttons: 3 = back, 4 = forward (also stops WebView2's own history navigation). */
export function onMouseNav(e: MouseEvent) {
  if (e.button !== 3 && e.button !== 4) return;
  e.preventDefault();
  if (e.type !== "mouseup" || ui.modalOpen()) return;
  const tab = workspace.activeTab();
  if (!tab) return;
  if (e.button === 3) tab.back();
  else tab.forward();
}
