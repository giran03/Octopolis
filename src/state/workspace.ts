// Panes (each with tabs) arranged in a split layout tree.
import { batch, createRoot, createSignal, type Accessor } from "solid-js";
import { edgeSplit, leaf, leaves, removePane, resizeSplit, splitPane, type Direction, type Edge, type LayoutNode } from "../lib/layout";
import type { Preset, PresetPane } from "../lib/session";
import { isDir, indexOfName } from "../lib/listing";
import { baseName, parentPath, samePath } from "../lib/paths";
import { createTab, setNavigationListener, type TabModel } from "./tab";

export interface PaneModel {
  readonly id: string;
  readonly tabs: Accessor<readonly TabModel[]>;
  readonly activeTabId: Accessor<string>;
  /** Undefined only before the workspace is initialised. */
  readonly activeTab: Accessor<TabModel | undefined>;
}

export interface TabMeta {
  readonly pinned: boolean;
  readonly color: string | null;
}
const NO_META: TabMeta = { pinned: false, color: null };

interface PaneState {
  tabs: readonly TabModel[];
  activeTabId: string;
}

let nextPaneId = 1;

export const workspace = createRoot(() => {
  const [panes, setPanes] = createSignal<ReadonlyMap<string, PaneState>>(new Map());
  const [layout, setLayout] = createSignal<LayoutNode>(leaf("none"));
  const [activePaneId, setActivePaneId] = createSignal("none");
  /** Pinned state and color of each tab, by tab id. */
  const [tabMeta, setTabMeta] = createSignal<ReadonlyMap<string, TabMeta>>(new Map());
  const metaOf = (tabId: string): TabMeta => tabMeta().get(tabId) ?? NO_META;
  const setMeta = (tabId: string, patch: Partial<TabMeta>) => setTabMeta((m) => new Map(m).set(tabId, { ...metaOf(tabId), ...patch }));
  /** Pinned tabs first, keeping each group's order. */
  const pinnedFirst = (tabs: readonly TabModel[]) => [...tabs.filter((t) => metaOf(t.id).pinned), ...tabs.filter((t) => !metaOf(t.id).pinned)];

  const state = (paneId: string) => panes().get(paneId);
  const updatePane = (paneId: string, fn: (p: PaneState) => PaneState) =>
    setPanes((m) => {
      const cur = m.get(paneId);
      return cur ? new Map(m).set(paneId, fn(cur)) : m;
    });

  const paneModel = (paneId: string): PaneModel => ({
    id: paneId,
    tabs: () => state(paneId)?.tabs ?? [],
    activeTabId: () => state(paneId)?.activeTabId ?? "",
    activeTab: () => {
      const s = state(paneId);
      return s && (s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0]);
    },
  });

  function newPane(path: string, select?: readonly string[]): string {
    const id = `pane-${nextPaneId++}`;
    const tab = createTab(path);
    setPanes((m) => new Map(m).set(id, { tabs: [tab], activeTabId: tab.id }));
    tab.navigate(path, select);
    return id;
  }

  function init(path: string) {
    const id = newPane(path);
    batch(() => {
      setLayout(leaf(id));
      setActivePaneId(id);
    });
  }

  const activePane = () => paneModel(activePaneId());
  const activeTab = () => activePane().activeTab();

  /** Tabs just opened via `newTab`, cleared after their reveal animation finishes. */
  const [spawnedTabs, setSpawnedTabs] = createSignal<ReadonlyMap<string, "fg" | "bg">>(new Map());

  /** Opens a tab; a background tab goes right after the current one and doesn't take focus. */
  function newTab(paneId = activePaneId(), path = activeTab()?.path() ?? "C:\\", background = false) {
    const tab = createTab(path);
    setSpawnedTabs((prev) => new Map(prev).set(tab.id, background ? "bg" : "fg"));
    setTimeout(() => {
      setSpawnedTabs((prev) => {
        if (!prev.has(tab.id)) return prev;
        const next = new Map(prev);
        next.delete(tab.id);
        return next;
      });
    }, 950);
    updatePane(paneId, (p) => {
      if (!background) return { tabs: [...p.tabs, tab], activeTabId: tab.id };
      const at = p.tabs.findIndex((t) => t.id === p.activeTabId) + 1;
      return { ...p, tabs: [...p.tabs.slice(0, at), tab, ...p.tabs.slice(at)] };
    });
    tab.navigate(path);
    setActivePaneId(paneId);
  }

  /** Paths of recently closed tabs, newest last, for "Reopen closed tab". */
  const closedPaths: string[] = [];
  const MAX_CLOSED = 20;

  function reopenTab() {
    const path = closedPaths.pop();
    if (path) newTab(activePaneId(), path);
  }

  function closeTab(paneId: string, tabId: string) {
    const p = state(paneId);
    if (!p) return;
    if (p.tabs.length === 1) return closePane(paneId);
    const at = p.tabs.findIndex((t) => t.id === tabId);
    const tab = p.tabs[at];
    if (tab) closedPaths.push(tab.path());
    if (closedPaths.length > MAX_CLOSED) closedPaths.shift();
    const rest = p.tabs.filter((t) => t.id !== tabId);
    const nextActive = p.activeTabId === tabId ? rest[Math.min(at, rest.length - 1)].id : p.activeTabId;
    updatePane(paneId, () => ({ tabs: rest, activeTabId: nextActive }));
    tab?.close();
  }

  function selectTab(paneId: string, tabId: string) {
    updatePane(paneId, (p) => ({ ...p, activeTabId: tabId }));
    setActivePaneId(paneId);
  }

  function cycleTab(step: 1 | -1) {
    const p = state(activePaneId());
    if (!p || p.tabs.length < 2) return;
    const at = p.tabs.findIndex((t) => t.id === p.activeTabId);
    const next = p.tabs[(at + step + p.tabs.length) % p.tabs.length];
    selectTab(activePaneId(), next.id);
  }

  function split(dir: Direction, paneId = activePaneId()) {
    const path = paneModel(paneId).activeTab()?.path() ?? "C:\\";
    const id = newPane(path);
    batch(() => {
      setLayout((t) => splitPane(t, paneId, id, dir));
      setActivePaneId(id);
    });
  }

  /** What a drop on a pane's edge puts into the new pane. */
  type SplitContent =
    | { readonly kind: "tab"; readonly fromPane: string; readonly tabId: string }
    | { readonly kind: "folders"; readonly paths: readonly string[] }
    | { readonly kind: "files"; readonly folder: string; readonly names: readonly string[] };

  /** Beyond this many panes each one gets too small to use. */
  const MAX_PANES = 6;
  const canSplit = () => leaves(layout()).length < MAX_PANES;

  /**
   * Splits `target` along one of its edges and fills the new pane: a dragged tab moves into it, dragged folders
   * open in it, and dragged files open their folder with those files selected. Returns false when nothing was done.
   */
  function splitAt(target: string, edge: Edge, content: SplitContent): boolean {
    if (!state(target) || !canSplit()) return false;
    const { dir, before } = edgeSplit(edge);
    if (content.kind === "tab") {
      const from = state(content.fromPane);
      const tab = from?.tabs.find((t) => t.id === content.tabId);
      // A pane's only tab can't leave it to make a split of itself.
      if (!from || !tab || (content.fromPane === target && from.tabs.length < 2)) return false;
      const id = `pane-${nextPaneId++}`;
      batch(() => {
        const rest = from.tabs.filter((t) => t.id !== content.tabId);
        let next = layout();
        if (rest.length) {
          updatePane(content.fromPane, (p) => ({ tabs: rest, activeTabId: p.activeTabId === tab.id ? rest[0].id : p.activeTabId }));
        } else {
          next = removePane(next, content.fromPane) ?? next;
          setPanes((m) => {
            const copy = new Map(m);
            copy.delete(content.fromPane);
            return copy;
          });
        }
        setPanes((m) => new Map(m).set(id, { tabs: [tab], activeTabId: tab.id }));
        setLayout(splitPane(next, target, id, dir, before));
        setActivePaneId(id);
      });
      return true;
    }
    const first = content.kind === "folders" ? content.paths[0] : content.folder;
    if (!first) return false;
    const id = newPane(first, content.kind === "files" ? content.names : undefined);
    if (content.kind === "folders") for (const extra of content.paths.slice(1)) newTab(id, extra, true);
    batch(() => {
      setLayout((t) => splitPane(t, target, id, dir, before));
      setActivePaneId(id);
    });
    return true;
  }

  function closePane(paneId: string) {
    const next = removePane(layout(), paneId);
    if (!next) return; // never close the last pane
    const p = state(paneId);
    batch(() => {
      setLayout(next);
      setPanes((m) => {
        const copy = new Map(m);
        copy.delete(paneId);
        return copy;
      });
      if (activePaneId() === paneId) setActivePaneId(leaves(next)[0]);
    });
    p?.tabs.forEach((t) => t.close());
  }

  function cyclePane(step: 1 | -1) {
    const ids = leaves(layout());
    const at = ids.indexOf(activePaneId());
    setActivePaneId(ids[(at + step + ids.length) % ids.length]);
  }

  /** Swaps what the active pane and the next pane show (all tabs); focus follows the content. */
  function swapPanes() {
    const ids = leaves(layout());
    if (ids.length < 2) return;
    const a = activePaneId();
    const b = ids[(ids.indexOf(a) + 1) % ids.length];
    const sa = state(a);
    const sb = state(b);
    if (!sa || !sb || a === b) return;
    batch(() => {
      setPanes((m) => new Map(m).set(a, sb).set(b, sa));
      setActivePaneId(b);
    });
  }

  /** Synchronized browsing: going into a subfolder or up in the active pane does the same in the others. */
  const [synced, setSynced] = createSignal(false);
  let syncing = false;
  setNavigationListener((tab, from, to) => {
    if (!synced() || syncing || tab !== activeTab()) return;
    const goingDown = !!parentPath(to) && samePath(parentPath(to)!, from);
    const goingUp = !!parentPath(from) && samePath(parentPath(from)!, to);
    if (!goingDown && !goingUp) return;
    syncing = true;
    try {
      for (const id of leaves(layout())) {
        const other = id === activePaneId() ? undefined : paneModel(id).activeTab();
        if (!other || other === tab) continue;
        if (goingUp) other.up();
        else {
          const l = other.listing();
          const at = indexOfName(l, baseName(to));
          if (at >= 0 && isDir(l, at)) void other.navigate(other.pathOf(at));
        }
      }
    } finally {
      syncing = false;
    }
  });

  /** Moves a tab within a pane or to another pane, closing a pane it empties. */
  function moveTab(fromPane: string, tabId: string, toPane: string, index: number) {
    const from = state(fromPane);
    const tab = from?.tabs.find((t) => t.id === tabId);
    if (!from || !tab || !state(toPane)) return;
    batch(() => {
      const rest = from.tabs.filter((t) => t.id !== tabId);
      const fromIdx = from.tabs.indexOf(tab);
      const target = fromPane === toPane ? rest : state(toPane)!.tabs;
      const at = Math.min(fromPane === toPane && fromIdx < index ? index - 1 : index, target.length);
      const inserted = [...target.slice(0, at), tab, ...target.slice(at)];
      updatePane(toPane, () => ({ tabs: inserted, activeTabId: tab.id }));
      if (fromPane !== toPane) {
        if (rest.length) updatePane(fromPane, (p) => ({ tabs: rest, activeTabId: p.activeTabId === tabId ? rest[0].id : p.activeTabId }));
        else {
          const next = removePane(layout(), fromPane);
          if (next) {
            setLayout(next);
            setPanes((m) => {
              const copy = new Map(m);
              copy.delete(fromPane);
              return copy;
            });
          }
        }
      }
      setActivePaneId(toPane);
    });
  }

  function snapshotLayout(): Preset {
    const out: Record<string, PresetPane> = {};
    for (const [id, p] of panes()) {
      out[id] = {
        tabs: p.tabs.map((t) => t.path()),
        active: Math.max(0, p.tabs.findIndex((t) => t.id === p.activeTabId)),
        pinned: p.tabs.map((t) => metaOf(t.id).pinned),
        colors: p.tabs.map((t) => metaOf(t.id).color),
      };
    }
    return { layout: layout(), panes: out };
  }

  function togglePin(paneId: string, tabId: string) {
    setMeta(tabId, { pinned: !metaOf(tabId).pinned });
    updatePane(paneId, (p) => ({ ...p, tabs: pinnedFirst(p.tabs) }));
  }

  /** Closes every tab in the pane except `tabId` and pinned tabs. */
  function closeOthers(paneId: string, tabId: string) {
    const p = state(paneId);
    if (!p) return;
    for (const t of p.tabs) if (t.id !== tabId && !metaOf(t.id).pinned) closeTab(paneId, t.id);
  }

  /** Closes every unpinned tab to the right of `tabId` in the pane. */
  function closeToRight(paneId: string, tabId: string) {
    const p = state(paneId);
    if (!p) return;
    const at = p.tabs.findIndex((t) => t.id === tabId);
    if (at < 0) return;
    for (const t of p.tabs.slice(at + 1)) if (!metaOf(t.id).pinned) closeTab(paneId, t.id);
  }

  /** Replaces every pane with the preset's. False (and nothing changes) if the preset is unusable. */
  function restoreLayout(preset: Preset): boolean {
    const old = allTabs();
    const ids = new Map<string, string>();
    const fresh = new Map<string, PaneState>();
    for (const [id, p] of Object.entries(preset.panes)) {
      if (p.tabs.length === 0) continue;
      const nid = `pane-${nextPaneId++}`;
      ids.set(id, nid);
      const tabs = p.tabs.map((path) => createTab(path));
      tabs.forEach((t, i) => setMeta(t.id, { pinned: p.pinned?.[i] ?? false, color: p.colors?.[i] ?? null }));
      fresh.set(nid, { tabs: pinnedFirst(tabs), activeTabId: tabs[Math.min(p.active, tabs.length - 1)].id });
    }
    const remap = (n: LayoutNode): LayoutNode =>
      n.kind === "leaf" ? leaf(ids.get(n.paneId) ?? n.paneId) : { ...n, children: n.children.map(remap) };
    const next = remap(preset.layout);
    if (leaves(next).some((id) => !fresh.has(id))) {
      for (const p of fresh.values()) p.tabs.forEach((t) => t.close());
      return false;
    }
    batch(() => {
      setPanes(fresh);
      setLayout(next);
      setActivePaneId(leaves(next)[0]);
    });
    old.forEach((t) => t.close());
    for (const p of fresh.values()) p.tabs.forEach((t) => void t.navigate(t.path()));
    return true;
  }

  /** All tabs in every pane, for refreshing folders touched by an operation. */
  const allTabs = () => [...panes().values()].flatMap((p) => p.tabs);

  return {
    layout,
    activePaneId,
    activePane,
    activeTab,
    paneModel,
    allTabs,
    paneCount: () => leaves(layout()).length,
    /** Ids of the panes, in layout order. */
    paneIds: () => leaves(layout()),
    init,
    newTab,
    closeTab,
    reopenTab,
    moveTab,
    snapshotLayout,
    restoreLayout,
    tabMeta: metaOf,
    tabSpawnKind: (tabId: string) => spawnedTabs().get(tabId),
    togglePin,
    setTabColor: (tabId: string, color: string | null) => setMeta(tabId, { color }),
    closeOthers,
    closeToRight,
    selectTab,
    cycleTab,
    split,
    closePane,
    cyclePane,
    swapPanes,
    splitAt,
    canSplit,
    synced,
    toggleSynced: () => setSynced((s) => !s),
    focusPane: setActivePaneId,
    resize: (path: readonly number[], index: number, delta: number) => setLayout((t) => resizeSplit(t, path, index, delta)),
  };
});
