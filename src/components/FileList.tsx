// Virtualized details list. Only the visible rows (plus overscan) exist in the
// DOM; the same row nodes are reused as the list scrolls.
import { createEffect, createMemo, createSignal, Index, on, onCleanup, onMount, Show } from "solid-js";
import * as A from "../actions";
import { categoryOf, formatDate, formatSize, typeLabel } from "../lib/format";
import { ATTR_REPARSE, baseOf, dirOf, isDir, isHidden } from "../lib/listing";
import { joinPath, sameVolume, stemLength } from "../lib/paths";
import { selectAt } from "../lib/selection";
import type { SortKey } from "../lib/sort";
import { ops } from "../state/ops";
import type { TabModel } from "../state/tab";
import { ui, type MenuEntry } from "../state/ui";
import { FileGlyph } from "./Icons";

export const ROW_HEIGHT = 26;
const OVERSCAN = 6;
const DRAG_MIME = "application/x-octopolis-paths";

/** Scroll offset per tab, so switching tabs returns to the same place. */
const scrollMemory = new WeakMap<TabModel, number>();
/** Paths being dragged (dragover can't read the payload, only its types). */
let dragging: readonly string[] = [];

const COLUMNS: { key: SortKey; label: string; align?: "end" }[] = [
  { key: "name", label: "Name" },
  { key: "modified", label: "Date modified" },
  { key: "type", label: "Type" },
  { key: "size", label: "Size", align: "end" },
];

export interface ListHandle {
  ensureVisible: (pos: number) => void;
  pageRows: () => number;
}

export function FileList(props: { tab: TabModel; active: boolean; onReady: (h: ListHandle) => void }) {
  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(600);
  const [dropTarget, setDropTarget] = createSignal<number | "list" | null>(null);

  const tab = () => props.tab;
  const view = () => tab().view();
  const first = () => Math.max(0, Math.floor(scrollTop() / ROW_HEIGHT) - OVERSCAN);
  const slotCount = () => Math.max(0, Math.min(view().length - first(), Math.ceil(height() / ROW_HEIGHT) + OVERSCAN * 2));
  const slots = createMemo(() => Array.from({ length: slotCount() }, (_, i) => i));

  const ensureVisible = (pos: number) => {
    const top = pos * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
  };

  onMount(() => {
    const ro = new ResizeObserver(() => setHeight(scroller.clientHeight));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
    scroller.scrollTop = scrollMemory.get(tab()) ?? 0;
    setScrollTop(scroller.scrollTop);
    props.onReady({ ensureVisible, pageRows: () => Math.floor(scroller.clientHeight / ROW_HEIGHT) });
  });

  // A new folder starts at the top; selections made by a load scroll into view.
  createEffect(on(() => tab().listing().path, () => {
    scroller.scrollTop = 0;
    setScrollTop(0);
  }, { defer: true }));
  createEffect(on(() => tab().selection(), () => queueMicrotask(() => ensureVisible(tab().focus())), { defer: true }));

  const onScroll = () => {
    setScrollTop(scroller.scrollTop);
    scrollMemory.set(tab(), scroller.scrollTop);
    ui.closeMenu();
  };

  const clickRow = (e: MouseEvent, pos: number) => {
    if (e.button !== 0) return;
    const t = tab();
    const r = selectAt(view(), t.selection(), t.anchor(), pos, { ctrl: e.ctrlKey, shift: e.shiftKey });
    t.setSelection(r.selection);
    t.setAnchor(r.anchor);
    t.setFocus(pos);
  };

  const contextRow = (e: MouseEvent, pos: number | null) => {
    e.preventDefault();
    const t = tab();
    if (pos !== null && !t.selection().has(view()[pos])) {
      t.setSelection(new Set([view()[pos]]));
      t.setAnchor(pos);
      t.setFocus(pos);
    }
    if (pos === null) t.setSelection(new Set<number>());
    ui.openMenu(e.clientX, e.clientY, menuFor(t, pos !== null));
  };

  // ----- drag and drop -----
  const dragStart = (e: DragEvent, pos: number) => {
    const t = tab();
    if (!t.selection().has(view()[pos])) {
      t.setSelection(new Set([view()[pos]]));
      t.setFocus(pos);
    }
    dragging = t.selectedPaths();
    e.dataTransfer!.setData(DRAG_MIME, JSON.stringify(dragging));
    e.dataTransfer!.effectAllowed = "copyMove";
  };
  const destFor = (target: number | "list") => (target === "list" ? tab().path() : tab().pathOf(view()[target]));
  const dragOver = (e: DragEvent, target: number | "list") => {
    if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
    if (target !== "list" && !isDir(tab().listing(), view()[target])) target = "list";
    const dest = destFor(target);
    if (dragging.some((p) => p.toLowerCase() === dest.toLowerCase())) return; // onto itself
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.ctrlKey || dragging.some((s) => !sameVolume(s, dest)) ? "copy" : "move";
    setDropTarget(target);
  };
  const drop = (e: DragEvent) => {
    const target = dropTarget();
    setDropTarget(null);
    if (target === null) return;
    e.preventDefault();
    e.stopPropagation();
    const paths: string[] = JSON.parse(e.dataTransfer?.getData(DRAG_MIME) || "[]");
    A.dropPaths(paths, destFor(target), e.ctrlKey);
  };

  return (
    <div class="filelist" classList={{ active: props.active }}>
      <div class="filelist-head" role="row">
        {COLUMNS.map((c) => (
          <button class={`col-head col-${c.key}`} classList={{ end: c.align === "end", sorted: tab().sort().key === c.key }} onClick={() => tab().sortBy(c.key)}>
            <span>{c.label}</span>
            <Show when={tab().sort().key === c.key}>
              <span class="sort-arrow">{tab().sort().dir === 1 ? "▲" : "▼"}</span>
            </Show>
          </button>
        ))}
      </div>
      <div
        ref={scroller}
        class="filelist-body"
        classList={{ "drop-list": dropTarget() === "list" }}
        role="grid"
        aria-rowcount={view().length}
        onScroll={onScroll}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("rows")) {
            if (!e.ctrlKey && !e.shiftKey) tab().setSelection(new Set<number>());
          }
        }}
        onContextMenu={(e) => contextRow(e, null)}
        onDragOver={(e) => dragOver(e, "list")}
        onDragLeave={(e) => e.currentTarget === e.target && setDropTarget(null)}
        onDrop={drop}
      >
        <div class="rows" style={{ height: `${view().length * ROW_HEIGHT}px` }}>
          <Index each={slots()}>
            {(slot) => {
              const pos = () => first() + slot();
              const entry = () => view()[pos()];
              const l = () => tab().listing();
              const dir = () => isDir(l(), entry());
              const name = () => l().names[entry()];
              return (
                <Show when={entry() !== undefined}>
                  <div
                    class="row"
                    role="row"
                    draggable={tab().renaming() !== entry()}
                    style={{ transform: `translateY(${pos() * ROW_HEIGHT}px)` }}
                    classList={{
                      selected: tab().selection().has(entry()),
                      focused: props.active && tab().focus() === pos(),
                      dim: isHidden(l(), entry()) || ops.isCut(joinPath(l().path, name())),
                      "drop-row": dropTarget() === pos(),
                    }}
                    onMouseDown={(e) => clickRow(e, pos())}
                    onDblClick={() => A.openEntry(tab(), entry())}
                    onContextMenu={(e) => {
                      e.stopPropagation();
                      contextRow(e, pos());
                    }}
                    onDragStart={(e) => dragStart(e, pos())}
                    onDragOver={(e) => dragOver(e, pos())}
                    onDragEnd={() => {
                      dragging = [];
                      setDropTarget(null);
                    }}
                  >
                    <div class="cell name">
                      <FileGlyph category={categoryOf(baseOf(name()), dir())} link={(l().attrs[entry()] & ATTR_REPARSE) !== 0} />
                      <Show when={tab().renaming() === entry()} fallback={<NameLabel name={name()} />}>
                        <RenameInput name={baseOf(name())} isDir={dir()} onDone={(v) => (v === null ? tab().setRenaming(null) : void A.commitRename(tab(), entry(), v))} />
                      </Show>
                    </div>
                    <div class="cell muted col-modified">{formatDate(l().mtimes[entry()])}</div>
                    <div class="cell muted col-type">{typeLabel(baseOf(name()), dir())}</div>
                    <div class="cell end muted num">{dir() ? "" : formatSize(l().sizes[entry()])}</div>
                  </div>
                </Show>
              );
            }}
          </Index>
        </div>
        <ListState tab={tab()} />
      </div>
    </div>
  );
}

function ListState(props: { tab: TabModel }) {
  const s = () => props.tab.status();
  const empty = () => props.tab.view().length === 0;
  return (
    <Show when={empty()}>
      <div class="list-state">
        <Show
          when={s().error}
          fallback={<span>{s().loading ? "Loading…" : props.tab.filter() ? "No items match the filter" : "This folder is empty"}</span>}
        >
          <span class="error-text">{s().error}</span>
          <button class="btn" onClick={() => void props.tab.refresh()}>Try again</button>
        </Show>
      </div>
    </Show>
  );
}

function RenameInput(props: { name: string; isDir: boolean; onDone: (value: string | null) => void }) {
  let input!: HTMLInputElement;
  let finished = false;
  const finish = (v: string | null) => {
    if (finished) return;
    finished = true;
    props.onDone(v);
  };
  onMount(() => {
    input.focus();
    input.setSelectionRange(0, stemLength(props.name, props.isDir));
  });
  return (
    <input
      ref={input}
      class="rename"
      value={props.name}
      spellcheck={false}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(input.value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(input.value)}
    />
  );
}

function menuFor(tab: TabModel, onItems: boolean): MenuEntry[] {
  const hasClip = (ops.clip()?.paths.length ?? 0) > 0;
  const single = tab.selection().size === 1;
  const items: MenuEntry[] = onItems
    ? [
        { label: "Open", shortcut: "Enter", run: () => A.openSelection(tab) },
        "separator",
        { label: "Cut", shortcut: "Ctrl+X", run: () => A.copySelection(tab, "cut") },
        { label: "Copy", shortcut: "Ctrl+C", run: () => A.copySelection(tab, "copy") },
        { label: "Paste", shortcut: "Ctrl+V", disabled: !hasClip, run: () => ops.paste(tab.path()) },
        "separator",
        { label: "Rename", shortcut: "F2", disabled: !single, run: () => A.startRename(tab) },
        { label: "Copy path", shortcut: "Ctrl+Shift+C", run: () => void A.copyPaths(tab) },
        { label: "Show in Explorer", run: () => A.reveal(tab) },
        "separator",
        { label: "Delete", shortcut: "Del", run: () => A.deleteSelection(tab, false) },
        { label: "Delete permanently", shortcut: "Shift+Del", danger: true, run: () => A.deleteSelection(tab, true) },
      ]
    : [
        { label: "Paste", shortcut: "Ctrl+V", disabled: !hasClip, run: () => ops.paste(tab.path()) },
        { label: "New folder", shortcut: "Ctrl+Shift+N", run: () => void A.newFolder(tab) },
        "separator",
        { label: "Refresh", shortcut: "F5", run: () => void tab.refresh() },
        { label: "Copy folder path", run: () => void A.copyPaths(tab, [tab.path()]) },
        { label: "Open in Explorer", run: () => A.reveal(tab, tab.path()) },
      ];
  return items;
}

/** A plain name, or for search results the name plus its folder, dimmed. */
function NameLabel(props: { name: string }) {
  return (
    <span class="label">
      {baseOf(props.name)}
      <Show when={dirOf(props.name)}>{(d) => <span class="label-dir">{d()}</span>}</Show>
    </span>
  );
}
