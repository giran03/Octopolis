// Sidebar layout: collapsed sections, pinned folders and width, remembered between launches.
import { createRoot, createSignal } from "solid-js";
import { recentVisits } from "../lib/frecency";
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH, insertPins, movePin, renamePin, reorderPin, togglePin, type Pin } from "../lib/sidebar";
import { history } from "./history";
import { loadJson, saveJson } from "./settings";

const KEY = "octopolis.sidebar.v1";

export type SectionId = "pinned" | "quick" | "recent" | "drives" | "tags" | "searches";

interface SidebarState {
  collapsed: Partial<Record<SectionId, boolean>>;
  pins: readonly Pin[];
  width: number;
}

const DEFAULTS: SidebarState = { collapsed: {}, pins: [], width: DEFAULT_SIDEBAR_WIDTH };

export const sidebar = createRoot(() => {
  const [state, setState] = createSignal<SidebarState>({ ...DEFAULTS, ...loadJson<Partial<SidebarState>>(KEY, {}) });
  const update = (patch: Partial<SidebarState>) => {
    const next = { ...state(), ...patch };
    setState(next);
    saveJson(KEY, next);
  };
  return {
    pins: () => state().pins,
    width: () => clampSidebarWidth(state().width),
    isCollapsed: (id: SectionId) => state().collapsed[id] === true,
    toggleSection: (id: SectionId) => update({ collapsed: { ...state().collapsed, [id]: !state().collapsed[id] } }),
    expand: (id: SectionId) => state().collapsed[id] && update({ collapsed: { ...state().collapsed, [id]: false } }),
    togglePin: (path: string) => update({ pins: togglePin(state().pins, path) }),
    movePin: (path: string, delta: -1 | 1) => update({ pins: movePin(state().pins, path, delta) }),
    insertPins: (paths: readonly string[], index: number) => update({ pins: insertPins(state().pins, paths, index) }),
    reorderPin: (path: string, index: number) => update({ pins: reorderPin(state().pins, path, index) }),
    renamePin: (path: string, label: string) => update({ pins: renamePin(state().pins, path, label) }),
    setWidth: (width: number) => update({ width: clampSidebarWidth(width) }),
    recent: (limit = 8) => recentVisits(history.db(), limit * 2).filter((r) => !/^[a-z]:\\?$/i.test(r.path)).slice(0, limit),
  };
});
