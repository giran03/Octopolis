import { createEffect, lazy, onCleanup, onMount, Show } from "solid-js";
import { Shelf } from "./components/Shelf";
import { inspector } from "./state/inspector";
import { Overlays } from "./components/Overlays";
import { PaneTree } from "./components/PaneTree";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TitleBar } from "./components/TitleBar";
import { TooltipLayer } from "./components/Tooltip";
import { errorText, startupMark, knownFolders, OPEN_PATHS_EVENT, openInExplorer, resolvePath, setKeepInTray, setSummon, startupPaths, type KnownFolder } from "./lib/ipc";
import { classifyTarget } from "./lib/launch";
import { samePath } from "./lib/paths";
import { parsePreset } from "./lib/session";
import { currentIconColors, renderAppIcon } from "./lib/appIcon";
import { setAppIcon } from "./lib/ipc";
import { BUILT_IN_THEMES, DENSITIES, THEME_TOKENS } from "./lib/themes";
import { onKeyDown, onMouseNav } from "./keys";
import { loadJson, saveJson, settings } from "./state/settings";
import { ops } from "./state/ops";
import { sidebar } from "./state/sidebar";
import { startVideoThumbPrefetch } from "./state/thumbs";
import { ui } from "./state/ui";
import { updater } from "./state/updater";
import { workspace } from "./state/workspace";

// Loaded on first use, so startup only parses what the first window needs.
const Inspector = lazy(() => import("./components/Inspector").then((m) => ({ default: m.Inspector })));
const TerminalPanel = lazy(() => import("./components/Terminal").then((m) => ({ default: m.TerminalPanel })));

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
  root.dataset.density = settings.density();
  root.classList.toggle("sidebar-names-only", settings.density() === "compact" || settings.sidebarNamesOnly());
  root.style.setProperty("--row", `${DENSITIES[settings.density()]}px`);
  // The whole chrome (sidebar, tabs, toolbar, menus, status bar) follows the density, relative to "normal".
  const scale = DENSITIES[settings.density()] / DENSITIES.normal;
  root.style.setProperty("--d", String(scale));
  root.style.setProperty("--ds", String(1 + (scale - 1) * 0.5));
  document.body.style.zoom = String(settings.uiScale() / 100);
}

const LAST_PATH_KEY = "octopolis.lastpath.v1";
const SESSION_KEY = "octopolis.session.v1";

/** Marks the page for reduced motion, from the user's choice or Windows' setting. */
function applyMotion() {
  const pref = settings.motion();
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  const apply = () => document.documentElement.classList.toggle("reduce-motion", pref === "reduce" || (pref === "system" && query.matches));
  apply();
  query.addEventListener("change", apply);
  onCleanup(() => query.removeEventListener("change", apply));
}

let knownFolderPaths: readonly KnownFolder[] = [];
let startFolder = "C:\\";

/** Opens folders and files passed on the command line, each in a tab of its own. */
async function openLaunchTargets(args: readonly string[]) {
  for (const arg of args) {
    const target = classifyTarget(arg);
    if (target.kind === "explorer") {
      openInExplorer(target.arg).catch((e) => ui.toast(errorText(e)));
      continue;
    }
    const raw = target.kind === "path" ? target.path : target.id === "start" ? startFolder : knownFolderPaths.find((f) => f.id === target.id)?.path;
    if (!raw) continue;
    try {
      const r = await resolvePath(raw);
      const current = workspace.activeTab();
      // Already showing that folder (e.g. Win+E on a fresh start): just select the item, if any.
      if (current && samePath(current.path(), r.dir)) {
        if (r.select) void current.navigate(r.dir, [r.select]);
        continue;
      }
      workspace.newTab(workspace.activePaneId(), r.dir);
      if (r.select) void workspace.activeTab()?.navigate(r.dir, [r.select]);
    } catch (e) {
      ui.toast(`Couldn't open ${raw}: ${errorText(e)}`);
    }
  }
}

/** Keeps the taskbar and tray icon in the colors of the active theme and accent. */
function syncAppIcon() {
  let last = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const push = () => {
    const colors = currentIconColors();
    const key = `${colors.bg}|${colors.tiles}|${colors.hub}`;
    if (key === last) return;
    last = key;
    renderAppIcon(colors).then((img) => setAppIcon(img.data, img.width, img.height)).catch(() => (last = ""));
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(push, 150);
  };
  // Runs after applyTheme (created before it), so the page already carries the new colors.
  createEffect(() => {
    void settings.theme();
    void settings.customTheme();
    void settings.accent();
    schedule();
  });
  // With no chosen theme the colors follow the system's light or dark setting.
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", schedule);
  onCleanup(() => {
    clearTimeout(timer);
    media.removeEventListener("change", schedule);
  });
}

export function App() {
  createEffect(applyTheme);
  syncAppIcon();
  createEffect(applyMotion);
  startVideoThumbPrefetch();
  // Remember where the user was, for the "Where I left off" start option.
  createEffect(() => {
    const path = workspace.activeTab()?.path();
    if (path) saveJson(LAST_PATH_KEY, path);
  });
  // ...and every pane and tab, so "Where I left off" brings the whole session back.
  createEffect(() => {
    if (workspace.activePaneId() === "none") return;
    saveJson(SESSION_KEY, workspace.snapshotLayout());
  });

  // Startup budget: log when the first folder's rows are on screen.
  let markedFirstRows = false;
  createEffect(() => {
    const s = workspace.activeTab()?.status();
    if (markedFirstRows || !s || s.loading || s.elapsedMs === null) return;
    markedFirstRows = true;
    requestAnimationFrame(() => void startupMark("first rows").catch(() => undefined));
  });

  onMount(async () => {
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
    // Files copied in Explorer or another app enable Paste here.
    const onFocus = () => void ops.checkExternalClipboard();
    window.addEventListener("focus", onFocus);
    onCleanup(() => window.removeEventListener("focus", onFocus));
    onFocus();
    // Endless decorative motion (the shortcut ticker) pauses while another app is in front.
    // Focus moving into a preview frame keeps the page focused, hence the hasFocus check.
    const markInactive = () => setTimeout(() => document.documentElement.classList.toggle("window-inactive", !document.hasFocus()));
    window.addEventListener("blur", markInactive);
    window.addEventListener("focus", markInactive);
    onCleanup(() => {
      window.removeEventListener("blur", markInactive);
      window.removeEventListener("focus", markInactive);
    });
    for (const type of ["mousedown", "mouseup"] as const) {
      window.addEventListener(type, onMouseNav);
      onCleanup(() => window.removeEventListener(type, onMouseNav));
    }
    // Later launches (a folder opened from the desktop, `octopolis D:\x`) arrive here as new tabs.
    const unlisten = import("@tauri-apps/api/event")
      .then(({ listen }) => listen<string[]>(OPEN_PATHS_EVENT, (e) => void openLaunchTargets(e.payload)))
      .catch(() => null);
    onCleanup(() => void unlisten.then((off) => off?.()));

    const folders = await knownFolders().catch(() => [] as KnownFolder[]);
    knownFolderPaths = folders;
    const home = folders.find((x) => x.id === "home")?.path;
    const choice = settings.startFolder();
    const session = choice === "last" ? parsePreset(loadJson<unknown>(SESSION_KEY, null)) : null;
    if (!session || !workspace.restoreLayout(session)) {
      const start = choice === "custom" ? settings.startPath() : choice === "last" ? loadJson<string>(LAST_PATH_KEY, "") : "";
      startFolder = start || home || "C:\\";
      workspace.init(startFolder);
    } else startFolder = home || "C:\\";
    await openLaunchTargets(await startupPaths().catch(() => []));
    updater.start();
  });
  // Tray mode lives in the backend, which decides what closing the window does.
  createEffect(() => void setKeepInTray(settings.keepInTray()).catch(() => undefined));
  createEffect(() => void setSummon(settings.summonKey()).catch(() => undefined));

  return (
    <div class="app" classList={{ "no-sidebar": !settings.sidebarOpen() }} style={{ "--sidebar-w": `${sidebar.width()}px` }}>
      <TitleBar />
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
        <Show when={settings.inspectorOpen() || inspector.quickLook()}>
          <Inspector />
        </Show>
      </main>
      <StatusBar />
      <Shelf />
      <Overlays />
      <TooltipLayer />
    </div>
  );
}
