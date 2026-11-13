// Inspector panel layout state (width), remembered across launches.
import { createRoot, createSignal } from "solid-js";
import { clampInspectorWidth, DEFAULT_INSPECTOR_WIDTH } from "../lib/inspector";
import { loadJson, saveJson } from "./settings";

const KEY = "octopolis.inspector.v1";

interface InspectorState {
  width: number;
}

const DEFAULTS: InspectorState = { width: DEFAULT_INSPECTOR_WIDTH };

export const inspector = createRoot(() => {
  const saved = loadJson<Partial<InspectorState>>(KEY, {});
  /** Full-window preview (Shift+Space). */
  const [quickLook, setQuickLook] = createSignal(false);
  /** Keep the inspector locked onto the current file while browsing other folders. */
  const [pinned, setPinned] = createSignal(false);
  const [width, setWidthSignal] = createSignal(clampInspectorWidth(saved.width ?? DEFAULTS.width));

  const setWidth = (next: number, maxAvailable?: number) => {
    const clamped = clampInspectorWidth(next, maxAvailable);
    setWidthSignal(clamped);
    saveJson(KEY, { width: clamped });
  };

  return {
    width,
    setWidth,
    quickLook,
    setQuickLook,
    toggleQuickLook: () => setQuickLook((v) => !v),
    pinned,
    setPinned,
    togglePinned: () => setPinned((v) => !v),
  };
});
