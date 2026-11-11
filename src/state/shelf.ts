// The Portal Dropzone: a staging basket for files from many folders.
import { createRoot, createSignal } from "solid-js";
import { baseName, samePath } from "../lib/paths";
import { ops } from "./ops";
import { loadJson, saveJson } from "./settings";

const KEY = "octopolis.shelf.v1";

export const shelf = createRoot(() => {
  const [items, setItems] = createSignal<readonly string[]>(loadJson<string[]>(KEY, []));
  const [open, setOpen] = createSignal(false);
  const save = (next: readonly string[]) => {
    setItems(next);
    saveJson(KEY, next);
  };
  const describe = () => (items().length === 1 ? `"${baseName(items()[0])}"` : `${items().length} items`);
  return {
    items,
    open,
    setOpen,
    add: (paths: readonly string[]) => {
      save([...items(), ...paths.filter((p) => !items().some((i) => samePath(i, p)))]);
      setOpen(true);
    },
    remove: (path: string) => save(items().filter((i) => i !== path)),
    clear: () => save([]),
    /** Copies or moves everything on the shelf into `dest`, then empties it. */
    deliver: (mode: "copy" | "move", dest: string) => {
      if (items().length === 0) return;
      void ops.run({ kind: mode, sources: [...items()], dest }, `${mode === "copy" ? "Copying" : "Moving"} ${describe()}`);
      save([]);
    },
  };
});
