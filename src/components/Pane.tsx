// One pane: tab strip, navigation toolbar with path bar and filter, file list.
import { createEffect, createSignal, For, on, Show } from "solid-js";
import { errorText, listDir, resolvePath } from "../lib/ipc";
import { fuzzyRank } from "../lib/fuzzy";
import { createBuilder, decodeBatch, isDir, snapshot } from "../lib/listing";
import { breadcrumbs, joinPath } from "../lib/paths";
import { history } from "../state/history";
import type { TabModel } from "../state/tab";
import { ui } from "../state/ui";
import { workspace, type PaneModel } from "../state/workspace";
import { contextMenu, FileList, type ListHandle } from "./FileList";
import { GridView, MillerView } from "./Extras";
import { Treemap } from "./Treemap";
import { IconBack, IconChevron, IconClose, IconForward, IconLayers, IconPlus, IconRefresh, IconSearch, IconUp } from "./Icons";

const TAB_MIME = "application/x-octopolis-tab";
const SUGGEST_DEBOUNCE_MS = 90;
const MAX_SUGGESTIONS = 12;

/** Lists the subfolders of `dir`, for path bar suggestions and crumb menus. */
async function subfolders(dir: string): Promise<string[]> {
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
  return (
    <section class="pane" classList={{ active: active() }} onMouseDown={() => workspace.focusPane(props.pane.id)}>
      <TabStrip pane={props.pane} />
      <Show when={tab()} keyed>
        {(t) => (
          <>
            <Toolbar paneId={props.pane.id} tab={t} />
            <Show when={!t.treemap()} fallback={<Treemap tab={t} />}>
              <Show when={t.viewMode() === "details"}>
                <FileList tab={t} active={active()} onReady={(h) => listHandles.set(t, h)} />
              </Show>
              <Show when={t.viewMode() === "grid"}>
                <GridView
                  tab={t}
                  active={active()}
                  onReady={(columns, ensureVisible, pageRows) => listHandles.set(t, { columns, ensureVisible, pageRows })}
                  onMenu={(e, pos) => contextMenu(t, e, pos)}
                />
              </Show>
              <Show when={t.viewMode() === "columns"}>
                <MillerView tab={t} />
              </Show>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}

function TabStrip(props: { pane: PaneModel }) {
  return (
    <div
      class="tabstrip"
      role="tablist"
      onDblClick={(e) => e.target === e.currentTarget && workspace.newTab(props.pane.id)}
      onDragOver={(e) => e.dataTransfer?.types.includes(TAB_MIME) && e.preventDefault()}
      onDrop={(e) => {
        const raw = e.dataTransfer?.getData(TAB_MIME);
        if (!raw) return;
        e.preventDefault();
        const { pane, tab } = JSON.parse(raw) as { pane: string; tab: string };
        workspace.moveTab(pane, tab, props.pane.id, props.pane.tabs().length);
      }}
    >
      <For each={props.pane.tabs()}>
        {(t) => (
          <div
            class="tab"
            role="tab"
            draggable={true}
            onDragStart={(e) => {
              e.dataTransfer!.setData(TAB_MIME, JSON.stringify({ pane: props.pane.id, tab: t.id }));
              e.dataTransfer!.effectAllowed = "move";
            }}
            onDragOver={(e) => e.dataTransfer?.types.includes(TAB_MIME) && e.preventDefault()}
            onDrop={(e) => {
              const raw = e.dataTransfer?.getData(TAB_MIME);
              if (!raw) return;
              e.preventDefault();
              e.stopPropagation();
              const { pane, tab } = JSON.parse(raw) as { pane: string; tab: string };
              workspace.moveTab(pane, tab, props.pane.id, props.pane.tabs().indexOf(t));
            }}
            aria-selected={props.pane.activeTabId() === t.id}
            classList={{ current: props.pane.activeTabId() === t.id }}
            title={t.path()}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
              else workspace.selectTab(props.pane.id, t.id);
            }}
            onAuxClick={(e) => e.button === 1 && workspace.closeTab(props.pane.id, t.id)}
          >
            <span class="tab-title">{t.title()}</span>
            <button
              class="tab-close"
              aria-label="Close tab"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => workspace.closeTab(props.pane.id, t.id)}
            >
              <IconClose size={12} />
            </button>
          </div>
        )}
      </For>
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
      <button class="icon-btn" title="Back (Alt+Left)" disabled={!props.tab.canBack()} onClick={props.tab.back}>
        <IconBack />
      </button>
      <button class="icon-btn" title="Forward (Alt+Right)" disabled={!props.tab.canForward()} onClick={props.tab.forward}>
        <IconForward />
      </button>
      <button class="icon-btn" title="Up (Alt+Up)" onClick={props.tab.up}>
        <IconUp />
      </button>
      <button class="icon-btn" classList={{ spinning: props.tab.status().loading }} title="Refresh (F5)" onClick={() => void props.tab.refresh()}>
        <IconRefresh />
      </button>
      <PathBar tab={props.tab} editing={editing()} setEditing={setEditing} />
      <SearchBox tab={props.tab} ref={(el) => (filterInput = el)} />
    </div>
  );
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
        placeholder={deep() ? "Search subfolders  ext: size: dm: re:" : "Filter"}
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

  /** Offers subfolders of the typed parent, then frequent folders that match. */
  function suggest(text: string) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const value = text.replace(/\//g, "\\");
      const at = value.lastIndexOf("\\");
      const parent = at >= 0 ? (at === 2 ? value.slice(0, 3) : value.slice(0, at)) : "";
      const partial = at >= 0 ? value.slice(at + 1) : value;
      let names: string[] = [];
      if (parent) names = await subfolders(parent).catch(() => []);
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
                  <button class="crumb" onClick={() => void props.tab.navigate(c.path)}>
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
            else if (e.key === "Escape") props.setEditing(false);
          }}
          onBlur={() => props.setEditing(false)}
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
