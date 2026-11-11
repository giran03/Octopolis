// Custom title bar drawn over the native frame: mark, command pill and window controls.
import { createSignal, onCleanup, onMount, Show } from "solid-js";
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

  return (
    <header class="titlebar" data-tauri-drag-region>
      <div class="tb-left" data-tauri-drag-region>
        <AppMark class="tb-mark" />
        <span class="tb-name" data-tauri-drag-region>Octopolis</span>
      </div>

      <button class="tb-pill" data-tooltip="Go to folder · Ctrl+P" onClick={() => ui.openPalette("go")}>
        <IconSearch size={14} />
        <span class="tb-pill-text">
          <Show when={place()} fallback="Go to folder or run a command">
            {place()}
          </Show>
        </span>
        <kbd>Ctrl P</kbd>
      </button>

      <div class="tb-controls" data-tauri-drag-region>
        <button class="wc" aria-label="Minimize" onClick={act((w) => w.minimize())}>
          <Glyph code="E921" size={10} />
        </button>
        <button class="wc" aria-label={maximized() ? "Restore" : "Maximize"} onClick={act((w) => w.toggleMaximize())}>
          <Glyph code={maximized() ? "E923" : "E922"} size={10} />
        </button>
        <button class="wc close" aria-label="Close" onClick={act((w) => w.close())}>
          <Glyph code="E8BB" size={10} />
        </button>
      </div>
    </header>
  );
}
