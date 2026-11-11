import { onCleanup, onMount, Show } from "solid-js";
import { Overlays } from "./components/Overlays";
import { PaneTree } from "./components/PaneTree";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { knownFolders } from "./lib/ipc";
import { onKeyDown } from "./keys";
import { settings } from "./state/settings";
import { workspace } from "./state/workspace";

export function App() {
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
        <Show when={workspace.paneCount() > 0 && workspace.activePaneId() !== "none"}>
          <PaneTree node={workspace.layout()} />
        </Show>
      </main>
      <StatusBar />
      <Overlays />
    </div>
  );
}
