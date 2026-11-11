// The Portal Dropzone: a staging basket for files from many folders.
import { createRoot, createSignal } from "solid-js";
import { samePath } from "../lib/paths";
import { ops } from "./ops";
import { loadJson, saveJson } from "./settings";

const KEY = "octopolis.shelf.v1";

export const shelf = createRoot(() => {
  const [items, setItems] = createSignal<readonly string[]>(loadJson<string[]>(KEY, []));
  const [open, setOpen] = createSignal(false);
  /** True while a file drag is in flight; the shelf opens itself so it can catch the drop. */
  const [dragging, setDragging] = createSignal(false);
  /** True while a dragged item is over the shelf button or the open card, which is what reveals the card mid-drag. */
  const [hot, setHotRaw] = createSignal(false);
  let hotTimer: ReturnType<typeof setTimeout> | undefined;
  /** Leaving is debounced so crossing the gap between the button and the card does not flicker. */
  const setHot = (on: boolean) => {
    clearTimeout(hotTimer);
    if (on) setHotRaw(true);
    else hotTimer = setTimeout(() => setHotRaw(false), 140);
  };
  const save = (next: readonly string[]) => {
    setItems(next);
    saveJson(KEY, next);
  };
  return {
    items,
    open,
    setOpen,
    dragging,
    setDragging: (on: boolean) => {
      setDragging(on);
      if (!on) {
        clearTimeout(hotTimer);
        setHotRaw(false);
      }
    },
    hot,
    setHot,
    add: (paths: readonly string[]) => {
      save([...items(), ...paths.filter((p) => !items().some((i) => samePath(i, p)))]);
      setOpen(true);
    },
    remove: (path: string) => save(items().filter((i) => i !== path)),
    clear: () => save([]),
    /** Copies or moves everything on the shelf into `dest`, then empties it. */
    deliver: (mode: "copy" | "move", dest: string) => {
      const sources = items();
      if (sources.length === 0) return;
      // The shelf empties only once the transfer is under way, not if the user cancels.
      void ops.transfer(mode, sources, dest).then((started) => started && save(items().filter((i) => !sources.includes(i))));
    },
  };
});
