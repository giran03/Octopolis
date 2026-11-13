// Per-user preferences, remembered in local storage.
import { createRoot, createSignal } from "solid-js";
import type { SummonKey } from "../lib/ipc";
import { DENSITIES, type Density, type Theme } from "../lib/themes";
import { sanitizeThemes } from "../lib/themeTools";

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
  customThemes: Theme[];
  /** The themes "Follow Windows" uses by day and by night; empty means the built-in look. */
  systemLight: string;
  systemDark: string;
  accent: string | null;
  uiScale: number;
  density: Density;
  /** Exact row height in pixels from the density slider; 0 uses the chosen preset. */
  densityRow: number;
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
  showHints: boolean;
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
  /** Double-clicking a text or code file opens it in the editor above (when one is set). */
  editorOpensText: boolean;
  /** Stroke weight of the button icons, 100 (hairline) to 700 (bold). */
  iconWeight: number;
  /** Show file extensions in names (off hides the last extension, like Explorer's option). */
  showExtensions: boolean;
  /** Pick each folder's view from what it holds (Auto), unless that folder was given a view by hand. */
  autoView: boolean;
  /** Ask before moving a folder into another folder. */
  confirmMoveFolders: boolean;
  /** Size of the button icons relative to normal, in percent. */
  iconScale: number;
  /** Font for the interface text; empty uses the default. */
  uiFont: string;
  /** Allow fonts from Google Fonts (downloaded when chosen; they can be saved on this PC). */
  googleFonts: boolean;
  /** The first-run welcome has been shown. */
  welcomeSeen: boolean;
  /** Solid icons instead of outlines. */
  iconFill: boolean;
  /** Shape family of the button icons. */
  iconStyle: IconStyle;
  /** Windows notification when a long transfer ends while the window is in the background. */
  notifyDone: boolean;
  /** Stop the PC from sleeping while transfers run. */
  keepAwake: boolean;
  /** Column widths in pixels, by column key. */
  columnWidths: Readonly<Record<string, number>>;
  /** Epoch ms of the last background update check. */
  lastUpdateCheck: number;
}

export const ROW_MIN = 18;
export const ROW_MAX = 40;
export type IconStyle = "outlined" | "rounded" | "sharp";
export const ICON_WEIGHT_MIN = 100;
export const ICON_WEIGHT_MAX = 700;

export type StartFolder = "home" | "last" | "custom";
export type TerminalShell = "powershell" | "pwsh" | "cmd";
export type MotionPref = "system" | "reduce" | "full";
export type UpdateMode = "off" | "notify" | "auto";

const DEFAULTS: Settings = { showHidden: false, sidebarOpen: true, vimMode: false, inspectorOpen: false, verifyCopies: false, speedLimit: null, terminalOpen: false, terminalSync: true, showCommits: false, theme: "Midnight", customThemes: [], systemLight: "", systemDark: "", accent: null, uiScale: 100, density: "normal", densityRow: 0, pinnedActions: [], startFolder: "home", startPath: "", confirmRecycle: true, autoFolderSizes: true, showThumbnails: true, shellIcons: true, terminalShell: "powershell", motion: "system", tooltips: true, showHints: true, shelfAutoOpen: true, showPinned: true, showRecent: true, sidebarNamesOnly: false, updateMode: "auto", lastUpdateCheck: 0, keepInTray: false, summonKey: "off", fileColumns: ["modified", "type", "size"], columnWidths: {}, hideGitIgnored: false, editorPath: "", editorOpensText: false, iconWeight: 200, showExtensions: true, autoView: true, confirmMoveFolders: false, iconScale: 100, uiFont: "", googleFonts: false, welcomeSeen: false, iconFill: false, iconStyle: "outlined", notifyDone: true, keepAwake: true };

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
  if (out.customThemes !== undefined) out.customThemes = sanitizeThemes(out.customThemes);
  return out as Partial<Settings>;
}

export const settings = createRoot(() => {
  const stored = loadJson<Partial<Settings> & { customTheme?: unknown }>(KEY, {});
  // One saved custom theme (older versions) becomes the first of the list.
  const [value, setValue] = createSignal<Settings>({ ...DEFAULTS, ...stored, customThemes: sanitizeThemes([...(Array.isArray(stored.customThemes) ? stored.customThemes : []), ...(stored.customTheme ? [stored.customTheme] : [])]) });
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
    customThemes: () => value().customThemes,
    systemLight: () => value().systemLight,
    systemDark: () => value().systemDark,
    accent: () => value().accent,
    uiScale: () => value().uiScale,
    density: () => value().density,
    /** Row height in pixels: the slider value when set, else the preset's. */
    rowPx: () => {
      const custom = value().densityRow;
      return custom >= ROW_MIN && custom <= ROW_MAX ? Math.round(custom) : DENSITIES[value().density];
    },
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
    showHints: () => value().showHints,
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
    editorOpensText: () => value().editorOpensText,
    showExtensions: () => value().showExtensions,
    autoView: () => value().autoView,
    confirmMoveFolders: () => value().confirmMoveFolders,
    iconScale: () => Math.min(140, Math.max(80, value().iconScale)),
    uiFont: () => value().uiFont,
    googleFonts: () => value().googleFonts,
    welcomeSeen: () => value().welcomeSeen,
    iconWeight: () => Math.min(ICON_WEIGHT_MAX, Math.max(ICON_WEIGHT_MIN, value().iconWeight)),
    iconFill: () => value().iconFill,
    iconStyle: (): IconStyle => (["outlined", "rounded", "sharp"].includes(value().iconStyle) ? value().iconStyle : "outlined"),
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
    setCustomThemes: (customThemes: Theme[]) => update({ customThemes: sanitizeThemes(customThemes) }),
    setAccent: (accent: string | null) => update({ accent }),
    setUiScale: (uiScale: number) => update({ uiScale }),
    setDensity: (density: Density) => update({ density, densityRow: 0 }),
    togglePinned: (label: string) => update({ pinnedActions: value().pinnedActions.includes(label) ? value().pinnedActions.filter((l) => l !== label) : [...value().pinnedActions, label] }),
    toggleInspector: () => update({ inspectorOpen: !value().inspectorOpen }),
    toggleVerify: () => update({ verifyCopies: !value().verifyCopies }),
    setSpeedLimit: (speedLimit: number | null) => update({ speedLimit }),
    toggleHidden: () => update({ showHidden: !value().showHidden }),
    toggleSidebar: () => update({ sidebarOpen: !value().sidebarOpen }),
    toggleVim: () => update({ vimMode: !value().vimMode }),
  };
});
