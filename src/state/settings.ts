// Per-user view preferences, remembered in local storage.
import { createRoot, createSignal } from "solid-js";

const KEY = "octopolis.settings.v1";

interface Settings {
  showHidden: boolean;
  sidebarOpen: boolean;
}

const DEFAULTS: Settings = { showHidden: false, sidebarOpen: true };

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export const settings = createRoot(() => {
  const [value, setValue] = createSignal<Settings>(load());
  const update = (patch: Partial<Settings>) => {
    const next = { ...value(), ...patch };
    setValue(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Storage can be unavailable; the setting still applies for this session.
    }
  };
  return {
    showHidden: () => value().showHidden,
    sidebarOpen: () => value().sidebarOpen,
    toggleHidden: () => update({ showHidden: !value().showHidden }),
    toggleSidebar: () => update({ sidebarOpen: !value().sidebarOpen }),
  };
});
