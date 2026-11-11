// Embedded PowerShell. It follows the active folder, and the file list follows
// `cd` typed in the terminal (the prompt reports its folder via OSC 9;9).
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { createEffect, on, onCleanup, onMount } from "solid-js";
import { errorText, termClose, termResize, termStart, termWrite } from "../lib/ipc";
import { psCdCommand, samePath } from "../lib/paths";
import { settings } from "../state/settings";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";
import { IconClose } from "./Icons";

const ENTER = "\r";

export function TerminalPanel() {
  let host!: HTMLDivElement;
  let id: number | null = null;
  /** True at a prompt: safe to type a cd without disturbing a running program. */
  let idle = false;
  let shellPath = "";
  let disposed = false;
  let observer: ResizeObserver | undefined;

  onCleanup(() => {
    disposed = true;
    observer?.disconnect();
    if (id !== null) void termClose(id).catch(() => undefined);
  });

  onMount(async () => {
    const styles = getComputedStyle(document.documentElement);
    const term = new XTerm({
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: styles.getPropertyValue("--surface").trim(), foreground: styles.getPropertyValue("--text").trim() },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    onCleanup(() => term.dispose());

    term.parser.registerOscHandler(9, (data) => {
      if (!data.startsWith("9;")) return false;
      const path = data.slice(2).replace(/^"|"$/g, "");
      idle = true;
      shellPath = path;
      const tab = workspace.activeTab();
      if (tab && settings.terminalSync() && !samePath(tab.path(), path)) void tab.navigate(path);
      return true;
    });

    const tab = workspace.activeTab();
    try {
      const started = await termStart(tab?.path() ?? "C:\\", term.cols, term.rows, (buf) => term.write(new Uint8Array(buf)));
      if (disposed) return void termClose(started).catch(() => undefined);
      id = started;
    } catch (e) {
      ui.toast(`Couldn't start the terminal: ${errorText(e)}`);
      return;
    }
    term.onData((d) => {
      if (id === null) return;
      if (d.includes(ENTER)) idle = false;
      void termWrite(id, d).catch(() => undefined);
    });
    observer = new ResizeObserver(() => {
      fit.fit();
      if (id !== null) void termResize(id, term.cols, term.rows).catch(() => undefined);
    });
    observer.observe(host);
    term.focus();
  });

  // The terminal follows the file list while it is at a prompt.
  createEffect(
    on(
      () => workspace.activeTab()?.path(),
      (path) => {
        if (!path || id === null || !idle || !settings.terminalSync() || samePath(path, shellPath)) return;
        idle = false;
        void termWrite(id, psCdCommand(path)).catch(() => undefined);
      },
      { defer: true },
    ),
  );

  return (
    <section class="terminal" aria-label="Terminal">
      <header class="terminal-head">
        <span>Terminal</span>
        <label class="check small">
          <input type="checkbox" checked={settings.terminalSync()} onChange={settings.toggleTerminalSync} /> Follow folders
        </label>
        <span class="spacer" />
        <button class="icon-btn" aria-label="Close terminal" onClick={settings.toggleTerminal}>
          <IconClose size={13} />
        </button>
      </header>
      <div ref={host} class="terminal-host" />
    </section>
  );
}
