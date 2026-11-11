import { createEffect, onCleanup, onMount, Show } from "solid-js";
import { Shelf } from "./components/Extras";
import { Inspector } from "./components/Inspector";
import { Overlays } from "./components/Overlays";
import { PaneTree } from "./components/PaneTree";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TerminalPanel } from "./components/Terminal";
import { knownFolders } from "./lib/ipc";
import { BUILT_IN_THEMES, DENSITIES, THEME_TOKENS } from "./lib/themes";
import { onKeyDown } from "./keys";
import { settings } from "./state/settings";
import { workspace } from "./state/workspace";

/** Applies the chosen theme, accent, text size and density to the page. */
function applyTheme() {
  const root = document.documentElement;
  const all = [...BUILT_IN_THEMES, ...(settings.customTheme() ? [settings.customTheme()!] : [])];
  const theme = all.find((t) => t.name === settings.theme());
  for (const token of THEME_TOKENS) root.style.removeProperty(`--${token}`);
  if (theme) {
    root.dataset.theme = theme.scheme;
    root.style.colorScheme = theme.scheme;
    for (const [k, v] of Object.entries(theme.tokens)) root.style.setProperty(`--${k}`, v);
  } else {
    delete root.dataset.theme;
    root.style.removeProperty("color-scheme");
  }
  if (settings.accent()) root.style.setProperty("--accent", settings.accent()!);
  root.style.setProperty("--row", `${DENSITIES[settings.density()]}px`);
  document.body.style.zoom = String(settings.uiScale() / 100);
}

export function App() {
  createEffect(applyTheme);

  onMount(async () => {
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
    const home = await knownFolders()
      .then((f) => f.find((x) => x.id === "home")?.path)
      .catch(() => undefined);
    workspace.init(home ?? "C:\\");
  });

  return (
    <div class="app" classList={{ "no-sidebar": !settings.sidebarOpen() }}>
      <Show when={settings.sidebarOpen()}>
        <Sidebar />
      </Show>
      <main class="workspace">
        <div class="main-stack">
          <div class="panes">
            <Show when={workspace.paneCount() > 0 && workspace.activePaneId() !== "none"}>
              <PaneTree node={workspace.layout()} />
            </Show>
          </div>
          <Show when={settings.terminalOpen()}>
            <TerminalPanel />
          </Show>
        </div>
        <Show when={settings.inspectorOpen()}>
          <Inspector />
        </Show>
      </main>
      <StatusBar />
      <Shelf />
      <Overlays />
    </div>
  );
}
