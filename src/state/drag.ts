import { createSignal } from "solid-js";
// What a file-list drag is carrying, so other drop zones (the sidebar) can read it during dragover.
export const DRAG_MIME = "application/x-octopolis-paths";

export const PIN_MIME = "application/x-octopolis-pin";

export const dragState = {
  /** Folders being dragged (from the file list or a pinned item) that tabs can open. */
  dirs: [] as readonly string[],
  paths: [] as readonly string[],
  /** True when every dragged item is a folder (so it can be pinned). */
  allDirs: false,
  archive: null as string | null,
  /** True while a native drag (started by the app for other programs) is under way; its items are in `paths`. */
  native: false,
};

/** How long a drag must rest on a folder, breadcrumb or tab before it opens. */
export const SPRING_MS = 650;
let springKey: string | null = null;
let springTimer: ReturnType<typeof setTimeout> | undefined;
const [springing, setSpringing] = createSignal<string | null>(null);
/** The target a spring-load is counting down on (so it can show a fill bar), or null. */
export const springTarget = springing;

/**
 * Spring-loaded folders: call on every dragover of a target. When the drag
 * stays on the same `key` for SPRING_MS, `open` runs once.
 */
export function springLoad(key: string, open: () => void) {
  if (springKey === key) return;
  clearTimeout(springTimer);
  springKey = key;
  setSpringing(key);
  springTimer = setTimeout(() => {
    springKey = null;
    setSpringing(null);
    open();
  }, SPRING_MS);
}

/** Stops a pending spring-open (the drag left, dropped or ended). */
export function cancelSpring() {
  clearTimeout(springTimer);
  springKey = null;
  setSpringing(null);
}

/** The tab being dragged (dragover can't read the payload), so edge drop zones know what it is. */
export const tabDrag: { current: { pane: string; tab: string; title: string } | null } = { current: null };

const TAB_MIME_TYPE = "application/x-octopolis-tab";

/** Whether a drag brings something in from outside the app (files, or a picture or link from a web page), not our own items. */
/** Whether a drag carries our own items: the in-page kind, or a native drag we started that is passing over our window. */
export function carriesPaths(dt: DataTransfer | null): dt is DataTransfer {
  return !!dt && (dt.types.includes(DRAG_MIME) || (dragState.native && dt.types.includes("Files")));
}

/** The dragged items as the JSON the drop handlers read ("" when this isn't one of our drags). */
export function dragRaw(dt: DataTransfer | null): string {
  if (dragState.native) return JSON.stringify(dragState.paths);
  return dt?.getData(DRAG_MIME) ?? "";
}

export function isExternalDrag(dt: DataTransfer | null): boolean {
  if (!dt || dragState.native) return false;
  const t = [...dt.types];
  if (t.includes(DRAG_MIME) || t.includes(TAB_MIME_TYPE) || t.includes(PIN_MIME)) return false;
  return t.includes("Files") || t.includes("text/uri-list") || t.includes("text/html");
}
const [dragging, setDragging] = createSignal(false);
/** True while a file, folder or tab is being dragged inside the app. */
export const isDragging = dragging;

const resets = new Set<() => void>();
/**
 * Registers a function that clears a component's drag highlights (a glowing footer button, a drop row, ...).
 * It runs whenever a drag ends or is found to be over, however that happened. Returns an unregister function.
 */
export function onDragReset(fn: () => void): () => void {
  resets.add(fn);
  return () => resets.delete(fn);
}

/** Ends the current drag everywhere: shared state, spring-loading and every registered highlight. */
/** Ends a native drag: it is over, wherever it ended. */
export function endNativeDrag() {
  dragState.native = false;
  endDrag();
}

export function endDrag() {

  setDragging(false);
  tabDrag.current = null;
  dragState.paths = [];
  dragState.dirs = [];
  dragState.allDirs = false;
  dragState.archive = null;
  cancelSpring();
  for (const fn of resets) fn();
}

/** A drag that goes this long without a dragover event is over (the source vanished, or it was cancelled). */
const QUIET_MS = 1500;

/**
 * Starts listening for drags; call once. The browser's own dragend only reaches the window if the element
 * that started the drag is still in the page, so a pane closing or a list re-rendering mid-drag used to leave
 * highlights stuck. These extra signals end the drag reliably: dragend, drop, Esc, the pointer moving with no
 * button down (a native drag sends no mouse moves), the pointer leaving the window, and a quiet-period watchdog.
 */
export function trackDrags() {
  if (typeof window === "undefined") return;
  // The fill bar on a folder you hover while dragging takes exactly as long as the folder takes to open.
  document.documentElement.style.setProperty("--spring-ms", `${SPRING_MS}ms`);
  const carries = (e: DragEvent) => !!e.dataTransfer && (e.dataTransfer.types.includes(DRAG_MIME) || e.dataTransfer.types.includes(TAB_MIME_TYPE) || e.dataTransfer.types.includes(PIN_MIME));
  let lastSeen = 0;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  const stopWatching = () => {
    clearInterval(watchdog);
    watchdog = undefined;
  };
  const stop = () => {
    // A native drag runs its own loop outside the page; only its end (endNativeDrag) clears the state.
    if (dragState.native) return;
    stopWatching();
    endDrag();
  };
  window.addEventListener("dragstart", (e) => {
    if (!carries(e)) return;
    lastSeen = Date.now();
    setDragging(true);
    stopWatching();
    watchdog = setInterval(() => Date.now() - lastSeen > QUIET_MS && stop(), 400);
  });
  window.addEventListener("dragover", () => (lastSeen = Date.now()), true);
  window.addEventListener("dragend", stop);
  // After the drop zones have handled the drop, not before (a capture listener runs first).
  window.addEventListener("drop", () => setTimeout(stop, 0), true);
  // The pointer leaving the window, or a plain click afterwards, ends the drag too.
  window.addEventListener("dragleave", (e) => e.relatedTarget === null && !e.clientX && !e.clientY && stop());
  window.addEventListener("pointerdown", stop, true);
  // Mouse moves with no button held can't happen during a native drag, so the drag is already over.
  window.addEventListener("mousemove", (e) => dragging() && e.buttons === 0 && stop(), true);
  window.addEventListener("keydown", (e) => e.key === "Escape" && dragging() && stop(), true);
  window.addEventListener("blur", stop);
  // A drop nobody took (a picture from a web page landing on the toolbar, say) must never make the page open it.
  const stray = (e: DragEvent) => {
    if (e.defaultPrevented || !isExternalDrag(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  };
  window.addEventListener("dragover", stray);
  window.addEventListener("drop", stray);
}
