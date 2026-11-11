// Running and finished file operations, plus the internal clipboard.
import { createRoot, createSignal } from "solid-js";
import { cancelOp, errorText, startOp, type ConflictChoice, type OpEvent, type OpRequest } from "../lib/ipc";
import { baseName, parentPath, samePath } from "../lib/paths";
import { workspace } from "./workspace";

export interface OpView {
  readonly key: number;
  readonly id: number | null;
  readonly label: string;
  readonly totalBytes: number;
  readonly doneBytes: number;
  readonly totalItems: number;
  readonly doneItems: number;
  readonly current: string | null;
  readonly finished: boolean;
  readonly cancelled: boolean;
  readonly errors: readonly { path: string; message: string }[];
}

export interface Clip {
  readonly mode: "copy" | "cut";
  readonly paths: readonly string[];
}

/** How long a successful operation stays in the tray. */
const DONE_LINGER_MS = 2500;
let nextKey = 1;

export const ops = createRoot(() => {
  const [list, setList] = createSignal<readonly OpView[]>([]);
  const [clip, setClip] = createSignal<Clip | null>(null);

  const patch = (key: number, fn: (o: OpView) => OpView) => setList((l) => l.map((o) => (o.key === key ? fn(o) : o)));
  const dismiss = (key: number) => setList((l) => l.filter((o) => o.key !== key));

  /** Refreshes every tab showing a folder the operation touched, and selects new items in the destination. */
  function refreshAffected(request: OpRequest, created: readonly string[]) {
    const dirs = request.kind === "delete" ? request.paths.map(parentPath) : [request.dest, ...request.sources.map(parentPath)];
    for (const tab of workspace.allTabs()) {
      if (!dirs.some((d) => d && samePath(d, tab.path()))) continue;
      const isDest = request.kind !== "delete" && samePath(request.dest, tab.path());
      if (isDest && created.length) tab.navigate(tab.path(), created.map(baseName));
      else void tab.refresh();
    }
  }

  async function run(request: OpRequest, label: string, conflict: ConflictChoice = "keepBoth") {
    const key = nextKey++;
    setList((l) => [
      ...l,
      { key, id: null, label, totalBytes: 0, doneBytes: 0, totalItems: 0, doneItems: 0, current: null, finished: false, cancelled: false, errors: [] },
    ]);
    const onEvent = (e: OpEvent) => {
      if (e.type === "progress") {
        patch(key, (o) => ({ ...o, ...e }));
        return;
      }
      patch(key, (o) => ({ ...o, finished: true, cancelled: e.cancelled, errors: e.errors, current: null }));
      refreshAffected(request, e.created);
      if (e.errors.length === 0) setTimeout(() => dismiss(key), DONE_LINGER_MS);
    };
    try {
      const id = await startOp(request, conflict, onEvent);
      patch(key, (o) => ({ ...o, id }));
    } catch (e) {
      patch(key, (o) => ({ ...o, finished: true, errors: [{ path: "", message: errorText(e) }] }));
    }
  }

  function paste(dest: string) {
    const c = clip();
    if (!c || c.paths.length === 0) return;
    const n = c.paths.length;
    const what = n === 1 ? `"${baseName(c.paths[0])}"` : `${n} items`;
    if (c.mode === "cut") {
      void run({ kind: "move", sources: [...c.paths], dest }, `Moving ${what}`);
      setClip(null); // a cut is consumed by its paste
    } else {
      void run({ kind: "copy", sources: [...c.paths], dest }, `Copying ${what}`);
    }
  }

  function remove(paths: readonly string[], permanent: boolean) {
    if (paths.length === 0) return;
    const what = paths.length === 1 ? `"${baseName(paths[0])}"` : `${paths.length} items`;
    void run({ kind: "delete", paths: [...paths], permanent }, permanent ? `Deleting ${what}` : `Recycling ${what}`);
  }

  return {
    list,
    clip,
    setClip,
    run,
    paste,
    remove,
    dismiss,
    cancel: (o: OpView) => o.id !== null && void cancelOp(o.id),
    isCut: (path: string) => {
      const c = clip();
      return c?.mode === "cut" && c.paths.some((p) => samePath(p, path));
    },
  };
});
