// User overrides of command shortcuts, layered over the defaults.
import { createMemo, createRoot, createSignal } from "solid-js";
import { ChordMatcher } from "../lib/keymap";
import { loadJson, saveJson, settings } from "./settings";

const KEY = "octopolis.keys.v1";

export interface Bindable {
  readonly id: string;
  readonly keys?: readonly string[];
  readonly vimKeys?: readonly string[];
  readonly global?: boolean;
}

type Overrides = Readonly<Record<string, readonly string[]>>;

export const keybindings = createRoot(() => {
  const [overrides, setOverrides] = createSignal<Overrides>(loadJson<Overrides>(KEY, {}));
  const [commands, setCommands] = createSignal<readonly Bindable[]>([]);

  const keysFor = (c: Bindable): readonly string[] => overrides()[c.id] ?? c.keys ?? [];

  const build = (global: boolean) =>
    createMemo(() => {
      const pairs: [string, string][] = [];
      for (const c of commands()) {
        if (global && !c.global) continue;
        for (const k of keysFor(c)) pairs.push([k, c.id]);
        if (!global && settings.vimMode()) for (const k of c.vimKeys ?? []) pairs.push([k, c.id]);
      }
      return new ChordMatcher(pairs);
    });

  const save = (next: Overrides) => {
    setOverrides(next);
    saveJson(KEY, next);
  };

  return {
    register: (list: readonly Bindable[]) => setCommands(list),
    keysFor,
    keysForId: (id: string): readonly string[] => {
      const cmd = commands().find((c) => c.id === id);
      return cmd ? keysFor(cmd) : [];
    },
    isCustom: (id: string) => id in overrides(),
    /** Matcher for keys typed while a text field has focus. */
    globalMatcher: build(true),
    /** Matcher for everything else (includes Vim keys when enabled). */
    matcher: build(false),
    set: (id: string, keys: readonly string[]) => save({ ...overrides(), [id]: keys }),
    reset: (id: string) => {
      const copy = { ...overrides() };
      delete copy[id];
      save(copy);
    },
    resetAll: () => save({}),
    customCount: () => Object.keys(overrides()).length,
    /** Which other command already uses this sequence, if any. */
    conflict: (seq: string, exceptId: string) => commands().find((c) => c.id !== exceptId && keysFor(c).includes(seq))?.id,
  };
});
