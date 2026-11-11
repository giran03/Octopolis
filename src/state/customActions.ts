// The user's custom actions, remembered between launches.
import { createRoot, createSignal } from "solid-js";
import { parseActions, type CustomAction } from "../lib/customActions";
import { loadJson, saveJson } from "./settings";

const KEY = "octopolis.actions.v1";

export const customActions = createRoot(() => {
  const [list, setList] = createSignal<readonly CustomAction[]>(parseActions(loadJson<unknown>(KEY, [])));
  return {
    list,
    save: (next: readonly CustomAction[]) => {
      setList(next);
      saveJson(KEY, next);
    },
  };
});
