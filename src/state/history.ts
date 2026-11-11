// Frecency of visited folders (for the palette and path bar suggestions).
import { createRoot, createSignal } from "solid-js";
import { forget, recordVisit, topVisits, type FrecencyDb } from "../lib/frecency";
import { loadJson, saveJson } from "./settings";

const KEY = "octopolis.frecency.v1";
const SAVE_DELAY_MS = 1000;

export const history = createRoot(() => {
  const [db, setDb] = createSignal<FrecencyDb>(loadJson<FrecencyDb>(KEY, {}));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(() => saveJson(KEY, db()), SAVE_DELAY_MS);
  };
  return {
    visit: (path: string) => {
      setDb((d) => recordVisit(d, path, Date.now()));
      persist();
    },
    forget: (path: string) => {
      setDb((d) => forget(d, path));
      persist();
    },
    top: (limit?: number) => topVisits(db(), Date.now(), limit),
  };
});
