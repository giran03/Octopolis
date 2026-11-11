// Searches saved to the sidebar: a query run from a folder, opened live.
import { createRoot, createSignal } from "solid-js";
import { loadJson, saveJson } from "./settings";

export interface SavedSearch {
  readonly name: string;
  readonly root: string;
  readonly query: string;
}

const KEY = "octopolis.searches.v1";
const MAX = 50;

/** Keeps only well-formed saved searches from stored JSON. */
export function parseSavedSearches(raw: unknown): SavedSearch[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is SavedSearch => !!s && typeof s.name === "string" && typeof s.root === "string" && typeof s.query === "string" && s.name.trim() !== "" && s.root !== "")
    .slice(0, MAX);
}

export const savedSearches = createRoot(() => {
  const [list, setList] = createSignal<readonly SavedSearch[]>(parseSavedSearches(loadJson<unknown>(KEY, [])));
  const save = (next: readonly SavedSearch[]) => {
    setList(next);
    saveJson(KEY, next);
  };
  return {
    list,
    /** Adds a search, replacing one with the same name. */
    add: (s: SavedSearch) => save([...list().filter((x) => x.name !== s.name), s].slice(-MAX)),
    remove: (name: string) => save(list().filter((x) => x.name !== name)),
  };
});
