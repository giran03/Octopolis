// Queued and finished file operations, the internal clipboard, and undo.
import { batch, createRoot, createSignal } from "solid-js";
import * as ipc from "../lib/ipc";
import { cancelOp, errorText, pauseOp, startOp, type OpEvent, type OpOptions, type OpRequest } from "../lib/ipc";
import { baseName, parentPath, samePath } from "../lib/paths";
import { EMPTY_STACKS, popRedo, popUndo, pushAction, redoStep, undoStep, type Pair, type Step, type UndoAction } from "../lib/undo";
import { settings } from "./settings";
import { ui } from "./ui";
import { workspace } from "./workspace";

export type OpState = "queued" | "running" | "paused" | "finished";

export interface OpView {
  readonly key: number;
  readonly id: number | null;
  readonly label: string;
  readonly state: OpState;
  readonly totalBytes: number;
  readonly doneBytes: number;
  readonly totalItems: number;
  readonly doneItems: number;
  readonly current: string | null;
  readonly cancelled: boolean;
  readonly errors: readonly { path: string; message: string }[];
}

export interface OpOutcome {
  readonly errors: readonly { path: string; message: string }[];
  readonly cancelled: boolean;
}

/** Turns a finished operation's problems into a thrown error. */
function assertClean(o: OpOutcome) {
  if (o.cancelled) throw new Error("it was cancelled");
  if (o.errors.length) throw new Error(o.errors[0].message);
}

export interface Clip {
  readonly mode: "copy" | "cut";
  readonly paths: readonly string[];
  /** The archive these paths are inside, if any (copying then extracts). */
  readonly archive?: string | null;
}

/** How long a successful operation stays in the tray. */
const DONE_LINGER_MS = 2500;
let nextKey = 1;

const describe = (paths: readonly string[]) => (paths.length === 1 ? `"${baseName(paths[0])}"` : `${paths.length} items`);

export const ops = createRoot(() => {
  const [list, setList] = createSignal<readonly OpView[]>([]);
  const [clip, setClip] = createSignal<Clip | null>(null);
  const [stacks, setStacks] = createSignal(EMPTY_STACKS);

  const patch = (key: number, fn: (o: OpView) => OpView) => setList((l) => l.map((o) => (o.key === key ? fn(o) : o)));
  const dismiss = (key: number) => setList((l) => l.filter((o) => o.key !== key));
  const record = (a: UndoAction) => setStacks((s) => pushAction(s, a));

  function refreshDirs(dirs: readonly (string | null)[]) {
    for (const tab of workspace.allTabs()) {
      if (dirs.some((d) => d && samePath(d, tab.path()))) void tab.refresh();
    }
  }

  /** Refreshes tabs showing touched folders and selects new items in the destination. */
  function refreshAffected(request: OpRequest, created: readonly string[]) {
    let dirs: (string | null)[];
    let dest: string | null = null;
    switch (request.kind) {
      case "delete":
        dirs = request.paths.map(parentPath);
        break;
      case "relocate":
        dirs = request.pairs.flatMap(([a, b]) => [parentPath(a), parentPath(b)]);
        break;
      case "extract":
        dest = request.dest;
        dirs = [request.dest];
        break;
      default:
        dest = request.dest;
        dirs = [request.dest, ...request.sources.map(parentPath)];
    }
    for (const tab of workspace.allTabs()) {
      if (!dirs.some((d) => d && samePath(d, tab.path()))) continue;
      if (dest && samePath(dest, tab.path()) && created.length && !tab.search()) void tab.navigate(tab.path(), created.map(baseName));
      else void tab.refresh();
    }
  }

  function recordFinished(request: OpRequest, label: string, e: Extract<OpEvent, { type: "done" }>) {
    if (e.cancelled) return;
    const failed = new Set(e.errors.map((x) => x.path.toLowerCase()));
    const pairs = e.pairs as readonly Pair[];
    if (request.kind === "copy" && pairs.length) record({ kind: "copy", label, pairs });
    else if (request.kind === "move" && pairs.length) record({ kind: "move", label, pairs });
    else if (request.kind === "delete" && !request.permanent) {
      const paths = request.paths.filter((p) => !failed.has(p.toLowerCase()));
      if (paths.length) record({ kind: "recycle", label, paths });
    }
  }

  /** Runs an operation; resolves with its problems once it has finished. */
  function run(request: OpRequest, label: string, remember = true): Promise<OpOutcome> {
    return new Promise((finish) => void startRun(request, label, remember, finish));
  }

  async function startRun(request: OpRequest, label: string, remember: boolean, finish: (o: OpOutcome) => void) {
    const key = nextKey++;
    setList((l) => [
      ...l,
      { key, id: null, label, state: "queued", totalBytes: 0, doneBytes: 0, totalItems: 0, doneItems: 0, current: null, cancelled: false, errors: [] },
    ]);
    const onEvent = (e: OpEvent) => {
      if (e.type === "started") return patch(key, (o) => (o.state === "queued" ? { ...o, state: "running" } : o));
      if (e.type === "progress") {
        const { type: _t, ...fields } = e;
        return patch(key, (o) => ({ ...o, ...fields, state: o.state === "queued" ? "running" : o.state }));
      }
      patch(key, (o) => ({ ...o, state: "finished", cancelled: e.cancelled, errors: e.errors, current: null }));
      if (remember) recordFinished(request, label, e);
      refreshAffected(request, e.created);
      if (e.errors.length === 0) setTimeout(() => dismiss(key), DONE_LINGER_MS);
      finish({ errors: e.errors, cancelled: e.cancelled });
    };
    const transfer = request.kind === "copy" || request.kind === "move";
    const options: OpOptions = { conflict: "keepBoth", verify: transfer && settings.verifyCopies(), limitBps: transfer ? settings.speedLimit() : null };
    try {
      const id = await startOp(request, options, onEvent);
      patch(key, (o) => ({ ...o, id }));
    } catch (e) {
      const errors = [{ path: "", message: errorText(e) }];
      patch(key, (o) => ({ ...o, state: "finished", errors }));
      finish({ errors, cancelled: false });
    }
  }

  function paste(dest: string) {
    const c = clip();
    if (!c || c.paths.length === 0) return;
    const what = describe(c.paths);
    if (c.archive) {
      const root = c.archive;
      const items = c.paths.map((p) => p.slice(root.length + 1));
      void run({ kind: "extract", archive: root, items, dest }, `Extracting ${what}`);
    } else if (c.mode === "cut") {
      void run({ kind: "move", sources: [...c.paths], dest }, `Moving ${what}`);
      setClip(null); // a cut is consumed by its paste
    } else {
      void run({ kind: "copy", sources: [...c.paths], dest }, `Copying ${what}`);
    }
  }

  function remove(paths: readonly string[], permanent: boolean) {
    if (paths.length === 0) return;
    void run({ kind: "delete", paths: [...paths], permanent }, permanent ? `Deleting ${describe(paths)}` : `Recycling ${describe(paths)}`);
  }

  async function perform(step: Step) {
    switch (step.type) {
      case "relocate": {
        const pairs = step.pairs.map(([a, b]) => [a, b] as [string, string]);
        // Renames in one folder may swap names or differ only by case; the
        // batch renamer handles both, a plain move refuses them.
        if (pairs.every(([a, b]) => samePath(parentPath(a) ?? a, parentPath(b) ?? b))) {
          await ipc.batchRename(pairs.map(([a, b]) => [a, baseName(b)]));
          return refreshDirs(pairs.map(([a]) => parentPath(a)));
        }
        return assertClean(await run({ kind: "relocate", pairs }, "Moving items back", false));
      }
      case "recycle":
        return assertClean(await run({ kind: "delete", paths: [...step.paths], permanent: false }, `Recycling ${describe(step.paths)}`, false));
      case "copy":
        return assertClean(await run({ kind: "copy", sources: [...step.sources], dest: step.dest }, `Copying ${describe(step.sources)}`, false));
      case "restore": {
        const restored = await ipc.restoreRecycled([...step.paths]);
        refreshDirs(step.paths.map(parentPath));
        if (restored < step.paths.length) throw new Error("some items are no longer in the Recycle Bin");
        return;
      }
      case "removeEmpty":
        await ipc.removeEmptyDir(step.path);
        return refreshDirs([parentPath(step.path)]);
      case "createFolder":
        await ipc.createFolder(parentPath(step.path) ?? step.path, baseName(step.path));
        return refreshDirs([parentPath(step.path)]);
    }
  }

  async function travel(popped: ReturnType<typeof popUndo>, step: (a: UndoAction) => Step, verb: string) {
    if (!popped) return ui.toast(`Nothing to ${verb.toLowerCase()}`);
    const before = stacks();
    batch(() => setStacks(popped.stacks));
    try {
      await perform(step(popped.action));
      ui.toast(`${verb}: ${popped.action.label}`);
    } catch (e) {
      setStacks(before); // the action still stands, so it stays undoable
      ui.toast(`Couldn't ${verb.toLowerCase()}: ${errorText(e)}`);
    }
  }

  return {
    list,
    clip,
    setClip,
    run,
    paste,
    remove,
    dismiss,
    record,
    undo: () => travel(popUndo(stacks()), undoStep, "Undo"),
    redo: () => travel(popRedo(stacks()), redoStep, "Redo"),
    cancel: (o: OpView) => o.id !== null && void cancelOp(o.id),
    togglePause: (o: OpView) => {
      if (o.id === null) return;
      const paused = o.state !== "paused";
      void pauseOp(o.id, paused);
      patch(o.key, (x) => ({ ...x, state: paused ? "paused" : "running" }));
    },
    isCut: (path: string) => {
      const c = clip();
      return c?.mode === "cut" && c.paths.some((p) => samePath(p, path));
    },
  };
});
