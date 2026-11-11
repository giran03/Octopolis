// One browsing tab: location, history, streamed listing, sort and selection.
import { batch, createMemo, createRoot, createSignal } from "solid-js";
import { errorText, listDir, unwatchDir, watchDir } from "../lib/ipc";
import { createBuilder, decodeBatch, emptyListing, indexOfName, snapshot, type Listing } from "../lib/listing";
import { baseName, joinPath, parentPath, samePath } from "../lib/paths";
import { buildView, DEFAULT_SORT, toggleSort, type SortKey, type SortSpec } from "../lib/sort";
import { settings } from "./settings";

let nextTabId = 1;

export interface LoadStatus {
  readonly loading: boolean;
  readonly error: string | null;
  readonly elapsedMs: number | null;
}

interface History {
  readonly entries: readonly string[];
  readonly index: number;
}

export type TabModel = ReturnType<typeof createTab>;

export function createTab(initialPath: string) {
  return createRoot((dispose) => {
    const id = `tab-${nextTabId++}`;
    const [history, setHistory] = createSignal<History>({ entries: [initialPath], index: 0 });
    const path = () => history().entries[history().index];
    const [listing, setListing] = createSignal<Listing>(emptyListing(initialPath));
    const [status, setStatus] = createSignal<LoadStatus>({ loading: false, error: null, elapsedMs: null });
    const [sort, setSort] = createSignal<SortSpec>(DEFAULT_SORT);
    const [filter, setFilter] = createSignal("");
    /** Entry indices into the current listing. */
    const [selection, setSelection] = createSignal<ReadonlySet<number>>(new Set());
    /** Position in the view (not an entry index). */
    const [focus, setFocus] = createSignal(0);
    const [anchor, setAnchor] = createSignal(0);
    const [renaming, setRenaming] = createSignal<number | null>(null);

    const view = createMemo(() => buildView(listing(), { sort: sort(), showHidden: settings.showHidden(), filter: filter() }));
    let generation = 0;
    let watchedPath: string | null = null;
    /**
     * Names an explicit request (new folder, paste, rename, "go up") wants
     * selected. It survives a refresh that supersedes the request's load.
     */
    let pendingSelect: readonly string[] | null = null;

    const sameSet = (a: ReadonlySet<number>, b: ReadonlySet<number>) => a.size === b.size && [...a].every((x) => b.has(x));

    const selectNames = (names: readonly string[], l: Listing) => {
      const picked = names.map((n) => indexOfName(l, n)).filter((i) => i >= 0);
      setSelection(new Set(picked));
      const pos = picked.length ? view().indexOf(picked[0]) : -1;
      if (pos >= 0) {
        setFocus(pos);
        setAnchor(pos);
      }
    };

    const focusedName = (): string | null => {
      const e = view()[focus()];
      return e === undefined ? null : listing().names[e];
    };

    /**
     * After a refresh, keeps the selection and focus on the same names without
     * touching signals that didn't change, so the list doesn't jump.
     */
    function restoreByName(names: readonly string[], focusName: string | null) {
      const l = listing();
      const picked = new Set(names.map((n) => indexOfName(l, n)).filter((i) => i >= 0));
      if (!sameSet(picked, selection())) setSelection(picked);
      const focusEntry = focusName === null ? -1 : indexOfName(l, focusName);
      const pos = focusEntry >= 0 ? view().indexOf(focusEntry) : Math.min(focus(), Math.max(0, view().length - 1));
      if (pos >= 0 && pos !== focus()) setFocus(pos);
    }

    /** Loads `dir`, then selects `select` names (by default keeps the current selection by name). */
    async function load(dir: string, select?: readonly string[]) {
      const gen = ++generation;
      const builder = createBuilder(dir);
      const sameDir = samePath(listing().path, dir);
      if (select) pendingSelect = select;
      setStatus({ loading: true, error: null, elapsedMs: null });
      if (!sameDir) {
        pendingSelect = select ?? null;
        batch(() => {
          setListing(emptyListing(dir));
          setSelection(new Set<number>());
          setFocus(0);
          setRenaming(null);
        });
      }
      try {
        let firstPaint = !sameDir;
        const summary = await listDir(dir, (buf) => {
          if (gen !== generation) return true; // a newer load superseded this one
          const done = decodeBatch(buf, builder);
          // A new folder paints its first batch at once. A refresh swaps the
          // whole listing in below, together with the remapped selection.
          if (firstPaint && !done) {
            firstPaint = false;
            setListing(snapshot(builder));
          }
          return done;
        });
        if (gen !== generation) return;
        batch(() => {
          // Decide what to select now, not when the load started: the user
          // may have clicked while it was running.
          const explicit = pendingSelect;
          const names = explicit ?? selectedNames();
          const focusName = explicit?.length ? null : focusedName();
          pendingSelect = null;
          setListing(snapshot(builder));
          setStatus({ loading: false, error: null, elapsedMs: summary.elapsedMs });
          if (explicit?.length) selectNames(explicit, listing());
          else restoreByName(names, focusName);
        });
        if (!watchedPath || !samePath(watchedPath, dir)) {
          watchedPath = dir;
          watchDir(id, dir, () => void refresh()).catch(() => (watchedPath = null));
        }
      } catch (e) {
        if (gen !== generation) return;
        setStatus({ loading: false, error: errorText(e), elapsedMs: null });
      }
    }

    function selectedNames(): string[] {
      const l = listing();
      return [...selection()].filter((i) => i < l.count).map((i) => l.names[i]);
    }

    function navigate(dir: string, select?: readonly string[]): Promise<void> {
      if (samePath(dir, path())) return load(dir, select);
      setHistory((h) => ({ entries: [...h.entries.slice(0, h.index + 1), dir], index: h.index + 1 }));
      return load(dir, select ?? []);
    }

    function go(step: -1 | 1) {
      const h = history();
      const index = h.index + step;
      if (index < 0 || index >= h.entries.length) return;
      // Going back selects the folder we came out of, like Explorer.
      const leaving = path();
      setHistory({ ...h, index });
      const target = h.entries[index];
      const child = parentPath(leaving) && samePath(parentPath(leaving)!, target) ? [baseName(leaving)] : [];
      void load(target, child);
    }

    function up() {
      const parent = parentPath(path());
      if (parent) navigate(parent, [baseName(path())]);
    }

    const refresh = () => load(path());

    function close() {
      generation++;
      void unwatchDir(id).catch(() => undefined);
      dispose();
    }

    const pathOf = (entry: number) => joinPath(listing().path, listing().names[entry]);

    return {
      id,
      path,
      listing,
      status,
      view,
      sort,
      filter,
      selection,
      focus,
      anchor,
      renaming,
      setFilter,
      setSelection,
      setFocus,
      setAnchor,
      setRenaming,
      navigate,
      back: () => go(-1),
      forward: () => go(1),
      canBack: () => history().index > 0,
      canForward: () => history().index < history().entries.length - 1,
      up,
      refresh,
      close,
      selectNames: (names: readonly string[]) => selectNames(names, listing()),
      sortBy: (key: SortKey) => setSort((s) => toggleSort(s, key)),
      selectedPaths: () => [...selection()].filter((i) => i < listing().count).map(pathOf),
      pathOf,
      title: () => baseName(path()) || path(),
    };
  });
}
