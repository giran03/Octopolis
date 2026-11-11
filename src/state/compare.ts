// Compare mode: two panes' folders marked against each other until turned off.
import { createMemo, createRoot, createSignal } from "solid-js";
import { compareListings, type CompareStatus } from "../lib/compare";
import type { TabModel } from "./tab";

export const compare = createRoot(() => {
  const [pair, setPair] = createSignal<readonly [TabModel, TabModel] | null>(null);
  const left = createMemo(() => {
    const p = pair();
    return p ? compareListings(p[0].listing(), p[1].listing()) : null;
  });
  const right = createMemo(() => {
    const p = pair();
    return p ? compareListings(p[1].listing(), p[0].listing()) : null;
  });
  return {
    active: () => pair() !== null,
    start: (a: TabModel, b: TabModel) => setPair([a, b]),
    stop: () => setPair(null),
    /** The tab on the other side of `tab`, while comparing. */
    otherOf: (tab: TabModel): TabModel | null => {
      const p = pair();
      return p ? (p[0] === tab ? p[1] : p[1] === tab ? p[0] : null) : null;
    },
    /** Status of each item in `tab` (by lower-case name), or null when `tab` isn't being compared. */
    statusOf: (tab: TabModel): ReadonlyMap<string, CompareStatus> | null => {
      const p = pair();
      if (!p) return null;
      return p[0] === tab ? left() : p[1] === tab ? right() : null;
    },
  };
});
