// The undo model: what each file action did, and the step that reverses or
// repeats it. Permanent deletes are never recorded because they can't be undone.

export type Pair = readonly [from: string, to: string];

export type UndoAction =
  | { readonly kind: "move"; readonly label: string; readonly pairs: readonly Pair[] }
  | { readonly kind: "copy"; readonly label: string; readonly pairs: readonly Pair[] }
  | { readonly kind: "newFolder"; readonly label: string; readonly path: string }
  | { readonly kind: "recycle"; readonly label: string; readonly paths: readonly string[] };

export type Step =
  | { readonly type: "relocate"; readonly pairs: readonly Pair[] }
  | { readonly type: "recycle"; readonly paths: readonly string[] }
  | { readonly type: "restore"; readonly paths: readonly string[] }
  | { readonly type: "removeEmpty"; readonly path: string }
  | { readonly type: "createFolder"; readonly path: string }
  | { readonly type: "copy"; readonly sources: readonly string[]; readonly dest: string };

const parentOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf("\\"), 2));

export function undoStep(a: UndoAction): Step {
  switch (a.kind) {
    case "move":
      return { type: "relocate", pairs: a.pairs.map(([from, to]) => [to, from] as const) };
    case "copy":
      return { type: "recycle", paths: a.pairs.map(([, to]) => to) };
    case "newFolder":
      return { type: "removeEmpty", path: a.path };
    case "recycle":
      return { type: "restore", paths: a.paths };
  }
}

export function redoStep(a: UndoAction): Step {
  switch (a.kind) {
    case "move":
      return { type: "relocate", pairs: a.pairs };
    case "copy":
      return { type: "copy", sources: a.pairs.map(([from]) => from), dest: parentOf(a.pairs[0][1]) };
    case "newFolder":
      return { type: "createFolder", path: a.path };
    case "recycle":
      return { type: "recycle", paths: a.paths };
  }
}

export interface UndoStacks {
  readonly done: readonly UndoAction[];
  readonly undone: readonly UndoAction[];
}

export const EMPTY_STACKS: UndoStacks = { done: [], undone: [] };
export const MAX_UNDO = 100;

export function pushAction(s: UndoStacks, a: UndoAction): UndoStacks {
  return { done: [...s.done, a].slice(-MAX_UNDO), undone: [] };
}

/** Moves the latest action to the redo stack. */
export function popUndo(s: UndoStacks): { stacks: UndoStacks; action: UndoAction } | null {
  const action = s.done[s.done.length - 1];
  return action ? { action, stacks: { done: s.done.slice(0, -1), undone: [...s.undone, action] } } : null;
}

/** Moves the latest undone action back to the undo stack. */
export function popRedo(s: UndoStacks): { stacks: UndoStacks; action: UndoAction } | null {
  const action = s.undone[s.undone.length - 1];
  return action ? { action, stacks: { done: [...s.done, action], undone: s.undone.slice(0, -1) } } : null;
}
