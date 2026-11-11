// One browsing tab: location, history, streamed listing, sort and selection.
import { batch, createMemo, createRoot, createSignal } from "solid-js";
import { cancelSearch, errorText, folderSizes, listDir, search as runSearchIpc, unwatchDir, watchDir, type SearchSummary } from "../lib/ipc";
import { createBuilder, decodeBatch, emptyListing, indexOfName, snapshot, type Listing } from "../lib/listing";
import { baseName, joinPath, parentPath, samePath } from "../lib/paths";
import { buildView, DEFAULT_SORT, toggleSort, type SortKey, type SortSpec } from "../lib/sort";
import { history as visits } from "./history";
import { settings } from "./settings";

/** A recursive search (or flat view, when the query is empty) under the tab's folder. */
export interface SearchState {
  readonly query: string;
  /** Items scanned so far while the index is being built, else null. */
  readonly indexing: number | null;
  readonly summary: SearchSummary | null;
  readonly error: string | null;
}

const SEARCH_SORT: SortSpec = { key: "relevance", dir: 1 };

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
    const [search, setSearch] = createSignal<SearchState | null>(null);
    /** The archive this folder is inside, if any (such folders are read-only). */
    const [archive, setArchive] = createSignal<string | null>(null);
    /** Recursive subfolder sizes by lower-case name, once requested. */
    const [dirSizes, setDirSizes] = createSignal<ReadonlyMap<string, number> | null>(null);
    const [treemap, setTreemap] = createSignal(false);
    /** Folder-mode sort, restored when a search ends. */
    let folderSort: SortSpec = DEFAULT_SORT;

    const view = createMemo(() =>
      buildView(listing(), { sort: sort(), showHidden: settings.showHidden(), filter: search() ? "" : filter() }),
    );
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
          setDirSizes(null);
          setTreemap(false);
        });
        void folderSizes(id, "", () => undefined).catch(() => undefined);
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
          setArchive(summary.archive);
          if (explicit?.length) selectNames(explicit, listing());
          else restoreByName(names, focusName);
        });
        visits.visit(dir);
        if (!watchedPath || !samePath(watchedPath, dir)) {
          watchedPath = dir;
          // While search results are shown, the search index tracks changes instead.
          watchDir(id, dir, () => void (search() ? undefined : refresh())).catch(() => (watchedPath = null));
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

    /** Leaves search mode without reloading (callers load what they need). */
    function dropSearch() {
      if (!search()) return;
      void cancelSearch(id).catch(() => undefined);
      batch(() => {
        setSearch(null);
        setSort(folderSort);
        setListing(emptyListing(path()));
        setSelection(new Set<number>());
      });
    }

    /** Searches the tab's folder tree; an empty query lists everything (flat view). */
    async function runSearch(query: string, rebuild = false) {
      const gen = ++generation;
      const root = path();
      const builder = createBuilder(root);
      batch(() => {
        if (!search()) {
          folderSort = sort();
          setSort(SEARCH_SORT);
        }
        setSearch((s) => ({ query, indexing: null, summary: s?.summary ?? null, error: null }));
        setRenaming(null);
        setStatus({ loading: true, error: null, elapsedMs: null });
      });
      try {
        const summary = await runSearchIpc(
          id,
          root,
          query,
          rebuild,
          (buf) => (gen === generation ? decodeBatch(buf, builder) : true),
          (scanned) => gen === generation && setSearch((s) => s && { ...s, indexing: scanned }),
        );
        if (gen !== generation) return;
        batch(() => {
          // Results keep the old list on screen until the new one is ready.
          setListing(snapshot(builder));
          setSelection(new Set<number>());
          setFocus(0);
          setAnchor(0);
          setSearch({ query, indexing: null, summary, error: null });
          setStatus({ loading: false, error: null, elapsedMs: summary.elapsedMs });
        });
      } catch (e) {
        if (gen !== generation) return;
        const msg = errorText(e);
        if (msg === "cancelled") return;
        batch(() => {
          setSearch((s) => s && { ...s, indexing: null, error: msg });
          setStatus({ loading: false, error: null, elapsedMs: null });
        });
      }
    }

    /** Computes the recursive size of every subfolder, updating as each finishes. */
    function computeSizes() {
      if (archive() || search()) return;
      const dir = path();
      setDirSizes(new Map());
      void folderSizes(id, dir, (s) => {
        if (!samePath(dir, path())) return;
        setDirSizes((m) => new Map(m ?? []).set(s.name.toLowerCase(), s.bytes));
      }).catch(() => undefined);
    }

    function exitSearch() {
      if (!search()) return;
      dropSearch();
      void load(path());
    }

    function navigate(dir: string, select?: readonly string[]): Promise<void> {
      dropSearch();
      if (samePath(dir, path())) return load(dir, select);
      setHistory((h) => ({ entries: [...h.entries.slice(0, h.index + 1), dir], index: h.index + 1 }));
      return load(dir, select ?? []);
    }

    function go(step: -1 | 1) {
      const h = history();
      const index = h.index + step;
      if (index < 0 || index >= h.entries.length) return;
      dropSearch();
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

    /** Reloads the folder, or re-runs the search with a fresh index. */
    const refresh = () => {
      const s = search();
      return s ? runSearch(s.query, true) : load(path());
    };

    function close() {
      generation++;
      void unwatchDir(id).catch(() => undefined);
      void cancelSearch(id).catch(() => undefined);
      void folderSizes(id, "", () => undefined).catch(() => undefined);
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
      search,
      archive,
      dirSizes,
      treemap,
      setTreemap,
      computeSizes,
      clearSizes: () => {
        setDirSizes(null);
        void folderSizes(id, "", () => undefined).catch(() => undefined);
      },
      runSearch,
      exitSearch,
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
