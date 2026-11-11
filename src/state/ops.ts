// Queued and finished file operations, the internal clipboard, and undo.
import { batch, createEffect, createRoot, createSignal, on } from "solid-js";
import * as ipc from "../lib/ipc";
import { cancelOp, errorText, pauseOp, startOp, type ConflictChoice, type OpEvent, type OpOptions, type OpRequest } from "../lib/ipc";
import { planTransfer, type NameConflict, type Resolution } from "../lib/conflicts";
import { baseName, parentPath, samePath } from "../lib/paths";
import { EMPTY_STACKS, popRedo, popUndo, pushAction, redoStep, undoStep, type Pair, type Step, type UndoAction } from "../lib/undo";
import { formatKeys } from "../lib/keymap";
import { finishNotice } from "../lib/notify";
import { keybindings } from "./keybindings";
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
  const [clip, setClipRaw] = createSignal<Clip | null>(null);
  /** Windows clipboard sequence number right after Octopolis last wrote files to it. */
  let ownSequence: number | null = null;
  // Keep the PC awake while anything is queued or running.
  const busy = () => settings.keepAwake() && list().some((o) => o.state !== "finished");
  createEffect(on(busy, (on) => void ipc.setKeepAwake(on).catch(() => undefined)));

  /** Whether the Windows clipboard holds files from another app, checked when the window gets focus. */
  const [externalFiles, setExternalFiles] = createSignal(false);

  async function checkExternalClipboard() {
    const os = await ipc.clipboardReadFiles().catch(() => null);
    setExternalFiles(!!os && os.paths.length > 0 && (ownSequence === null || os.sequence !== ownSequence));
  }

  /**
   * Sets the internal clipboard and mirrors it to the Windows one, so the files
   * paste in Explorer and other apps. Items inside archives stay internal.
   */
  function setClip(c: Clip | null) {
    setClipRaw(c);
    ownSequence = null;
    if (!c || c.archive || c.paths.length === 0) return;
    ipc
      .clipboardWriteFiles([...c.paths], c.mode === "cut")
      .then((seq) => {
        if (clip() === c) ownSequence = seq;
      })
      .catch(() => {
        // The internal clipboard still works inside Octopolis.
      });
  }
  const [stacks, setStacks] = createSignal(EMPTY_STACKS);
  let lastUndoToast: number | null = null;

  const undoShortcut = () => {
    const seq = keybindings.keysForId("file.undo")[0];
    return seq ? formatKeys(seq) : undefined;
  };

  const clearUndoToast = () => {
    if (lastUndoToast === null) return;
    ui.dismissToast(lastUndoToast);
    lastUndoToast = null;
  };

  const undo = () => {
    clearUndoToast();
    return travel(popUndo(stacks()), undoStep, "Undo");
  };

  /** Shows a toast with an Undo button (and current Undo shortcut) for destructive or displacing actions. */
  const undoToast = (text: string) => {
    clearUndoToast();
    lastUndoToast = ui.toast(
      text,
      {
        label: "Undo",
        shortcut: undoShortcut(),
        onClick: () => void undo(),
      },
      5500,
    );
  };

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
    else if (request.kind === "move" && pairs.length) {
      record({ kind: "move", label, pairs });
      undoToast(`Moved ${describe(pairs.map(([from]) => from))}`);
    } else if (request.kind === "compress" && e.created[0]) record({ kind: "newFile", label, path: e.created[0] });
    else if (request.kind === "delete" && !request.permanent) {
      const paths = request.paths.filter((p) => !failed.has(p.toLowerCase()));
      if (paths.length) {
        record({ kind: "recycle", label, paths });
        undoToast(`Moved ${describe(paths)} to Recycle Bin`);
      }
    }
  }

  /** Runs an operation; resolves with its problems once it has finished. */
  function run(request: OpRequest, label: string, remember = true, conflict: ConflictChoice = "keepBoth"): Promise<OpOutcome> {
    return new Promise((finish) => void startRun(request, label, remember, conflict, finish));
  }

  /**
   * Copies or moves `sources` into `dest`. When names are already taken there,
   * asks the user what to do first. Resolves true once the work is queued,
   * false if the user cancelled.
   */
  async function transfer(kind: "copy" | "move", sources: readonly string[], dest: string): Promise<boolean> {
    const verb = kind === "move" ? "Moving" : "Copying";
    let conflicts: NameConflict[] = [];
    try {
      conflicts = await ipc.transferConflicts([...sources], dest);
    } catch {
      // If the check itself fails, fall back to the safe default of keeping both.
    }
    if (conflicts.length === 0) {
      void run({ kind, sources: [...sources], dest }, `${verb} ${describe(sources)}`);
      return true;
    }
    return new Promise((resolve) => {
      ui.askConflicts({
        kind,
        dest,
        conflicts,
        total: sources.length,
        onResolve: (choices: ReadonlyMap<string, Resolution> | null, fallback: Resolution) => {
          if (!choices) return resolve(false);
          const plan = planTransfer(sources, conflicts, choices, fallback);
          if (plan.keepBoth.length) void run({ kind, sources: [...plan.keepBoth], dest }, `${verb} ${describe(plan.keepBoth)}`);
          if (plan.replace.length) void run({ kind, sources: [...plan.replace], dest }, `${verb} ${describe(plan.replace)} (replacing)`, true, "overwrite");
          if (plan.skipped.length) ui.toast(`Skipped ${describe(plan.skipped)}`);
          resolve(true);
        },
      });
    });
  }

  async function startRun(request: OpRequest, label: string, remember: boolean, conflict: ConflictChoice, finish: (o: OpOutcome) => void) {
    const key = nextKey++;
    setList((l) => [
      ...l,
      { key, id: null, label, state: "queued", totalBytes: 0, doneBytes: 0, totalItems: 0, doneItems: 0, current: null, cancelled: false, errors: [] },
    ]);
    let startedAt = Date.now();
    const onEvent = (e: OpEvent) => {
      if (e.type === "started") startedAt = Date.now();
      if (e.type === "started") return patch(key, (o) => (o.state === "queued" ? { ...o, state: "running" } : o));
      if (e.type === "progress") {
        const { type: _t, ...fields } = e;
        return patch(key, (o) => ({ ...o, ...fields, state: o.state === "queued" ? "running" : o.state }));
      }
      patch(key, (o) => ({ ...o, state: "finished", cancelled: e.cancelled, errors: e.errors, current: null }));
      if (remember) recordFinished(request, label, e);
      const notice = finishNotice(
        { kind: request.kind, label, elapsedMs: Date.now() - startedAt, errors: e.errors.length, cancelled: e.cancelled },
        { enabled: settings.notifyDone(), focused: document.hasFocus() },
      );
      if (notice) void ipc.notify(notice.title, notice.body).catch(() => undefined);
      refreshAffected(request, e.created);
      if (e.errors.length === 0) setTimeout(() => dismiss(key), DONE_LINGER_MS);
      finish({ errors: e.errors, cancelled: e.cancelled });
    };
    const transfer = request.kind === "copy" || request.kind === "move";
    const options: OpOptions = { conflict, verify: transfer && settings.verifyCopies(), limitBps: transfer ? settings.speedLimit() : null };
    try {
      const id = await startOp(request, options, onEvent);
      patch(key, (o) => ({ ...o, id }));
    } catch (e) {
      const errors = [{ path: "", message: errorText(e) }];
      patch(key, (o) => ({ ...o, state: "finished", errors }));
      finish({ errors, cancelled: false });
    }
  }

  /** A screenshot or text on the clipboard becomes a new file, ready to rename. */
  async function pasteAsNewFile(dest: string) {
    try {
      const created = await ipc.pasteClipboardAsFile(dest);
      if (!created) return ui.toast("Nothing to paste");
      record({ kind: "newFile", label: `Paste "${baseName(created)}"`, path: created });
      const tab = workspace.allTabs().find((t) => samePath(t.path(), dest));
      if (!tab) return;
      await tab.navigate(dest, [baseName(created)]);
      const entry = [...tab.selection()][0];
      if (entry !== undefined) tab.setRenaming(entry);
    } catch (e) {
      ui.toast(`Couldn't paste: ${errorText(e)}`);
    }
  }

  /**
   * Pastes into `dest`: files another app put on the Windows clipboard after
   * Octopolis's own copy win, as they do in Explorer.
   */
  async function paste(dest: string) {
    const os = await ipc.clipboardReadFiles().catch(() => null);
    const c = clip();
    const ownIsCurrent = !!c && (!!c.archive || os === null || ownSequence === null || os.sequence === ownSequence);
    if (os && os.paths.length && !ownIsCurrent) {
      if (c) setClipRaw(null);
      const started = await transfer(os.cut ? "move" : "copy", os.paths, dest);
      // Explorer empties the clipboard once cut files have been moved.
      if (started && os.cut) void ipc.clipboardClear().catch(() => undefined);
      return;
    }
    if (!c || c.paths.length === 0 || !ownIsCurrent) return pasteAsNewFile(dest);
    const what = describe(c.paths);
    if (c.archive) {
      const root = c.archive;
      const items = c.paths.map((p) => p.slice(root.length + 1));
      void run({ kind: "extract", archive: root, items, dest }, `Extracting ${what}`);
    } else if (c.mode === "cut") {
      // A cut is consumed by its paste, unless the user cancels at the conflict question.
      void transfer("move", c.paths, dest).then((started) => {
        if (!started || clip() !== c) return;
        setClip(null);
        void ipc.clipboardClear().catch(() => undefined);
      });
    } else {
      void transfer("copy", c.paths, dest);
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
      case "createFile":
        await ipc.createFile(parentPath(step.path) ?? step.path, baseName(step.path));
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
    /** True when Paste has something to paste, from Octopolis or another app. */
    canPaste: () => (clip()?.paths.length ?? 0) > 0 || externalFiles(),
    checkExternalClipboard,
    run,
    transfer,
    paste,
    remove,
    dismiss,
    record,
    undoToast,
    undo,
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
