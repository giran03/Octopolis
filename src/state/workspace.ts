// Panes (each with tabs) arranged in a split layout tree.
import { batch, createRoot, createSignal, type Accessor } from "solid-js";
import { leaf, leaves, removePane, resizeSplit, splitPane, type Direction, type LayoutNode } from "../lib/layout";
import { createTab, type TabModel } from "./tab";

export interface PaneModel {
  readonly id: string;
  readonly tabs: Accessor<readonly TabModel[]>;
  readonly activeTabId: Accessor<string>;
  /** Undefined only before the workspace is initialised. */
  readonly activeTab: Accessor<TabModel | undefined>;
}

interface PaneState {
  tabs: readonly TabModel[];
  activeTabId: string;
}

let nextPaneId = 1;

export const workspace = createRoot(() => {
  const [panes, setPanes] = createSignal<ReadonlyMap<string, PaneState>>(new Map());
  const [layout, setLayout] = createSignal<LayoutNode>(leaf("none"));
  const [activePaneId, setActivePaneId] = createSignal("none");

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

  function newPane(path: string): string {
    const id = `pane-${nextPaneId++}`;
    const tab = createTab(path);
    setPanes((m) => new Map(m).set(id, { tabs: [tab], activeTabId: tab.id }));
    tab.navigate(path);
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

  function newTab(paneId = activePaneId(), path = activeTab()?.path() ?? "C:\\") {
    const tab = createTab(path);
    updatePane(paneId, (p) => ({ tabs: [...p.tabs, tab], activeTabId: tab.id }));
    tab.navigate(path);
    setActivePaneId(paneId);
  }

  function closeTab(paneId: string, tabId: string) {
    const p = state(paneId);
    if (!p) return;
    if (p.tabs.length === 1) return closePane(paneId);
    const at = p.tabs.findIndex((t) => t.id === tabId);
    const tab = p.tabs[at];
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
    init,
    newTab,
    closeTab,
    selectTab,
    cycleTab,
    split,
    closePane,
    cyclePane,
    focusPane: setActivePaneId,
    resize: (path: readonly number[], index: number, delta: number) => setLayout((t) => resizeSplit(t, path, index, delta)),
  };
});
