// One browsing tab: location, history, streamed listing, sort and selection.
import { batch, createEffect, createMemo, createRoot, createSignal } from "solid-js";
import { cachedFolderSizes, cancelSearch, errorText, folderSizes, gitLastCommits, gitStatus, listDir, search as runSearchIpc, unwatchDir, watchDir, type CommitInfo, type GitInfo, type SearchSummary } from "../lib/ipc";
import { createBuilder, decodeBatch, emptyListing, indexOfName, snapshot, type Listing } from "../lib/listing";
import { baseName, joinPath, parentPath, samePath } from "../lib/paths";
import { buildView, DEFAULT_SORT, toggleSort, type SortKey, type SortSpec } from "../lib/sort";
import { parseFolderViews, rememberView, viewFor, type FolderViews, type ViewMode } from "../lib/folderViews";
import { history as visits } from "./history";
import { loadJson, saveJson, settings } from "./settings";

const FOLDER_VIEWS_KEY = "octopolis.folderviews.v1";
/** Each folder's last view and sort, shared by every tab. */
let folderViews: FolderViews = parseFolderViews(loadJson<unknown>(FOLDER_VIEWS_KEY, []));

/** A recursive search (or flat view, when the query is empty) under the tab's folder. */
export interface SearchState {
  readonly query: string;
  /** Items scanned so far while the index is being built, else null. */
  readonly indexing: number | null;
  readonly summary: SearchSummary | null;
  readonly error: string | null;
}

const SEARCH_SORT: SortSpec = { key: "relevance", dir: 1 };
const MAX_SESSION_SIZE_DIRS = 250;
/** In-memory session cache of subfolder sizes keyed by normalized parent folder path. */
const sessionSizes = new Map<string, Map<string, number>>();

export const sessionSizeCount = () => sessionSizes.size;
export function clearSessionSizes() {
  sessionSizes.clear();
}
const dirKey = (dir: string) => dir.replace(/[\\/]+$/, "").toLowerCase();

function rememberSizes(dir: string, entries: ReadonlyMap<string, number>) {
  const k = dirKey(dir);
  sessionSizes.delete(k);
  sessionSizes.set(k, new Map(entries));
  if (sessionSizes.size > MAX_SESSION_SIZE_DIRS) {
    const oldest = sessionSizes.keys().next().value;
    if (oldest !== undefined) sessionSizes.delete(oldest);
  }
}

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
    /** Recursive subfolder sizes by lower-case name, once requested or cached. */
    const [dirSizes, setDirSizes] = createSignal<ReadonlyMap<string, number> | null>(null);
    /** Folders whose size is remembered from earlier and is being checked again. */
    const [staleSizes, setStaleSizes] = createSignal<ReadonlySet<string>>(new Set<string>());
    /** True when live folder-size calculation/watching is active for the current folder. */
    const [sizesLive, setSizesLive] = createSignal(false);
    const [treemap, setTreemap] = createSignal(false);
    const dirSizeMax = createMemo(() => {
      let max = 1;
      for (const v of dirSizes()?.values() ?? []) if (v > max) max = v;
      return max;
    });
    const [git, setGit] = createSignal<GitInfo | null>(null);
    const [commits, setCommits] = createSignal<Readonly<Record<string, CommitInfo>> | null>(null);
    const [viewMode, setViewMode] = createSignal<ViewMode>("details");
    /** Remembers this folder's view and sort, so it opens the same way next time. */
    const rememberFolderView = () => {
      if (search() || archive()) return;
      folderViews = rememberView(folderViews, path(), { mode: viewMode(), sort: sort() });
      saveJson(FOLDER_VIEWS_KEY, folderViews);
    };

    /** Refreshes Git badges for the folder (best effort, outside archives). */
    function loadGit(dir: string, gen: number) {
      setCommits(null);
      if (archive()) {
        setGit(null);
        return;
      }
      gitStatus(dir).then(
        (g) => gen === generation && setGit(g),
        () => gen === generation && setGit(null),
      );
      if (settings.showCommits()) {
        gitLastCommits(dir).then(
          (c) => gen === generation && setCommits(c),
          () => undefined,
        );
      }
    }

    // Fetch last-commit data immediately if the user toggles "Show last commit" while already inside a repository.
    createEffect(() => {
      if (!settings.showCommits()) return;
      const g = git();
      const dir = path();
      const gen = generation;
      if (!g || archive() || commits() !== null) return;
      gitLastCommits(dir).then(
        (c) => gen === generation && samePath(dir, path()) && setCommits(c),
        () => undefined,
      );
    });
    /** Folder-mode sort, restored when a search ends. */
    let folderSort: SortSpec = DEFAULT_SORT;

    const view = createMemo(() => {
      const v = buildView(listing(), { sort: sort(), showHidden: settings.showHidden(), filter: search() ? "" : filter(), dirSizes: search() ? null : dirSizes() });
      // Optionally leave out what Git ignores (build output, dependencies).
      const g = settings.hideGitIgnored() && !search() ? git() : null;
      if (!g) return v;
      const l = listing();
      return v.filter((e) => g.children[l.names[e].toLowerCase()] !== "I");
    });
    let generation = 0;
    let watchedPath: string | null = null;
    let sizesHidden = false;
    let freshSizeNames = new Set<string>();
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
        sizesHidden = false;
        freshSizeNames = new Set<string>();
        const cached = sessionSizes.get(dirKey(dir));
        batch(() => {
          setListing(emptyListing(dir));
          setSelection(new Set<number>());
          setFocus(0);
          setRenaming(null);
          setArchive(null);
          setDirSizes(cached ? new Map(cached) : null);
          setStaleSizes(new Set<string>());
          setSizesLive(false);
          setTreemap(false);
          // A folder opens the way it was last shown; others keep the tab's current view.
          const remembered = viewFor(folderViews, dir);
          if (remembered) {
            setViewMode(remembered.mode);
            setSort(remembered.sort);
            folderSort = remembered.sort;
          }
        });
        void folderSizes(id, "", () => undefined).catch(() => undefined);
        // Show synced/cached folder sizes right away without waiting for listDir to finish.
        void loadCachedSizes(dir, gen);
        if (settings.autoFolderSizes()) computeSizes();
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
          if (summary.archive) {
            setDirSizes(null);
            setStaleSizes(new Set<string>());
            setSizesLive(false);
            void folderSizes(id, "", () => undefined).catch(() => undefined);
          }
          if (!sameDir) setCommits(null);
          if (explicit?.length) selectNames(explicit, listing());
          else restoreByName(names, focusName);
        });
        visits.visit(dir);
        loadGit(dir, gen);
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

    /** Applies any backend-indexed or disk-cached subfolder sizes without triggering a scan. */
    async function loadCachedSizes(dir: string, gen: number) {
      const list = await cachedFolderSizes(dir).catch(() => []);
      if (gen !== generation || sizesHidden || !samePath(dir, path()) || archive() || search() || list.length === 0) return;
      batch(() => {
        const merged = new Map(dirSizes() ?? []);
        let changed = false;
        for (const s of list) {
          const name = s.name.toLowerCase();
          if (freshSizeNames.has(name)) continue;
          if (merged.get(name) !== s.bytes) {
            merged.set(name, s.bytes);
            changed = true;
          }
        }
        if (changed) {
          setDirSizes(merged);
          rememberSizes(dir, merged);
        }
        if (sizesLive()) {
          setStaleSizes((prev) => {
            let next: Set<string> | null = null;
            for (const s of list) {
              const name = s.name.toLowerCase();
              if (s.stale && !freshSizeNames.has(name) && !prev.has(name)) {
                next ??= new Set(prev);
                next.add(name);
              }
            }
            return next ?? prev;
          });
        }
      });
    }

    /** Computes the recursive size of every subfolder, updating in batches as each finishes. */
    function computeSizes() {
      if (archive() || search()) return;
      const dir = path();
      const gen = generation;
      sizesHidden = false;
      setSizesLive(true);
      // Keep the numbers on screen: the engine answers at once with what it remembers (marked stale),
      // then sends fresh values as each folder is checked and again whenever a file changes.
      setDirSizes((m) => m ?? new Map());
      const pendingSizes = new Map<string, number>();
      const pendingStale = new Map<string, boolean>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        clearTimeout(timer);
        timer = undefined;
        if (gen !== generation || sizesHidden || !samePath(dir, path()) || pendingSizes.size === 0) {
          pendingSizes.clear();
          pendingStale.clear();
          return;
        }
        const entries = [...pendingSizes];
        const staleEntries = [...pendingStale];
        pendingSizes.clear();
        pendingStale.clear();
        batch(() => {
          const next = new Map(dirSizes() ?? []);
          for (const [name, bytes] of entries) next.set(name, bytes);
          setDirSizes(next);
          rememberSizes(dir, next);
          setStaleSizes((prev) => {
            let nextStale: Set<string> | null = null;
            for (const [name, stale] of staleEntries) {
              if (prev.has(name) !== stale) {
                nextStale ??= new Set(prev);
                if (stale) nextStale.add(name);
                else nextStale.delete(name);
              }
            }
            return nextStale ?? prev;
          });
        });
      };
      void folderSizes(id, dir, (s) => {
        if (gen !== generation || sizesHidden || !samePath(dir, path())) return;
        const name = s.name.toLowerCase();
        if (!s.stale) freshSizeNames.add(name);
        pendingSizes.set(name, s.bytes);
        pendingStale.set(name, s.stale);
        if (!timer) timer = setTimeout(flush, 16);
      }).then(flush, flush);
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
      git,
      commits,
      viewMode,
      setViewMode: (mode: ViewMode) => {
        setViewMode(mode);
        rememberFolderView();
      },
      archive,
      dirSizes,
      dirSizeStale: (name: string) => staleSizes().has(name.toLowerCase()),
      dirSizeMax,
      sizesLive,
      treemap,
      setTreemap,
      computeSizes,
      clearSizes: () => {
        sizesHidden = true;
        setSizesLive(false);
        setDirSizes(null);
        setStaleSizes(new Set<string>());
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
      sortBy: (key: SortKey) => {
        setSort((s) => toggleSort(s, key));
        rememberFolderView();
      },
      selectedPaths: () => [...selection()].filter((i) => i < listing().count).map(pathOf),
      pathOf,
      title: () => baseName(path()) || path(),
    };
  });
}
