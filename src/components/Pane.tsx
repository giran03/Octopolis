// One pane: tab strip, navigation toolbar with path bar and filter, file list.
import { createEffect, createSignal, For, on, Show } from "solid-js";
import { errorText, resolvePath } from "../lib/ipc";
import { breadcrumbs } from "../lib/paths";
import type { TabModel } from "../state/tab";
import { ui } from "../state/ui";
import { workspace, type PaneModel } from "../state/workspace";
import { FileList, type ListHandle } from "./FileList";
import { IconBack, IconChevron, IconClose, IconForward, IconPlus, IconRefresh, IconSearch, IconUp } from "./Icons";

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
            <FileList tab={t} active={active()} onReady={(h) => listHandles.set(t, h)} />
          </>
        )}
      </Show>
    </section>
  );
}

function TabStrip(props: { pane: PaneModel }) {
  return (
    <div class="tabstrip" role="tablist" onDblClick={(e) => e.target === e.currentTarget && workspace.newTab(props.pane.id)}>
      <For each={props.pane.tabs()}>
        {(t) => (
          <div
            class="tab"
            role="tab"
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
      <label class="filter">
        <IconSearch size={14} />
        <input
          ref={filterInput}
          placeholder="Filter"
          value={props.tab.filter()}
          spellcheck={false}
          onInput={(e) => props.tab.setFilter(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              props.tab.setFilter("");
              e.currentTarget.blur();
            }
            if (e.key === "Enter" || e.key === "ArrowDown") e.currentTarget.blur();
            e.stopPropagation();
          }}
        />
      </label>
    </div>
  );
}

function PathBar(props: { tab: TabModel; editing: boolean; setEditing: (v: boolean) => void }) {
  let input: HTMLInputElement | undefined;

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
                    <IconChevron size={12} class="crumb-sep" />
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
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") void submit(e.currentTarget.value);
            if (e.key === "Escape") props.setEditing(false);
          }}
          onBlur={() => props.setEditing(false)}
        />
      </Show>
    </div>
  );
}
