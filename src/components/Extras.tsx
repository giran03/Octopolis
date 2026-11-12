// Text prompt, grid and Miller views.
import { createEffect, createMemo, createResource, createSignal, Index, on, onCleanup, onMount, Show } from "solid-js";
import * as A from "../actions";
import { formatSize } from "../lib/format";
import { listDir, thumbnail } from "../lib/ipc";
import { baseOf, createBuilder, decodeBatch, isDir, snapshot, type Listing } from "../lib/listing";
import { baseName, joinPath, parentPath } from "../lib/paths";
import { cloudState } from "../lib/listing";
import { cellsInRect, selectAt } from "../lib/selection";
import { DENSITIES } from "../lib/themes";
import { createMarquee } from "./marquee";
import { settings } from "../state/settings";
import type { TabModel } from "../state/tab";
import { folderIcons } from "../state/folderIcons";
import { FileIcon, FolderEmoji } from "./Icons";
import { ui } from "../state/ui";

export function PromptDialog(props: { title: string; label: string; initial?: string; submitLabel?: string; onSubmit: (value: string) => void }) {
  let input!: HTMLInputElement;
  onMount(() => {
    input.focus();
    input.select();
  });
  const submit = () => {
    const v = input.value.trim();
    if (!v) return;
    ui.closePrompt();
    props.onSubmit(v);
  };
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && ui.closePrompt()}>
      <div class="dialog" role="dialog" aria-label={props.title} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") ui.closePrompt(); if (e.key === "Enter") submit(); }}>
        <h2>{props.title}</h2>
        <label class="settings-import">{props.label}<input ref={input} class="text-input" spellcheck={false} value={props.initial ?? ""} /></label>
        <div class="dialog-actions">
          <button class="btn" onClick={() => ui.closePrompt()}>Cancel</button>
          <button class="btn primary" onClick={submit}>{props.submitLabel ?? "Save"}</button>
        </div>
      </div>
    </div>
  );
}

const CELL = 124;
const CELL_H = 128;
const THUMB_PX = 96;
const OVERSCAN_ROWS = 1;
const MAX_THUMBS = 400;
/** Thumbnail URLs, oldest first. Visible cells stay recent, so they are never evicted. */
const thumbs = new Map<string, string>();
const thumbBytes = new Map<string, number>();
const pendingThumbs = new Map<string, Promise<string | null>>();

export const gridThumbCount = () => thumbs.size;
export const gridThumbBytes = () => [...thumbBytes.values()].reduce((a, b) => a + b, 0);
export function clearGridThumbs() {
  for (const url of thumbs.values()) URL.revokeObjectURL(url);
  thumbs.clear();
  thumbBytes.clear();
  pendingThumbs.clear();
}

function loadThumb(key: string, path: string): Promise<string | null> {
  if (!settings.showThumbnails()) return Promise.resolve(null);
  const known = thumbs.get(key);
  if (known) {
    thumbs.delete(key);
    thumbs.set(key, known); // mark as recently used
    return Promise.resolve(known);
  }
  let pending = pendingThumbs.get(key);
  if (!pending) {
    pending = thumbnail(path, THUMB_PX, false)
      .then(
        (b) => {
          if (thumbs.size >= MAX_THUMBS) {
            const oldest = thumbs.keys().next().value as string;
            URL.revokeObjectURL(thumbs.get(oldest)!);
            thumbs.delete(oldest);
            thumbBytes.delete(oldest);
          }
          const u = URL.createObjectURL(new Blob([b], { type: "image/png" }));
          thumbs.set(key, u);
          thumbBytes.set(key, b.byteLength);
          return u;
        },
        () => null,
      )
      .finally(() => pendingThumbs.delete(key));
    pendingThumbs.set(key, pending);
  }
  return pending;
}

function GridThumb(props: { path: string; modified: number; virtual: boolean; name: string; dir: boolean; online?: boolean }) {
  const [url, setUrl] = createSignal<string | null>(null);
  const key = () => `${props.path}|${props.modified}`;
  createEffect(
    on(key, (k) => {
      setUrl(null);
      // Reading an online-only file would download it just to draw a thumbnail.
      if (props.virtual || props.online) return;
      void loadThumb(k, props.path).then((u) => {
        if (key() === k) setUrl(u);
      });
    }),
  );
  return (
    <div class="grid-thumb">
      <Show when={props.dir && folderIcons.get(props.path)} fallback={
        <Show when={url()} fallback={<span class="grid-fallback"><FileIcon name={props.name} isDir={props.dir} size={40} /></span>}>
          {(u) => <img src={u()} alt="" draggable={false} />}
        </Show>
      }>
        {(e) => <span class="grid-fallback"><FolderEmoji emoji={e()} size={44} /></span>}
      </Show>
    </div>
  );
}

/** Virtualized thumbnail grid; rows of the same model the details list uses. */
export function GridView(props: { tab: TabModel; active: boolean; onReady: (columns: () => number, ensureVisible: (pos: number) => void, pageRows: () => number) => void; onMenu: (e: MouseEvent, pos: number | null) => void }) {
  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [size, setSize] = createSignal({ w: 800, h: 600 });
  const columns = () => Math.max(1, Math.floor(size().w / CELL));
  const view = () => props.tab.view();
  const rows = () => Math.ceil(view().length / columns());
  const firstRow = () => Math.max(0, Math.floor(scrollTop() / CELL_H) - OVERSCAN_ROWS);
  const visibleRows = () => Math.ceil(size().h / CELL_H) + OVERSCAN_ROWS * 2;
  const positions = createMemo(() => {
    const start = firstRow() * columns();
    const end = Math.min(view().length, start + visibleRows() * columns());
    return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
  });

  const ensureVisible = (pos: number) => {
    const top = Math.floor(pos / columns()) * CELL_H;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + CELL_H > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + CELL_H - scroller.clientHeight;
  };

  onMount(() => {
    const ro = new ResizeObserver(() => setSize({ w: scroller.clientWidth, h: scroller.clientHeight }));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
    props.onReady(columns, ensureVisible, () => Math.max(1, Math.floor(scroller.clientHeight / CELL_H)) * columns());
  });

  // Drag a box on empty space between tiles to select them. The grid has 6px of padding.
  const PAD = 6;
  const marquee = createMarquee({
    scroller: () => scroller,
    tab: () => props.tab,
    positionsFor: (x1, y1, x2, y2) => cellsInRect(view().length, columns(), CELL, CELL_H, x1 - PAD, y1 - PAD, x2 - PAD, y2 - PAD),
  });

  const click = (e: MouseEvent, pos: number) => {
    const t = props.tab;
    const r = selectAt(view(), t.selection(), t.anchor(), pos, { ctrl: e.ctrlKey, shift: e.shiftKey });
    t.setSelection(r.selection);
    t.setAnchor(r.anchor);
    t.setFocus(pos);
  };

  return (
    <div
      ref={scroller}
      class="grid-view"
      onScroll={() => setScrollTop(scroller.scrollTop)}
      onContextMenu={(e) => props.onMenu(e, null)}
      onMouseDown={(e) => {
        const bg = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("grid-rows");
        if (!bg || e.button !== 0) return;
        if (!e.ctrlKey && !e.shiftKey) props.tab.setSelection(new Set<number>());
        e.preventDefault();
        marquee.start(e);
      }}
    >
      <div class="grid-rows" style={{ height: `${rows() * CELL_H}px` }}>
        <Show when={marquee.box()}>
          {(b) => <div class="marquee" style={{ left: `${b().left - PAD}px`, top: `${b().top - PAD}px`, width: `${b().width}px`, height: `${b().height}px` }} />}
        </Show>
        <Index each={positions()}>
          {(pos) => {
            const entry = () => view()[pos()];
            const l = () => props.tab.listing();
            return (
              <Show when={entry() !== undefined}>
                <div
                  class="grid-cell"
                  classList={{ selected: props.tab.selection().has(entry()), focused: props.active && props.tab.focus() === pos() }}
                  style={{ transform: `translate(${(pos() % columns()) * CELL}px, ${Math.floor(pos() / columns()) * CELL_H}px)` }}
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      return A.openEntryInTab(props.tab, entry(), !e.shiftKey);
                    }
                    if (e.button === 0) click(e, pos());
                  }}
                  onDblClick={(e) => (e.ctrlKey ? A.openEntryInTab(props.tab, entry(), !e.shiftKey) : A.openEntry(props.tab, entry()))}
                  onContextMenu={(e) => {
                    e.stopPropagation();
                    props.onMenu(e, pos());
                  }}
                  data-tooltip={l().names[entry()]}
                  data-tooltip-truncated={l().names[entry()].includes("\\") ? undefined : ".grid-name"}
                >
                  <GridThumb path={props.tab.pathOf(entry())} modified={l().mtimes[entry()]} virtual={!!props.tab.archive()} name={l().names[entry()]} dir={isDir(l(), entry())} online={cloudState(l().attrs[entry()]) === "online"} />
                  <span class="grid-name">{baseOf(l().names[entry()])}</span>
                </div>
              </Show>
            );
          }}
        </Index>
      </div>
    </div>
  );
}

/** Parent columns list at most this many items (the current folder has no limit). */
const MILLER_ROW_LIMIT = 50_000;

/** A folder's listing, or null if it can't be read. */
async function readFolder(path: string): Promise<Listing | null> {
  const b = createBuilder(path);
  try {
    await listDir(path, (buf) => decodeBatch(buf, b));
  } catch {
    return null;
  }
  return snapshot(b);
}

const nameOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function sortedEntries(l: Listing): number[] {
  const idx = Array.from({ length: l.count }, (_, i) => i).filter((i) => settings.showHidden() || !l.names[i].startsWith("."));
  idx.sort((a, b) => Number(isDir(l, b)) - Number(isDir(l, a)) || nameOrder.compare(l.names[a], l.names[b]));
  return idx.slice(0, MILLER_ROW_LIMIT);
}

const MILLER_OVERSCAN = 10;

interface MillerRowInfo {
  readonly name: string;
  readonly dir: boolean;
  readonly size: number;
  readonly selected: boolean;
  readonly focused: boolean;
}

/** One virtualised column of rows. `scrollTo` is a row to keep in view. */
function MillerRows(props: {
  count: number;
  row: (k: number) => MillerRowInfo;
  label: string;
  scrollTo?: number;
  onDown: (k: number, e: MouseEvent) => void;
  onOpen: (k: number, e: MouseEvent) => void;
  onMenu?: (k: number | null, e: MouseEvent) => void;
  onReady?: (pageRows: () => number, ensureVisible: (k: number) => void) => void;
}) {
  let el!: HTMLDivElement;
  const [top, setTop] = createSignal(0);
  const [height, setHeight] = createSignal(600);
  const rowPx = () => DENSITIES[settings.density()];
  const first = () => Math.max(0, Math.floor(top() / rowPx()) - MILLER_OVERSCAN);
  const slots = createMemo(() => {
    const n = Math.max(0, Math.min(props.count - first(), Math.ceil(height() / rowPx()) + MILLER_OVERSCAN * 2));
    return Array.from({ length: n }, (_, i) => i);
  });
  const ensureVisible = (k: number) => {
    if (!el || k < 0) return;
    const y = k * rowPx();
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + rowPx() > el.scrollTop + el.clientHeight) el.scrollTop = y + rowPx() - el.clientHeight;
  };
  onMount(() => {
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
    props.onReady?.(() => Math.max(1, Math.floor(el.clientHeight / rowPx())), ensureVisible);
  });
  createEffect(on(() => props.scrollTo, (k) => k !== undefined && queueMicrotask(() => ensureVisible(k))));
  return (
    <div ref={el} class="miller-col" role="listbox" aria-label={props.label} onScroll={() => setTop(el.scrollTop)} onContextMenu={(e) => props.onMenu?.(null, e)}>
      <div class="miller-rows" style={{ height: `${props.count * rowPx()}px` }}>
        <Index each={slots()}>
          {(slot) => {
            const k = () => first() + slot();
            const r = () => props.row(k());
            return (
              <Show when={k() < props.count}>
                <div
                  class="miller-row"
                  role="option"
                  aria-selected={r().selected}
                  classList={{ selected: r().selected, focused: r().focused }}
                  style={{ transform: `translateY(${k() * rowPx()}px)` }}
                  onMouseDown={(e) => e.button === 0 && props.onDown(k(), e)}
                  onDblClick={(e) => props.onOpen(k(), e)}
                  onContextMenu={(e) => {
                    e.stopPropagation();
                    props.onMenu?.(k(), e);
                  }}
                  data-tooltip={r().name}
                  data-tooltip-truncated=".miller-name"
                >
                  <span class="miller-name">{r().name}</span>
                  <Show when={r().dir} fallback={<span class="muted small">{formatSize(r().size)}</span>}>
                    <span class="muted">›</span>
                  </Show>
                </div>
              </Show>
            );
          }}
        </Index>
      </div>
    </div>
  );
}

/** A parent folder's column: click a folder to show it, a file to select it. */
function MillerColumn(props: { path: string; selected: string | null; onPick: (path: string, dir: boolean) => void; onOpen: (path: string) => void }) {
  const [listing] = createResource(() => props.path, readFolder);
  return (
    <Show when={listing()} fallback={<div class="miller-col"><p class="muted small miller-msg">{listing.loading ? "Loading…" : "Can't read this folder"}</p></div>}>
      {(l) => {
        const order = createMemo(() => sortedEntries(l()));
        const pickedAt = () => {
          const want = props.selected?.toLowerCase();
          return want ? order().findIndex((i) => l().names[i].toLowerCase() === want) : -1;
        };
        const full = (k: number) => joinPath(l().path, l().names[order()[k]]);
        return (
          <MillerRows
            count={order().length}
            label={baseName(props.path) || props.path}
            scrollTo={pickedAt()}
            row={(k) => {
              const i = order()[k];
              return { name: l().names[i], dir: isDir(l(), i), size: l().sizes[i], selected: k === pickedAt(), focused: false };
            }}
            onDown={(k) => props.onPick(full(k), isDir(l(), order()[k]))}
            onOpen={(k) => props.onOpen(full(k))}
          />
        );
      }}
    </Show>
  );
}

/**
 * macOS-style columns: two parent folders, then the current folder, which is
 * the tab's own list (its sort, filter, selection and keys). Left goes up a
 * folder and Right opens the focused one (see keys.ts).
 */
export function MillerView(props: {
  tab: TabModel;
  active: boolean;
  onReady: (pageRows: () => number, ensureVisible: (pos: number) => void) => void;
  onMenu: (e: MouseEvent, pos: number | null) => void;
}) {
  let box!: HTMLDivElement;
  const parents = createMemo(() => {
    const chain: string[] = [];
    for (let p = parentPath(props.tab.path()); p && chain.length < 2; p = parentPath(p)) chain.unshift(p);
    return chain;
  });
  createEffect(on(() => props.tab.path(), () => queueMicrotask(() => (box.scrollLeft = box.scrollWidth))));
  const pick = (path: string, dir: boolean) => {
    if (dir) return void props.tab.navigate(path);
    const parent = parentPath(path);
    if (parent) void props.tab.navigate(parent, [baseName(path)]);
  };
  const view = () => props.tab.view();
  const l = () => props.tab.listing();
  const click = (pos: number, e: MouseEvent) => {
    const t = props.tab;
    const r = selectAt(view(), t.selection(), t.anchor(), pos, { ctrl: e.ctrlKey, shift: e.shiftKey });
    t.setSelection(r.selection);
    t.setAnchor(r.anchor);
    t.setFocus(pos);
  };
  return (
    <div ref={box} class="miller">
      <Index each={parents()}>
        {(c, i) => <MillerColumn path={c()} selected={baseName(parents()[i + 1] ?? props.tab.path())} onPick={pick} onOpen={(p) => A.openFromPath(props.tab, p)} />}
      </Index>
      <MillerRows
        count={view().length}
        label={baseName(props.tab.path()) || props.tab.path()}
        scrollTo={props.tab.focus()}
        row={(pos) => {
          const e = view()[pos];
          return { name: baseOf(l().names[e]), dir: isDir(l(), e), size: l().sizes[e], selected: props.tab.selection().has(e), focused: props.active && props.tab.focus() === pos };
        }}
        onDown={click}
        onOpen={(pos, e) => (e.ctrlKey ? A.openEntryInTab(props.tab, view()[pos], !e.shiftKey) : A.openEntry(props.tab, view()[pos]))}
        onMenu={(pos, e) => props.onMenu(e, pos)}
        onReady={props.onReady}
      />
    </div>
  );
}
