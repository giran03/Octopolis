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
};

/** How long a drag must rest on a folder, breadcrumb or tab before it opens. */
export const SPRING_MS = 650;
let springKey: string | null = null;
let springTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Spring-loaded folders: call on every dragover of a target. When the drag
 * stays on the same `key` for SPRING_MS, `open` runs once.
 */
export function springLoad(key: string, open: () => void) {
  if (springKey === key) return;
  clearTimeout(springTimer);
  springKey = key;
  springTimer = setTimeout(() => {
    springKey = null;
    open();
  }, SPRING_MS);
}

/** Stops a pending spring-open (the drag left, dropped or ended). */
export function cancelSpring() {
  clearTimeout(springTimer);
  springKey = null;
}
