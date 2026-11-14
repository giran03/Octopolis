// Custom title bar drawn over the native frame: mark, command pill and window controls.
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { parentPath } from "../lib/paths";
import { settings } from "../state/settings";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";
import { AppMark, Glyph, IconSearch } from "./Icons";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function appWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export function TitleBar() {
  const [maximized, setMaximized] = createSignal(false);

  onMount(async () => {
    if (!inTauri) return;
    const win = await appWindow();
    setMaximized(await win.isMaximized());
    const stop = await win.onResized(async () => setMaximized(await win.isMaximized()));
    onCleanup(stop);
  });

  const act = (run: (w: Awaited<ReturnType<typeof appWindow>>) => Promise<void>) => () => {
    if (inTauri) void appWindow().then(run);
  };

  const place = () => workspace.activeTab()?.title() ?? "";
  const parent = () => {
    const p = workspace.activeTab()?.path();
    return p ? parentPath(p) : null;
  };

  const isMac = () => settings.windowControls() === "macos";
  const macSide = () => settings.windowControlsSide();

  const TrafficLights = (p: { right?: boolean }) => (
    <div class="tb-traffic" classList={{ "tb-traffic-right": p.right }} role="group" aria-label="Window controls">
      <button class="tl tl-close" aria-label="Close" title="Close" onClick={act((w) => w.close())}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3.5 3.5 8.5 8.5M8.5 3.5 3.5 8.5" />
        </svg>
      </button>
      <button class="tl tl-min" aria-label="Minimize" title="Minimize" onClick={act((w) => w.minimize())}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 6h7" />
        </svg>
      </button>
      <button class="tl tl-max" aria-label={maximized() ? "Restore" : "Maximize"} title={maximized() ? "Restore" : "Maximize"} onClick={act((w) => w.toggleMaximize())}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <Show when={!maximized()} fallback={<path d="M3.5 5v3.5H7M5 3.5h3.5V7" />}>
            <path d="M6 2.5v7M2.5 6h7" />
          </Show>
        </svg>
      </button>
    </div>
  );

  return (
    <header class="titlebar" classList={{ "tb-mac": isMac() }} data-tauri-drag-region>
      <div class="tb-left" data-tauri-drag-region>
        <Show when={isMac() && macSide() === "left"}>
          <TrafficLights />
        </Show>
        <AppMark class="tb-mark" />
        <span class="tb-name" data-tauri-drag-region>Octopolis</span>
      </div>

      <button class="tb-pill" data-tooltip="Go to folder · Ctrl+P" onClick={() => ui.openPalette("go")}>
        <IconSearch size={14} />
        <span class="tb-pill-text">
          <Show when={place()} fallback="Go to folder or run a command">
            <Show when={parent()}>
              {(par) => (
                <>
                  <span class="tb-pill-parent">{par()}</span>
                  <span class="tb-pill-sep"> / </span>
                </>
              )}
            </Show>
            <span class="tb-pill-leaf">{place()}</span>
          </Show>
        </span>
        <kbd>Ctrl P</kbd>
      </button>

      <div class="tb-controls" data-tauri-drag-region>
        <Show when={isMac() && macSide() === "right"}>
          <TrafficLights right />
        </Show>
        <Show when={!isMac()}>
          <button class="wc" aria-label="Minimize" onClick={act((w) => w.minimize())}>
            <Glyph code="E921" size={10} />
          </button>
          <button class="wc" aria-label={maximized() ? "Restore" : "Maximize"} onClick={act((w) => w.toggleMaximize())}>
            <Glyph code={maximized() ? "E923" : "E922"} size={10} />
          </button>
          <button class="wc close" aria-label="Close" onClick={act((w) => w.close())}>
            <Glyph code="E8BB" size={10} />
          </button>
        </Show>
      </div>
    </header>
  );
}
