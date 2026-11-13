// One pane: tab strip, navigation toolbar with path bar and filter, file list.
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { Edge } from "../lib/layout";
import * as A from "../actions";
import { errorText, listDir, resolvePath } from "../lib/ipc";
import { fuzzyRank } from "../lib/fuzzy";
import { createBuilder, decodeBatch, isDir, snapshot } from "../lib/listing";
import { baseName, breadcrumbs, joinPath, parentPath, samePath, sameVolume } from "../lib/paths";
import { cancelSpring, carriesPaths, dragState, isDragging, onDragReset, springLoad, springTarget, tabDrag } from "../state/drag";
import { history } from "../state/history";
import type { TabModel } from "../state/tab";
import { TAB_COLORS } from "../lib/session";
import { ui } from "../state/ui";
import { workspace, type PaneModel } from "../state/workspace";
import { contextMenu, FileList, type ListHandle } from "./FileList";
import { MillerView } from "./Extras";
import { BentoView, CellGrid, ContentView, ListView } from "./Views";
import { ViewMenu } from "./ViewMenu";
import { Treemap } from "./Treemap";
import { IconBack, MaterialIcon, IconChevron, IconClose, IconForward, IconLayers, IconPlus, IconRefresh, IconSearch, IconUp } from "./Icons";

const TAB_MIME = "application/x-octopolis-tab";
const SUGGEST_DEBOUNCE_MS = 90;
const MAX_SUGGESTIONS = 12;

/** Lists the subfolders of `dir`, for path bar suggestions and crumb menus. */
export async function subfolders(dir: string): Promise<string[]> {
  const b = createBuilder(dir);
  await listDir(dir, (buf) => decodeBatch(buf, b));
  const l = snapshot(b);
  return l.names.filter((_, i) => isDir(l, i)).sort((x, y) => x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" }));
}

/** List handles per tab, used by keyboard navigation to scroll and page. */
export const listHandles = new WeakMap<TabModel, ListHandle>();

export function Pane(props: { pane: PaneModel }) {
  const active = () => workspace.activePaneId() === props.pane.id;
  const tab = () => props.pane.activeTab();
  let host!: HTMLElement;
  return (
    <section ref={host} class="pane" classList={{ active: active() }} onMouseDown={() => workspace.focusPane(props.pane.id)}>
      <TabStrip pane={props.pane} />
      <EdgeZones paneId={props.pane.id} host={() => host} />
      <Show when={tab()} keyed>
        {(t) => (
          <>
            <Toolbar paneId={props.pane.id} tab={t} />
            <Show when={!t.treemap()} fallback={<Treemap tab={t} />}>
              <Show when={t.viewMode() === "details"}>
                <FileList tab={t} active={active()} onReady={(h) => listHandles.set(t, h)} />
              </Show>
              <Show when={t.viewMode() === "grid" || t.viewMode() === "tiles"}>
                <CellGrid
                  tab={t}
                  active={active()}
                  variant={t.viewMode() === "tiles" ? "tiles" : "icons"}
                  onReady={(columns, ensureVisible, pageRows) => listHandles.set(t, { columns, ensureVisible, pageRows })}
                  onMenu={(e, pos) => contextMenu(t, e, pos)}
                />
              </Show>
              <Show when={t.viewMode() === "list"}>
                <ListView
                  tab={t}
                  active={active()}
                  onReady={(columns, ensureVisible, pageRows) => listHandles.set(t, { columns, ensureVisible, pageRows })}
                  onMenu={(e, pos) => contextMenu(t, e, pos)}
                />
              </Show>
              <Show when={t.viewMode() === "bento"}>
                <BentoView
                  tab={t}
                  active={active()}
                  onReady={(columns, ensureVisible, pageRows, vertical) => listHandles.set(t, { columns, ensureVisible, pageRows, vertical })}
                  onMenu={(e, pos) => contextMenu(t, e, pos)}
                />
              </Show>
              <Show when={t.viewMode() === "content"}>
                <ContentView
                  tab={t}
                  active={active()}
                  onReady={(columns, ensureVisible, pageRows) => listHandles.set(t, { columns, ensureVisible, pageRows })}
                  onMenu={(e, pos) => contextMenu(t, e, pos)}
                />
              </Show>
              <Show when={t.viewMode() === "columns"}>
                <MillerView
                  tab={t}
                  active={active()}
                  onReady={(pageRows, ensureVisible) => listHandles.set(t, { pageRows, ensureVisible })}
                  onMenu={(e, pos) => contextMenu(t, e, pos)}
                />
              </Show>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}

type SplitContent = Parameters<typeof workspace.splitAt>[2];
const EDGES: readonly Edge[] = ["left", "right", "top", "bottom"];

/** What the current drag would put in a new pane, with a label for the preview; null when it can't open one. */
function splitPayload(paneId: string, e: DragEvent): { content: SplitContent; label: string } | null {
  const types = e.dataTransfer?.types ?? [];
  if (types.includes(TAB_MIME) && tabDrag.current) {
    const t = tabDrag.current;
    // A pane's only tab can't leave to split its own pane.
    if (t.pane === paneId && workspace.paneModel(t.pane).tabs().length < 2) return null;
    return { content: { kind: "tab", fromPane: t.pane, tabId: t.tab }, label: t.title };
  }
  if (carriesPaths(e.dataTransfer) && dragState.paths.length > 0 && !dragState.archive) {
    if (dragState.allDirs && dragState.dirs.length > 0) {
      const n = dragState.dirs.length;
      return { content: { kind: "folders", paths: dragState.dirs }, label: n > 1 ? `${n} folders` : baseName(dragState.dirs[0]) || dragState.dirs[0] };
    }
    const folder = parentPath(dragState.paths[0]);
    if (!folder) return null;
    const n = dragState.paths.length;
    return { content: { kind: "files", folder, names: dragState.paths.map((p) => baseName(p)) }, label: `${baseName(folder) || folder} · ${n} item${n === 1 ? "" : "s"} selected` };
  }
  return null;
}

/**
 * While something is being dragged, a thin zone along each edge of the pane. Hovering one shows a skeleton of the
 * pane it would create (half of this one, on that side); dropping splits the pane. Repeating it makes a grid.
 */
function EdgeZones(props: { paneId: string; host: () => HTMLElement | undefined }) {
  const [over, setOver] = createSignal<{ edge: Edge; label: string } | null>(null);
  const [top, setTop] = createSignal(0);
  createEffect(() => {
    if (isDragging()) {
      // The top zone starts below the tab strip and toolbar, so tab and breadcrumb drops keep working.
      const host = props.host();
      const bar = host?.querySelector(".toolbar");
      if (host && bar) setTop(bar.getBoundingClientRect().bottom - host.getBoundingClientRect().top);
    } else setOver(null);
  });
  const enter = (e: DragEvent, edge: Edge) => {
    const p = splitPayload(props.paneId, e);
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer!.dropEffect = p.content.kind === "tab" ? "move" : "copy";
    if (over()?.edge !== edge || over()?.label !== p.label) setOver({ edge, label: p.label });
  };
  return (
    <Show when={isDragging() && workspace.canSplit()}>
      <div class="edge-zones" style={{ "--edge-top": `${top()}px` }} aria-hidden="true">
        <For each={EDGES}>
          {(edge) => (
            <div
              class={`edge-zone edge-${edge}`}
              classList={{ hot: over()?.edge === edge }}
              onDragEnter={(e) => enter(e, edge)}
              onDragOver={(e) => enter(e, edge)}
              onDragLeave={(e) => {
                if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setOver(null);
              }}
              onDrop={(e) => {
                const p = splitPayload(props.paneId, e);
                if (!p) return;
                e.preventDefault();
                e.stopPropagation();
                setOver(null);
                workspace.splitAt(props.paneId, edge, p.content);
              }}
            />
          )}
        </For>
        <Show when={over()}>{(o) => <EdgeSkeleton edge={o().edge} label={o().label} />}</Show>
      </div>
    </Show>
  );
}

/** A faint outline of the new pane: its tab, toolbar and rows as placeholders, on the side it would open. */
function EdgeSkeleton(props: { edge: Edge; label: string }) {
  const vertical = () => props.edge === "left" || props.edge === "right";
  return (
    <div class={`edge-skeleton edge-skeleton-${props.edge}`}>
      <div class="es-tabs"><span class="es-tab" /></div>
      <div class="es-bar"><span /><span /><span /></div>
      <div class="es-rows">
        <For each={[72, 48, 64, 38, 58, 44, 52]}>{(w) => <span class="es-row" style={{ "--w": `${w}%` }} />}</For>
      </div>
      <div class="es-label">
        <MaterialIcon name={vertical() ? "vertical_split" : "horizontal_split"} size={30} />
        <span>Open in a new pane</span>
        <strong>{props.label}</strong>
      </div>
    </div>
  );
}

/** A ghost tab showing where a dropped folder will open. */
const COLOR_LABELS: Record<(typeof TAB_COLORS)[number], string> = { red: "Red", orange: "Orange", yellow: "Yellow", green: "Green", blue: "Blue", purple: "Purple" };

/** Right-click a tab: pin, color, duplicate, close others, close to right. */
function tabMenu(e: MouseEvent, paneId: string, tabId: string) {
  e.preventDefault();
  e.stopPropagation();
  const meta = workspace.tabMeta(tabId);
  const tabs = workspace.paneModel(paneId).tabs();
  const at = tabs.findIndex((t) => t.id === tabId);
  const tab = at >= 0 ? tabs[at] : undefined;
  const hasToRight = at >= 0 && tabs.slice(at + 1).some((t) => !workspace.tabMeta(t.id).pinned);
  ui.openMenu(e.clientX, e.clientY, [
    { label: meta.pinned ? "Unpin tab" : "Pin tab", run: () => workspace.togglePin(paneId, tabId) },
    { label: "Duplicate tab", run: () => tab && workspace.newTab(paneId, tab.path()) },
    ...(workspace.canSplit() && tabs.length > 1
      ? [
          { label: "Move to a new pane on the right", run: () => void workspace.splitAt(paneId, "right", { kind: "tab", fromPane: paneId, tabId }) },
          { label: "Move to a new pane below", run: () => void workspace.splitAt(paneId, "bottom", { kind: "tab", fromPane: paneId, tabId }) },
        ]
      : []),
    "separator",
    ...TAB_COLORS.map((c) => ({ label: `${meta.color === c ? "✓ " : "    "}${COLOR_LABELS[c]}`, run: () => workspace.setTabColor(tabId, meta.color === c ? null : c) })),
    ...(meta.color ? [{ label: "    No color", run: () => workspace.setTabColor(tabId, null) }] : []),
    "separator",
    { label: "Close other tabs", run: () => workspace.closeOthers(paneId, tabId) },
    { label: "Close tabs to the right", disabled: !hasToRight, run: () => workspace.closeToRight(paneId, tabId) },
    { label: "Close tab", shortcut: "Ctrl+W", run: () => workspace.closeTab(paneId, tabId) },
  ]);
}

function TabSkeleton(props: { label: string; onOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void }) {
  return (
    <div class="tab tab-skeleton" aria-hidden="true" onDragOver={props.onOver} onDrop={props.onDrop}>
      <span class="tab-title">{props.label}</span>
    </div>
  );
}

function TabStrip(props: { pane: PaneModel }) {
  // Folders dragged from a list or the sidebar open in new tabs when dropped here.
  // `slot` is the index a new tab would take, or null when nothing droppable is over the strip.
  const [slot, setSlot] = createSignal<number | null>(null);
  const folderDrag = (e: DragEvent) => !!e.dataTransfer && !e.dataTransfer.types.includes(TAB_MIME) && dragState.dirs.length > 0;
  const overFolders = (e: DragEvent, index: number) => {
    if (!folderDrag(e)) return false;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer!.dropEffect = "copy";
    setSlot(index);
    return true;
  };
  const overTab = (e: DragEvent, i: number) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return overFolders(e, e.clientX < r.left + r.width / 2 ? i : i + 1);
  };
  const skeletonLabel = () => (dragState.dirs.length > 1 ? `${dragState.dirs.length} folders` : baseName(dragState.dirs[0] ?? "") || dragState.dirs[0] || "");
  const dropFolders = (e: DragEvent, index: number) => {
    if (!folderDrag(e)) return false;
    e.preventDefault();
    e.stopPropagation();
    setSlot(null);
    [...dragState.dirs].forEach((dir, n) => {
      workspace.newTab(props.pane.id, dir);
      workspace.moveTab(props.pane.id, props.pane.activeTabId(), props.pane.id, index + n);
    });
    return true;
  };
  return (
    <div
      class="tabstrip"
      role="tablist"
      onDragLeave={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom) setSlot(null);
      }}
      onDblClick={(e) => e.target === e.currentTarget && workspace.newTab(props.pane.id)}
      onDragOver={(e) => {
        if (overFolders(e, props.pane.tabs().length)) return;
        if (e.dataTransfer?.types.includes(TAB_MIME)) e.preventDefault();
      }}
      onDrop={(e) => {
        if (dropFolders(e, slot() ?? props.pane.tabs().length)) return;
        const raw = e.dataTransfer?.getData(TAB_MIME);
        if (!raw) return;
        e.preventDefault();
        const { pane, tab } = JSON.parse(raw) as { pane: string; tab: string };
        workspace.moveTab(pane, tab, props.pane.id, props.pane.tabs().length);
      }}
    >
      <For each={props.pane.tabs()}>
        {(t, i) => (
          <>
          <Show when={slot() === i()}>
            <TabSkeleton label={skeletonLabel()} onOver={(e) => overFolders(e, i())} onDrop={(e) => dropFolders(e, i())} />
          </Show>
          <div
            class="tab"
            role="tab"
            draggable={true}
            onDragStart={(e) => {
              e.dataTransfer!.setData(TAB_MIME, JSON.stringify({ pane: props.pane.id, tab: t.id }));
              e.dataTransfer!.effectAllowed = "move";
              tabDrag.current = { pane: props.pane.id, tab: t.id, title: t.title() };
            }}
            onDragEnd={() => (tabDrag.current = null)}
            onDragOver={(e) => {
              // Resting a file drag on a tab switches to it, so the drop can land in that folder.
              if (carriesPaths(e.dataTransfer) && props.pane.activeTabId() !== t.id) springLoad(`tab:${t.id}`, () => workspace.selectTab(props.pane.id, t.id));
              if (overTab(e, props.pane.tabs().indexOf(t))) return;
              if (e.dataTransfer?.types.includes(TAB_MIME)) e.preventDefault();
            }}
            onDragLeave={() => cancelSpring()}
            onDrop={(e) => {
              if (dropFolders(e, slot() ?? props.pane.tabs().indexOf(t) + 1)) return;
              const raw = e.dataTransfer?.getData(TAB_MIME);
              if (!raw) return;
              e.preventDefault();
              e.stopPropagation();
              const { pane, tab } = JSON.parse(raw) as { pane: string; tab: string };
              workspace.moveTab(pane, tab, props.pane.id, props.pane.tabs().indexOf(t));
            }}
            aria-selected={props.pane.activeTabId() === t.id}
            classList={{ spring: springTarget() === `tab:${t.id}`, current: props.pane.activeTabId() === t.id, pinned: workspace.tabMeta(t.id).pinned, colored: !!workspace.tabMeta(t.id).color }}
            style={workspace.tabMeta(t.id).color ? { "--tab-color": `var(--tab-${workspace.tabMeta(t.id).color})` } : undefined}
            data-tooltip={workspace.tabMeta(t.id).pinned ? `${t.title()} — ${t.path()}` : t.path()}
            onContextMenu={(e) => tabMenu(e, props.pane.id, t.id)}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
              else workspace.selectTab(props.pane.id, t.id);
            }}
            onAuxClick={(e) => e.button === 1 && workspace.closeTab(props.pane.id, t.id)}
          >
            <span class="tab-title">{t.title()}</span>
            <Show when={!workspace.tabMeta(t.id).pinned}>
            <button
              class="tab-close"
              aria-label="Close tab"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => workspace.closeTab(props.pane.id, t.id)}
            >
              <IconClose size={12} />
            </button>
            </Show>
          </div>
          </>
        )}
      </For>
      <Show when={slot() === props.pane.tabs().length}>
        <TabSkeleton label={skeletonLabel()} onOver={(e) => overFolders(e, props.pane.tabs().length)} onDrop={(e) => dropFolders(e, props.pane.tabs().length)} />
      </Show>
      <button class="icon-btn tab-new" title="New tab (Ctrl+T)" onClick={() => workspace.newTab(props.pane.id)}>
        <IconPlus size={14} />
      </button>
    </div>
  );
}

function Toolbar(props: { paneId: string; tab: TabModel }) {
  let filterInput!: HTMLInputElement;
  const [editing, setEditing] = createSignal(false);

  createEffect(on(ui.focusRequest, (req) => {
    if (!req || req.paneId !== props.paneId) return;
    if (req.target === "path") setEditing(true);
    else filterInput.focus();
  }, { defer: true }));

  return (
    <div class="toolbar">
      <button class="icon-btn" title="Back (Alt+Left). Right-click for the list" disabled={!props.tab.canBack()} onClick={props.tab.back} onContextMenu={(e) => historyMenu(e, props.tab, -1)}>
        <IconBack />
      </button>
      <button class="icon-btn" title="Forward (Alt+Right). Right-click for the list" disabled={!props.tab.canForward()} onClick={props.tab.forward} onContextMenu={(e) => historyMenu(e, props.tab, 1)}>
        <IconForward />
      </button>
      <button class="icon-btn" title="Up (Alt+Up)" onClick={props.tab.up}>
        <IconUp />
      </button>
      <button class="icon-btn" classList={{ spinning: props.tab.status().loading }} title="Refresh (F5)" onClick={() => void props.tab.refresh()}>
        <IconRefresh />
      </button>
      <PathBar tab={props.tab} editing={editing()} setEditing={setEditing} />
      <ViewMenu tab={props.tab} />
      <SearchBox tab={props.tab} ref={(el) => (filterInput = el)} />
    </div>
  );
}

/** Right-click on Back or Forward: the folders on that side of the history, nearest first. */
function historyMenu(e: MouseEvent, tab: TabModel, dir: -1 | 1) {
  e.preventDefault();
  const list = tab.historyList(dir);
  if (list.length === 0) return;
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  ui.openMenu(r.left, r.bottom + 4, list.map((h) => ({ label: baseName(h.path) || h.path, run: () => tab.goBy(h.offset) })));
}

const SEARCH_DEBOUNCE_MS = 150;

/** Filters this folder, or (scope "subfolders") searches the whole tree below it. */
function SearchBox(props: { tab: TabModel; ref: (el: HTMLInputElement) => void }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deep = () => props.tab.search() !== null;
  const value = () => (deep() ? props.tab.search()!.query : props.tab.filter());
  const onInput = (v: string) => {
    if (!deep()) return props.tab.setFilter(v);
    clearTimeout(timer);
    timer = setTimeout(() => void props.tab.runSearch(v), SEARCH_DEBOUNCE_MS);
  };
  const toggleScope = () => {
    if (deep()) props.tab.exitSearch();
    else {
      const q = props.tab.filter();
      props.tab.setFilter("");
      void props.tab.runSearch(q);
    }
  };
  return (
    <div class="search" classList={{ deep: deep(), invalid: !!props.tab.search()?.error }}>
      <button
        class="scope-btn"
        title={deep() ? "Searching subfolders — click to filter this folder only" : "Filtering this folder — click to search subfolders (Ctrl+Shift+F)"}
        onClick={toggleScope}
      >
        {deep() ? <IconLayers size={14} /> : <IconSearch size={14} />}
      </button>
      <input
        ref={props.ref}
        placeholder={deep() ? "Search subfolders  ext: size: dm: re: content:" : "Filter"}
        value={value()}
        spellcheck={false}
        onInput={(e) => onInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            if (deep()) props.tab.exitSearch();
            else props.tab.setFilter("");
            e.currentTarget.blur();
          }
          if (e.key === "Enter" || e.key === "ArrowDown") e.currentTarget.blur();
        }}
      />
      <Show when={props.tab.search()?.error}>{(err) => <span class="search-error" role="alert">{err()}</span>}</Show>
    </div>
  );
}


function PathBar(props: { tab: TabModel; editing: boolean; setEditing: (v: boolean) => void }) {
  let input: HTMLInputElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const [suggestions, setSuggestions] = createSignal<readonly string[]>([]);
  const [hot, setHot] = createSignal(-1);
  const [dropCrumb, setDropCrumb] = createSignal<string | null>(null);
  let suggestToken = 0;
  onCleanup(onDragReset(() => setDropCrumb(null)));

  const endSuggestions = () => {
    suggestToken++;
    clearTimeout(timer);
    setSuggestions([]);
    setHot(-1);
  };

  /** Offers subfolders of the typed parent, then frequent folders that match. */
  function suggest(text: string) {
    clearTimeout(timer);
    const mine = ++suggestToken;
    timer = setTimeout(async () => {
      const value = text.replace(/\//g, "\\");
      const at = value.lastIndexOf("\\");
      const parent = at >= 0 ? (at === 2 ? value.slice(0, 3) : value.slice(0, at)) : "";
      const partial = at >= 0 ? value.slice(at + 1) : value;
      let names: string[] = [];
      if (parent) names = await subfolders(parent).catch(() => []);
      if (mine !== suggestToken) return; // a newer keystroke took over
      const local = fuzzyRank(partial, names, (n) => n).map((r) => joinPath(parent, r.item));
      const frequent = fuzzyRank(value, history.top(100).map((v) => v.path), (p) => p).map((r) => r.item);
      setSuggestions([...new Set([...local, ...frequent])].slice(0, MAX_SUGGESTIONS));
      setHot(-1);
    }, SUGGEST_DEBOUNCE_MS);
  }

  async function showSiblings(dir: string, e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const names = await subfolders(dir).catch(() => []);
    if (names.length === 0) return ui.toast("No folders here");
    ui.openMenu(rect.left, rect.bottom + 4, names.slice(0, 200).map((n) => ({ label: n, run: () => void props.tab.navigate(joinPath(dir, n)) })));
  }

  const submit = async (value: string) => {
    try {
      const r = await resolvePath(value);
      endSuggestions();
      props.setEditing(false);
      await props.tab.navigate(r.dir, r.select ? [r.select] : undefined);
    } catch (e) {
      ui.toast(errorText(e));
      input?.select();
    }
  };

  return (
    <div class="pathbar" onClick={(e) => e.target === e.currentTarget && props.setEditing(true)}>
      <Show
        when={props.editing}
        fallback={
          <div class="crumbs" onClick={(e) => e.target === e.currentTarget && props.setEditing(true)}>
            <span class="crumbs-inner">
            <For each={breadcrumbs(props.tab.path())}>
              {(c, i) => (
                <>
                  <Show when={i() > 0}>
                    <button class="crumb-sep" aria-label={`Folders in ${breadcrumbs(props.tab.path())[i() - 1].label}`} onClick={(e) => showSiblings(breadcrumbs(props.tab.path())[i() - 1].path, e)}>
                      <IconChevron size={12} />
                    </button>
                  </Show>
                  <button
                    class="crumb"
                    classList={{ spring: springTarget() === `crumb:${c.path}`, "drop-over": dropCrumb() === c.path }}
                    onClick={(e) => (e.ctrlKey ? A.openInNewTab(c.path, !e.shiftKey) : void props.tab.navigate(c.path))}
                    onMouseDown={(e) => {
                      if (e.button !== 1) return;
                      e.preventDefault();
                      A.openInNewTab(c.path, !e.shiftKey);
                    }}
                    onDragOver={(e) => {
                      if (!carriesPaths(e.dataTransfer) || dragState.paths.some((p) => samePath(p, c.path))) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = e.ctrlKey || dragState.paths.some((p) => !sameVolume(p, c.path)) ? "copy" : "move";
                      setDropCrumb(c.path);
                      if (!samePath(c.path, props.tab.path())) springLoad(`crumb:${c.path}`, () => void props.tab.navigate(c.path));
                    }}
                    onDragLeave={(e) => {
                      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDropCrumb((cur) => (cur === c.path ? null : cur));
                      cancelSpring();
                    }}
                    onDrop={(e) => {
                      setDropCrumb(null);
                      if (!carriesPaths(e.dataTransfer)) return;
                      e.preventDefault();
                      e.stopPropagation();
                      cancelSpring();
                      A.dropPaths(dragState.paths, c.path, e.ctrlKey, dragState.archive, !!props.tab.archive() && samePath(c.path, props.tab.path()));
                    }}
                  >
                    {c.label}
                  </button>
                </>
              )}
            </For>
            </span>
          </div>
        }
      >
        <input
          ref={(el) => {
            input = el;
            queueMicrotask(() => {
              el.focus();
              el.select();
            });
          }}
          class="path-input"
          value={props.tab.path()}
          spellcheck={false}
          onInput={(e) => suggest(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            const list = suggestions();
            if (e.key === "ArrowDown" && list.length) {
              e.preventDefault();
              setHot((h) => Math.min(h + 1, list.length - 1));
            } else if (e.key === "ArrowUp" && list.length) {
              e.preventDefault();
              setHot((h) => Math.max(h - 1, -1));
            } else if (e.key === "Tab" && list.length) {
              e.preventDefault();
              const pick = list[Math.max(hot(), 0)];
              e.currentTarget.value = pick.endsWith("\\") ? pick : `${pick}\\`;
              suggest(e.currentTarget.value);
            } else if (e.key === "Enter") void submit(hot() >= 0 ? list[hot()] : e.currentTarget.value);
            else if (e.key === "Escape") {
              endSuggestions();
              props.setEditing(false);
            }
          }}
          onBlur={() => {
            endSuggestions();
            props.setEditing(false);
          }}
        />
      </Show>
      <Show when={props.editing && suggestions().length > 0}>
        <div class="path-suggest" role="listbox">
          <For each={suggestions()}>
            {(s, i) => (
              <button
                class="palette-row"
                role="option"
                aria-selected={hot() === i()}
                classList={{ hot: hot() === i() }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  void submit(s);
                }}
              >
                <span>{s}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
