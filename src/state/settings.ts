// Per-user preferences, remembered in local storage.
import { createRoot, createSignal } from "solid-js";

const KEY = "octopolis.settings.v1";

interface Settings {
  showHidden: boolean;
  sidebarOpen: boolean;
  vimMode: boolean;
  inspectorOpen: boolean;
  verifyCopies: boolean;
  /** Bytes per second; null means unlimited. */
  speedLimit: number | null;
}

const DEFAULTS: Settings = { showHidden: false, sidebarOpen: true, vimMode: false, inspectorOpen: false, verifyCopies: false, speedLimit: null };

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
    toggleInspector: () => update({ inspectorOpen: !value().inspectorOpen }),
    toggleVerify: () => update({ verifyCopies: !value().verifyCopies }),
    setSpeedLimit: (speedLimit: number | null) => update({ speedLimit }),
    toggleHidden: () => update({ showHidden: !value().showHidden }),
    toggleSidebar: () => update({ sidebarOpen: !value().sidebarOpen }),
    toggleVim: () => update({ vimMode: !value().vimMode }),
  };
});
