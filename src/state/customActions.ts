// The user's custom actions, remembered between launches.
import { createRoot, createSignal } from "solid-js";
import { newActionId, parseActions, uniqueActionName, type CustomAction } from "../lib/customActions";
import { loadJson, saveJson } from "./settings";

const KEY = "octopolis.actions.v1";

export interface AddBatchResult {
  readonly added: readonly CustomAction[];
  readonly existing: readonly CustomAction[];
}

export const customActions = createRoot(() => {
  const [list, setList] = createSignal<readonly CustomAction[]>(parseActions(loadJson<unknown>(KEY, [])));
  const [highlighted, setHighlighted] = createSignal<readonly string[]>([]);
  let clearTimer: ReturnType<typeof setTimeout> | undefined;

  const save = (next: readonly CustomAction[]) => {
    setList(next);
    saveJson(KEY, next);
  };

  const highlight = (ids: readonly string[]) => {
    clearTimeout(clearTimer);
    setHighlighted(ids);
    if (ids.length) {
      clearTimer = setTimeout(() => setHighlighted([]), 3500);
    }
  };

  /** Adds runnable batch actions, reusing any existing action with the exact same command. */
  const addBatchActions = (candidates: readonly Omit<CustomAction, "id">[]): AddBatchResult => {
    const current = [...list()];
    const names = current.map((a) => a.name);
    const added: CustomAction[] = [];
    const existing: CustomAction[] = [];

    for (const c of candidates) {
      const normCmd = c.command.trim().toLowerCase();
      const match = current.find((a) => a.command.trim().toLowerCase() === normCmd);
      if (match) {
        existing.push(match);
        continue;
      }
      const name = uniqueActionName(c.name, names);
      names.push(name);
      const created: CustomAction = { ...c, id: newActionId(), name };
      current.push(created);
      added.push(created);
    }

    if (added.length > 0) save(current);
    const ids = [...added, ...existing].map((a) => a.id);
    if (ids.length > 0) highlight(ids);
    return { added, existing };
  };

  return {
    list,
    highlighted,
    save,
    addBatchActions,
  };
});
