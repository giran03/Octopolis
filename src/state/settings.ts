// Per-user preferences, remembered in local storage.
import { createRoot, createSignal } from "solid-js";
import type { SummonKey } from "../lib/ipc";
import type { Density, Theme } from "../lib/themes";

const KEY = "octopolis.settings.v1";

interface Settings {
  showHidden: boolean;
  sidebarOpen: boolean;
  vimMode: boolean;
  inspectorOpen: boolean;
  verifyCopies: boolean;
  /** Bytes per second; null means unlimited. */
  speedLimit: number | null;
  terminalOpen: boolean;
  terminalSync: boolean;
  showCommits: boolean;
  theme: string;
  customTheme: Theme | null;
  accent: string | null;
  uiScale: number;
  density: Density;
  pinnedActions: readonly string[];
  startFolder: StartFolder;
  /** Folder used when `startFolder` is "custom". */
  startPath: string;
  confirmRecycle: boolean;
  autoFolderSizes: boolean;
  showThumbnails: boolean;
  shellIcons: boolean;
  terminalShell: TerminalShell;
  motion: MotionPref;
  tooltips: boolean;
  shelfAutoOpen: boolean;
  showPinned: boolean;
  showRecent: boolean;
  /** Hide paths under recent folders and drive usage bars in the sidebar. */
  sidebarNamesOnly: boolean;
  updateMode: UpdateMode;
  /** Closing the window keeps Octopolis running in the notification area. */
  keepInTray: boolean;
  /** System-wide shortcut that brings Octopolis forward. */
  summonKey: SummonKey;
  /** Optional details-list columns that are shown, in order. */
  fileColumns: readonly string[];
  /** Leave files Git ignores out of the list in Git folders. */
  hideGitIgnored: boolean;
  /** Program for "Open in editor"; empty uses the file type's editor. */
  editorPath: string;
  /** Windows notification when a long transfer ends while the window is in the background. */
  notifyDone: boolean;
  /** Stop the PC from sleeping while transfers run. */
  keepAwake: boolean;
  /** Column widths in pixels, by column key. */
  columnWidths: Readonly<Record<string, number>>;
  /** Epoch ms of the last background update check. */
  lastUpdateCheck: number;
}

export type StartFolder = "home" | "last" | "custom";
export type TerminalShell = "powershell" | "pwsh" | "cmd";
export type MotionPref = "system" | "reduce" | "full";
export type UpdateMode = "off" | "notify" | "auto";

const DEFAULTS: Settings = { showHidden: false, sidebarOpen: true, vimMode: false, inspectorOpen: false, verifyCopies: false, speedLimit: null, terminalOpen: false, terminalSync: true, showCommits: false, theme: "Midnight", customTheme: null, accent: null, uiScale: 100, density: "normal", pinnedActions: [], startFolder: "home", startPath: "", confirmRecycle: false, autoFolderSizes: false, showThumbnails: true, shellIcons: true, terminalShell: "powershell", motion: "system", tooltips: true, shelfAutoOpen: true, showPinned: true, showRecent: true, sidebarNamesOnly: false, updateMode: "notify", lastUpdateCheck: 0, keepInTray: false, summonKey: "off", fileColumns: ["modified", "type", "size"], columnWidths: {}, hideGitIgnored: false, editorPath: "", notifyDone: true, keepAwake: true };

export const SETTING_DEFAULTS: Readonly<Settings> = DEFAULTS;

/** Reads a JSON value from local storage; storage may be unavailable. */
export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable; the value still applies for this session.
  }
}

/** Keeps only known keys whose value has the same type as the default, so imported JSON can't corrupt state. */
export function sanitizeSettings(raw: unknown): Partial<Settings> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, unknown> = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const v = (raw as Record<string, unknown>)[key];
    if (v === undefined) continue;
    const same = fallback === null ? v === null || typeof v === "number" || typeof v === "string" || typeof v === "object" : typeof v === typeof fallback && Array.isArray(v) === Array.isArray(fallback);
    if (same) out[key] = v;
  }
  return out as Partial<Settings>;
}

export const settings = createRoot(() => {
  const [value, setValue] = createSignal<Settings>({ ...DEFAULTS, ...loadJson<Partial<Settings>>(KEY, {}) });
  const update = (patch: Partial<Settings>) => {
    const next = { ...value(), ...patch };
    setValue(next);
    saveJson(KEY, next);
  };
  return {
    showHidden: () => value().showHidden,
    sidebarOpen: () => value().sidebarOpen,
    vimMode: () => value().vimMode,
    inspectorOpen: () => value().inspectorOpen,
    verifyCopies: () => value().verifyCopies,
    speedLimit: () => value().speedLimit,
    terminalOpen: () => value().terminalOpen,
    terminalSync: () => value().terminalSync,
    showCommits: () => value().showCommits,
    theme: () => value().theme,
    customTheme: () => value().customTheme,
    accent: () => value().accent,
    uiScale: () => value().uiScale,
    density: () => value().density,
    pinnedActions: () => value().pinnedActions,
    startFolder: () => value().startFolder,
    startPath: () => value().startPath,
    confirmRecycle: () => value().confirmRecycle,
    autoFolderSizes: () => value().autoFolderSizes,
    showThumbnails: () => value().showThumbnails,
    shellIcons: () => value().shellIcons,
    terminalShell: () => value().terminalShell,
    motion: () => value().motion,
    tooltips: () => value().tooltips,
    shelfAutoOpen: () => value().shelfAutoOpen,
    showPinned: () => value().showPinned,
    showRecent: () => value().showRecent,
    sidebarNamesOnly: () => value().sidebarNamesOnly,
    updateMode: () => value().updateMode,
    keepInTray: () => value().keepInTray,
    summonKey: () => value().summonKey,
    fileColumns: () => value().fileColumns,
    columnWidths: () => value().columnWidths,
    hideGitIgnored: () => value().hideGitIgnored,
    editorPath: () => value().editorPath,
    notifyDone: () => value().notifyDone,
    keepAwake: () => value().keepAwake,
    lastUpdateCheck: () => value().lastUpdateCheck,
    /** Updates any settings at once; unknown keys and wrongly typed values are ignored. */
    set: (patch: Partial<Settings>) => update(sanitizeSettings(patch)),
    /** Every setting back to a fresh install's. */
    reset: () => update({ ...DEFAULTS }),
    /** A JSON copy of every setting, for export. */
    snapshot: (): Settings => value(),
    toggleTerminal: () => update({ terminalOpen: !value().terminalOpen }),
    toggleTerminalSync: () => update({ terminalSync: !value().terminalSync }),
    toggleCommits: () => update({ showCommits: !value().showCommits }),
    setTheme: (theme: string) => update({ theme }),
    setCustomTheme: (customTheme: Theme) => update({ customTheme }),
    setAccent: (accent: string | null) => update({ accent }),
    setUiScale: (uiScale: number) => update({ uiScale }),
    setDensity: (density: Density) => update({ density }),
    togglePinned: (label: string) => update({ pinnedActions: value().pinnedActions.includes(label) ? value().pinnedActions.filter((l) => l !== label) : [...value().pinnedActions, label] }),
    toggleInspector: () => update({ inspectorOpen: !value().inspectorOpen }),
    toggleVerify: () => update({ verifyCopies: !value().verifyCopies }),
    setSpeedLimit: (speedLimit: number | null) => update({ speedLimit }),
    toggleHidden: () => update({ showHidden: !value().showHidden }),
    toggleSidebar: () => update({ sidebarOpen: !value().sidebarOpen }),
    toggleVim: () => update({ vimMode: !value().vimMode }),
  };
});
