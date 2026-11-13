// Which palette commands are used, so frequent and recent ones rise to the top.
import { createRoot, createSignal } from "solid-js";
import { parseUseDb, recentIds, recordUse, useBoost, type UseDb } from "../lib/paletteLogic";
import { loadJson, saveJson } from "./settings";

const KEY = "octopolis.paletteUse.v1";

export const paletteUse = createRoot(() => {
  const [db, setDb] = createSignal<UseDb>(parseUseDb(loadJson<unknown>(KEY, {})));
  return {
    record: (id: string) => {
      const next = recordUse(db(), id, Date.now());
      setDb(next);
      saveJson(KEY, next);
    },
    boost: (id: string) => useBoost(db()[id], Date.now()),
    recent: (limit: number) => recentIds(db(), limit),
    clear: () => {
      setDb({});
      saveJson(KEY, {});
    },
  };
});
