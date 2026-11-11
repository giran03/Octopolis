// Per-user preferences, remembered in local storage.
import { createRoot, createSignal } from "solid-js";
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
}

const DEFAULTS: Settings = { showHidden: false, sidebarOpen: true, vimMode: false, inspectorOpen: false, verifyCopies: false, speedLimit: null, terminalOpen: false, terminalSync: true, showCommits: false, theme: "Midnight", customTheme: null, accent: null, uiScale: 100, density: "normal", pinnedActions: [] };

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
