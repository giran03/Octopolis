// The other ways to show a folder: icons of any size, tiles, a list that flows in columns, and a content view.
// They share the details list's model (the tab's view, selection and focus) and its drag and drop.
import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, onMount, Show } from "solid-js";
import * as A from "../actions";
import { formatDate, formatSize, typeLabel, withoutExtension } from "../lib/format";
import { baseOf, cloudState, isDir, isHidden } from "../lib/listing";
import { sameVolume } from "../lib/paths";
import { cellsInRect, selectAt } from "../lib/selection";
import { BENTO_GAP, bentoRowHeight, CONTENT_ROW, iconCell, LIST_COLUMN_W, thumbBucket, TILE } from "../lib/viewZoom";
import { readDrop } from "../lib/webdrop";
import { cancelSpring, carriesPaths, DRAG_MIME, dragRaw, dragState, isExternalDrag, onDragReset, springLoad, springTarget } from "../state/drag";
import { ops } from "../state/ops";
import { settings } from "../state/settings";
import type { TabModel } from "../state/tab";
import { GridThumb, loadThumb } from "./Extras";
import { ListState } from "./FileList";
import { FileIcon, PathIcon } from "./Icons";
import { createMarquee } from "./marquee";

type Menu = (e: MouseEvent, pos: number | null) => void;
type Ready = (columns: () => number, ensureVisible: (pos: number) => void, pageRows: () => number) => void;
interface ViewProps {
  readonly tab: TabModel;
  readonly active: boolean;
  readonly onReady: Ready;
  readonly onMenu: Menu;
}

const OVERSCAN = 1;
const PAD = 6;

/** Starts dragging the items under `pos`: the selection, or just that item. Real files go out to Windows' own drag. */
function itemDragStart(e: DragEvent, tab: TabModel, pos: number) {
  const view = tab.view();
  if (!tab.selection().has(view[pos])) {
    tab.setSelection(new Set([view[pos]]));
    tab.setFocus(pos);
  }
  const paths = tab.selectedPaths();
  dragState.paths = paths;
  dragState.archive = tab.archive();
  const l = tab.listing();
  const picked = [...tab.selection()];
  dragState.dirs = !tab.archive() ? picked.filter((i) => isDir(l, i)).map((i) => tab.pathOf(i)) : [];
  dragState.allDirs = !tab.archive() && picked.every((i) => isDir(l, i));
  e.dataTransfer!.setData(DRAG_MIME, JSON.stringify(paths));
  e.dataTransfer!.effectAllowed = "copyMove";
  if (!tab.archive()) {
    e.preventDefault();
    void A.dragOut(paths);
  }
}

/** What every view does with an item: select, open, menu, drag, and take drops on folders and on the empty area. */
function useEntries(props: Omit<ViewProps, "onReady">) {
  const tab = () => props.tab;
  const [hot, setHot] = createSignal<string | null>(null);
  const [copy, setCopy] = createSignal(false);
  onDragReset(() => setHot(null));

  const entryAt = (pos: number) => tab().view()[pos];
  const destAt = (pos: number | null) => {
    if (pos === null) return tab().path();
    const e = entryAt(pos);
    return e !== undefined && isDir(tab().listing(), e) ? tab().pathOf(e) : tab().path();
  };
  const select = (e: MouseEvent, pos: number) => {
    const t = tab();
    const r = selectAt(t.view(), t.selection(), t.anchor(), pos, { ctrl: e.ctrlKey, shift: e.shiftKey });
    t.setSelection(r.selection);
    t.setAnchor(r.anchor);
    t.setFocus(pos);
  };

  const over = (e: DragEvent, pos: number | null) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    const dest = destAt(pos);
    const onFolder = dest !== tab().path();
    if (carriesPaths(dt)) {
      if (onFolder && !tab().archive()) springLoad(`row:${dest}`, () => void tab().navigate(dest));
      else cancelSpring();
      if (dragState.paths.some((p) => p.toLowerCase() === dest.toLowerCase())) return;
      if (!e.ctrlKey && !dragState.archive && A.alreadyIn(dragState.paths, dest)) return void setHot(null);
      e.preventDefault();
      e.stopPropagation();
      dt.dropEffect = e.ctrlKey || dragState.paths.some((s) => !sameVolume(s, dest)) ? "copy" : "move";
      setCopy(dt.dropEffect === "copy");
      setHot(dest);
      return;
    }
    if (!isExternalDrag(dt) || tab().archive()) return;
    const incoming = e.dataTransfer as DataTransfer;
    cancelSpring();
    e.preventDefault();
    e.stopPropagation();
    incoming.dropEffect = "copy";
    setCopy(true);
    setHot(dest);
  };
  const drop = (e: DragEvent) => {
    cancelSpring();
    const dest = hot();
    setHot(null);
    const dt = e.dataTransfer;
    if (dest === null || !dt) return;
    e.preventDefault();
    e.stopPropagation();
    if (carriesPaths(dt)) {
      const paths: string[] = JSON.parse(dragRaw(dt) || "[]");
      A.dropPaths(paths, dest, e.ctrlKey, dragState.archive, !!tab().archive());
    } else if (isExternalDrag(e.dataTransfer)) void A.dropExternal(tab(), dest, readDrop(e.dataTransfer as DataTransfer));
  };

  /** Event handlers for the element showing the item at `pos()`. */
  const handlers = (pos: () => number) => ({
    draggable: true,
    onMouseDown: (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        return A.openEntryInTab(tab(), entryAt(pos()), !e.shiftKey);
      }
      if (e.button === 0) select(e, pos());
    },
    onDblClick: (e: MouseEvent) => (e.ctrlKey ? A.openEntryInTab(tab(), entryAt(pos()), !e.shiftKey) : A.openEntry(tab(), entryAt(pos()))),
    onContextMenu: (e: MouseEvent) => {
      e.stopPropagation();
      props.onMenu(e, pos());
    },
    onDragStart: (e: DragEvent) => itemDragStart(e, tab(), pos()),
    onDragOver: (e: DragEvent) => over(e, pos()),
    onDrop: drop,
  });
  /** The same for the empty area around the items. */
  const background = {
    onDragOver: (e: DragEvent) => over(e, null),
    onDragLeave: (e: DragEvent) => e.currentTarget === e.target && setHot(null),
    onDrop: drop,
  };

  /** Classes for the item at `pos`. */
  const classes = (pos: number) => {
    const e = entryAt(pos);
    const l = tab().listing();
    const dir = e !== undefined && isDir(l, e);
    const dest = dir ? tab().pathOf(e) : null;
    const cut = e !== undefined && ops.isCut(tab().pathOf(e));
    const hidden = e !== undefined && isHidden(l, e);
    return {
      selected: e !== undefined && tab().selection().has(e),
      focused: props.active && tab().focus() === pos,
      dim: hidden || cut,
      cut,
      "drop-target": dest !== null && hot() === dest,
      "drop-copy": dest !== null && hot() === dest && copy(),
      spring: dest !== null && springTarget() === `row:${dest}`,
    };
  };
  const listDrop = () => hot() === tab().path();
  return { entryAt, select, handlers, background, classes, listDrop };
}

/** The picture of an item at `size` pixels: its thumbnail, or its icon. */
function ItemPicture(props: { tab: TabModel; entry: number; size: number }) {
  const l = () => props.tab.listing();
  return (
    <GridThumb
      path={props.tab.pathOf(props.entry)}
      modified={l().mtimes[props.entry]}
      virtual={!!props.tab.archive()}
      name={l().names[props.entry]}
      dir={isDir(l(), props.entry)}
      online={cloudState(l().attrs[props.entry]) === "online"}
      size={props.size}
    />
  );
}

const shownName = (tab: TabModel, entry: number) => {
  const l = tab.listing();
  const base = baseOf(l.names[entry]);
  return settings.showExtensions() ? base : withoutExtension(base, isDir(l, entry));
};

/** The size line of tiles and content rows: the file's size, or nothing for a folder (its size is not known here). */
const sizeText = (tab: TabModel, entry: number) => {
  const l = tab.listing();
  return isDir(l, entry) ? "" : formatSize(l.sizes[entry]);
};

/** Icons (any size) or tiles, laid out in a grid that flows left to right. */
export function CellGrid(props: ViewProps & { variant: "icons" | "tiles" }) {
  const ent = useEntries(props);
  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [box, setBox] = createSignal({ w: 800, h: 600 });
  const cell = () => (props.variant === "icons" ? iconCell(props.tab.iconSize()) : { w: TILE.w, h: TILE.h, thumb: TILE.thumb });
  const columns = () => Math.max(1, Math.floor((box().w - PAD * 2) / cell().w));
  /** The cells share the whole row, so a window that is not a whole number of cells wide leaves no empty strip. */
  const cellW = () => Math.max(cell().w, (box().w - PAD * 2) / columns());
  const view = () => props.tab.view();
  const rows = () => Math.ceil(view().length / columns());
  const firstRow = () => Math.max(0, Math.floor(scrollTop() / cell().h) - OVERSCAN);
  const positions = createMemo(() => {
    const start = firstRow() * columns();
    const end = Math.min(view().length, start + (Math.ceil(box().h / cell().h) + OVERSCAN * 2) * columns());
    return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
  });
  const ensureVisible = (pos: number) => {
    const top = Math.floor(pos / columns()) * cell().h;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + cell().h > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + cell().h - scroller.clientHeight;
  };
  onMount(() => {
    const ro = new ResizeObserver(() => setBox({ w: scroller.clientWidth, h: scroller.clientHeight }));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
    props.onReady(columns, ensureVisible, () => Math.max(1, Math.floor(scroller.clientHeight / cell().h)) * columns());
  });
  const marquee = createMarquee({
    scroller: () => scroller,
    tab: () => props.tab,
    positionsFor: (x1, y1, x2, y2) => cellsInRect(view().length, columns(), cellW(), cell().h, x1 - PAD, y1 - PAD, x2 - PAD, y2 - PAD),
  });

  return (
    <div
      ref={scroller}
      class="grid-view"
      classList={{ "drop-list": ent.listDrop(), tiles: props.variant === "tiles" }}
      onScroll={() => setScrollTop(scroller.scrollTop)}
      onContextMenu={(e) => props.onMenu(e, null)}
      onWheel={(e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        A.zoomView(props.tab, e.deltaY < 0 ? 1 : -1);
      }}
      onMouseDown={(e) => {
        const bg = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("grid-rows");
        if (!bg || e.button !== 0) return;
        if (!e.ctrlKey && !e.shiftKey) props.tab.setSelection(new Set<number>());
        e.preventDefault();
        marquee.start(e);
      }}
      {...ent.background}
    >
      <div class="grid-rows" style={{ height: `${rows() * cell().h}px` }}>
        <Show when={marquee.box()}>
          {(b) => <div class="marquee" style={{ left: `${b().left - PAD}px`, top: `${b().top - PAD}px`, width: `${b().width}px`, height: `${b().height}px` }} />}
        </Show>
        <Index each={positions()}>
          {(pos) => {
            const entry = () => view()[pos()];
            return (
              <Show when={entry() !== undefined}>
                <div
                  class="grid-cell"
                  classList={{ ...ent.classes(pos()), "tile-cell": props.variant === "tiles" }}
                  style={{
                    width: `${cellW() - 4}px`,
                    height: `${cell().h - 4}px`,
                    transform: `translate(${(pos() % columns()) * cellW()}px, ${Math.floor(pos() / columns()) * cell().h}px)`,
                  }}
                  data-tooltip={props.tab.listing().names[entry()]}
                  data-tooltip-truncated={props.tab.listing().names[entry()].includes("\\") ? undefined : ".grid-name"}
                  {...ent.handlers(pos)}
                >
                  <ItemPicture tab={props.tab} entry={entry()} size={cell().thumb} />
                  <Show when={props.variant === "tiles"} fallback={<span class="grid-name">{shownName(props.tab, entry())}</span>}>
                    <span class="tile-text">
                      <span class="grid-name">{shownName(props.tab, entry())}</span>
                      <span class="tile-sub muted">{typeLabel(baseOf(props.tab.listing().names[entry()]), isDir(props.tab.listing(), entry()))}</span>
                      <span class="tile-sub muted">{sizeText(props.tab, entry())}</span>
                    </span>
                  </Show>
                </div>
              </Show>
            );
          }}
        </Index>
      </div>
      <ListState tab={props.tab} />
    </div>
  );
}

/** A compact list that fills a column from top to bottom, then the next column; scrolls sideways. */
export function ListView(props: ViewProps) {
  const ent = useEntries(props);
  let scroller!: HTMLDivElement;
  const [scrollLeft, setScrollLeft] = createSignal(0);
  const [box, setBox] = createSignal({ w: 800, h: 600 });
  const rowPx = () => settings.rowPx();
  /** A whole number of columns always fills the width, so the last visible column never leaves a gap. */
  const colW = () => {
    const room = Math.max(LIST_COLUMN_W, box().w - 8);
    return room / Math.max(1, Math.floor(room / LIST_COLUMN_W));
  };
  const perColumn = () => Math.max(1, Math.floor((box().h - 2) / rowPx()));
  const view = () => props.tab.view();
  const columnCount = () => Math.ceil(view().length / perColumn());
  const firstColumn = () => Math.max(0, Math.floor(scrollLeft() / colW()) - OVERSCAN);
  const positions = createMemo(() => {
    const start = firstColumn() * perColumn();
    const end = Math.min(view().length, start + (Math.ceil(box().w / colW()) + OVERSCAN * 2) * perColumn());
    return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
  });
  const ensureVisible = (pos: number) => {
    const left = Math.floor(pos / perColumn()) * colW();
    if (left < scroller.scrollLeft) scroller.scrollLeft = left;
    else if (left + colW() > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = left + colW() - scroller.clientWidth;
  };
  onMount(() => {
    const ro = new ResizeObserver(() => setBox({ w: scroller.clientWidth, h: scroller.clientHeight }));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
    props.onReady(perColumn, ensureVisible, () => perColumn() * Math.max(1, Math.floor(scroller.clientWidth / colW())));
  });
  const icon = () => Math.round(Math.max(14, rowPx() * 0.62));

  return (
    <div
      ref={scroller}
      class="list-view"
      classList={{ "drop-list": ent.listDrop() }}
      onScroll={() => setScrollLeft(scroller.scrollLeft)}
      onContextMenu={(e) => props.onMenu(e, null)}
      onWheel={(e) => {
        if (e.ctrlKey) {
          e.preventDefault();
          return A.zoomView(props.tab, e.deltaY < 0 ? 1 : -1);
        }
        // A wheel scrolls along the columns, as a list that grows sideways should.
        if (e.deltaX === 0 && !e.shiftKey) scroller.scrollLeft += e.deltaY;
      }}
      onMouseDown={(e) => {
        const bg = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("list-cols");
        if (bg && e.button === 0 && !e.ctrlKey && !e.shiftKey) props.tab.setSelection(new Set<number>());
      }}
      {...ent.background}
    >
      <div class="list-cols" style={{ width: `${columnCount() * colW()}px`, height: `${perColumn() * rowPx()}px` }}>
        <Index each={positions()}>
          {(pos) => {
            const entry = () => view()[pos()];
            const l = () => props.tab.listing();
            return (
              <Show when={entry() !== undefined}>
                <div
                  class="list-cell"
                  classList={ent.classes(pos())}
                  style={{
                    width: `${colW() - 4}px`,
                    height: `${rowPx() - 2}px`,
                    transform: `translate(${Math.floor(pos() / perColumn()) * colW()}px, ${(pos() % perColumn()) * rowPx()}px)`,
                  }}
                  data-tooltip={l().names[entry()]}
                  data-tooltip-truncated=".list-name"
                  {...ent.handlers(pos)}
                >
                  <span class="list-icon">
                    <Show when={isDir(l(), entry()) && !props.tab.archive()} fallback={<FileIcon name={l().names[entry()]} isDir={isDir(l(), entry())} size={icon()} />}>
                      <PathIcon path={props.tab.pathOf(entry())} name={l().names[entry()]} isDir size={icon()} fallback={<FileIcon name={l().names[entry()]} isDir size={icon()} />} />
                    </Show>
                  </span>
                  <span class="list-name">{shownName(props.tab, entry())}</span>
                </div>
              </Show>
            );
          }}
        </Index>
      </div>
      <ListState tab={props.tab} />
    </div>
  );
}

/** One row per item: a picture, its name, and a line of facts under it. */
export function ContentView(props: ViewProps) {
  const ent = useEntries(props);
  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [box, setBox] = createSignal({ w: 800, h: 600 });
  const view = () => props.tab.view();
  const h = CONTENT_ROW.h;
  const first = () => Math.max(0, Math.floor(scrollTop() / h) - 4);
  const positions = createMemo(() => {
    const end = Math.min(view().length, first() + Math.ceil(box().h / h) + 8);
    return Array.from({ length: Math.max(0, end - first()) }, (_, i) => first() + i);
  });
  const ensureVisible = (pos: number) => {
    const top = pos * h;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + h > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + h - scroller.clientHeight;
  };
  onMount(() => {
    const ro = new ResizeObserver(() => setBox({ w: scroller.clientWidth, h: scroller.clientHeight }));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
    props.onReady(() => 1, ensureVisible, () => Math.max(1, Math.floor(scroller.clientHeight / h)));
  });
  const marquee = createMarquee({
    scroller: () => scroller,
    tab: () => props.tab,
    positionsFor: (x1, y1, x2, y2) => cellsInRect(view().length, 1, Math.max(1, box().w), h, x1, y1, x2, y2),
  });

  return (
    <div
      ref={scroller}
      class="content-view"
      classList={{ "drop-list": ent.listDrop() }}
      onScroll={() => setScrollTop(scroller.scrollTop)}
      onContextMenu={(e) => props.onMenu(e, null)}
      onWheel={(e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        A.zoomView(props.tab, e.deltaY < 0 ? 1 : -1);
      }}
      onMouseDown={(e) => {
        const bg = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("content-rows");
        if (!bg || e.button !== 0) return;
        if (!e.ctrlKey && !e.shiftKey) props.tab.setSelection(new Set<number>());
        e.preventDefault();
        marquee.start(e);
      }}
      {...ent.background}
    >
      <div class="content-rows" style={{ height: `${view().length * h}px` }}>
        <Show when={marquee.box()}>
          {(b) => <div class="marquee" style={{ left: `${b().left}px`, top: `${b().top}px`, width: `${b().width}px`, height: `${b().height}px` }} />}
        </Show>
        <Index each={positions()}>
          {(pos) => {
            const entry = () => view()[pos()];
            const l = () => props.tab.listing();
            return (
              <Show when={entry() !== undefined}>
                <div
                  class="content-row"
                  classList={ent.classes(pos())}
                  style={{ height: `${h - 2}px`, transform: `translateY(${pos() * h}px)` }}
                  data-tooltip={l().names[entry()]}
                  data-tooltip-truncated=".content-name"
                  {...ent.handlers(pos)}
                >
                  <ItemPicture tab={props.tab} entry={entry()} size={CONTENT_ROW.thumb} />
                  <span class="content-text">
                    <span class="content-name">{shownName(props.tab, entry())}</span>
                    <span class="content-sub muted">
                      {[typeLabel(baseOf(l().names[entry()]), isDir(l(), entry())), sizeText(props.tab, entry()), formatDate(l().mtimes[entry()])].filter(Boolean).join("  ·  ")}
                    </span>
                  </span>
                </div>
              </Show>
            );
          }}
        </Index>
      </div>
      <ListState tab={props.tab} />
    </div>
  );
}

// ---- Bento: pictures keep their shape and fill every row; the one you hover or select grows, its neighbours give way.

/** Picture shapes (width / height) found as thumbnails load, so rows can be laid out to fit them. */
const shapes = new Map<string, number>();
const [shapeVersion, setShapeVersion] = createSignal(0);
let shapeFrame = 0;
const MAX_SHAPES = 20_000;
function noteShape(key: string, ratio: number) {
  if (!Number.isFinite(ratio) || ratio <= 0) return;
  const clamped = Math.min(2.4, Math.max(0.5, Math.round(ratio * 100) / 100));
  if (shapes.get(key) === clamped) return;
  if (shapes.size >= MAX_SHAPES) shapes.delete(shapes.keys().next().value as string);
  shapes.set(key, clamped);
  // Many thumbnails arrive together: re-lay out once per frame.
  if (!shapeFrame) shapeFrame = requestAnimationFrame(() => ((shapeFrame = 0), setShapeVersion((v) => v + 1)));
}

const DEFAULT_SHAPE = 1.33;
const FOLDER_SHAPE = 1.25;

interface BentoRow {
  readonly top: number;
  readonly height: number;
  /** View positions in this row. */
  readonly items: readonly number[];
  /** Whether the row is stretched to the full width (the last one is not). */
  readonly full: boolean;
}

/** A picture's thumbnail, filling its tile. Its shape is reported once known. */
function BentoPicture(props: { tab: TabModel; entry: number; px: number }) {
  const l = () => props.tab.listing();
  const path = () => props.tab.pathOf(props.entry);
  const key = () => `${path()}|${l().mtimes[props.entry]}`;
  const dir = () => isDir(l(), props.entry);
  const [url, setUrl] = createSignal<string | null>(null);
  createEffect(
    on(key, (k) => {
      setUrl(null);
      if (props.tab.archive() || !settings.showThumbnails()) return;
      if (cloudState(l().attrs[props.entry]) === "online") return;
      void loadThumb(`${k}|${props.px}|t`, path(), props.px, false).then((u) => {
        if (key() === k) setUrl(u);
      });
    }),
  );
  return (
    <Show when={url()} fallback={<span class="bento-fallback"><FileIcon name={l().names[props.entry]} isDir={dir()} size={34} /></span>}>
      {(u) => (
        <img
          src={u()}
          alt=""
          draggable={false}
          onLoad={(e) => !dir() && noteShape(key(), e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)}
        />
      )}
    </Show>
  );
}

export function BentoView(props: Omit<ViewProps, "onReady"> & { onReady: (columns: () => number, ensureVisible: (pos: number) => void, pageRows: () => number, vertical: (pos: number, dir: 1 | -1) => number) => void }) {
  const ent = useEntries(props);
  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [box, setBox] = createSignal({ w: 800, h: 600 });
  const view = () => props.tab.view();
  const targetHeight = () => bentoRowHeight(props.tab.iconSize());
  const innerWidth = () => Math.max(120, box().w - PAD * 2);

  const shapeOf = (pos: number) => {
    shapeVersion();
    const l = props.tab.listing();
    const e = view()[pos];
    if (e === undefined) return DEFAULT_SHAPE;
    if (isDir(l, e)) return FOLDER_SHAPE;
    return shapes.get(`${props.tab.pathOf(e)}|${l.mtimes[e]}`) ?? DEFAULT_SHAPE;
  };

  /** Rows of pictures: add pictures until the row is full, then shrink it a little so it fits the width exactly. */
  const layout = createMemo(() => {
    const W = innerWidth();
    const H = targetHeight();
    const rows: BentoRow[] = [];
    const rowOf = new Uint32Array(view().length);
    let items: number[] = [];
    let sum = 0;
    let top = 0;
    const close = (full: boolean) => {
      const scale = full ? (W - BENTO_GAP * (items.length - 1)) / (sum * H) : 1;
      const height = Math.round(H * scale);
      for (const p of items) rowOf[p] = rows.length;
      rows.push({ top, height, items, full });
      top += height + BENTO_GAP;
      items = [];
      sum = 0;
    };
    for (let p = 0; p < view().length; p++) {
      items.push(p);
      sum += shapeOf(p);
      if (sum * H + BENTO_GAP * (items.length - 1) >= W) close(true);
    }
    if (items.length) close(false);
    return { rows, rowOf, height: Math.max(0, top - BENTO_GAP) };
  });

  const visibleRows = createMemo(() => {
    const { rows } = layout();
    const from = scrollTop() - 200;
    const to = scrollTop() + box().h + 200;
    // Rows are in order, so the first one in view is found by halving.
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].top + rows[mid].height < from) lo = mid + 1;
      else hi = mid;
    }
    const out: number[] = [];
    for (let i = lo; i < rows.length && rows[i].top <= to; i++) out.push(i);
    return out;
  });

  const ensureVisible = (pos: number) => {
    const row = layout().rows[layout().rowOf[pos]];
    if (!row) return;
    if (row.top < scroller.scrollTop) scroller.scrollTop = row.top;
    else if (row.top + row.height > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = row.top + row.height - scroller.clientHeight;
  };

  /** The picture nearest, left to right, to one in the row above or below. */
  const vertical = (pos: number, dir: 1 | -1) => {
    const { rows, rowOf } = layout();
    const row = rows[rowOf[pos]];
    if (!row) return pos;
    const target = rows[rowOf[pos] + dir];
    if (!target) return pos;
    const total = (r: BentoRow) => r.items.reduce((n, p) => n + shapeOf(p), 0);
    let before = 0;
    for (const p of row.items) {
      if (p === pos) break;
      before += shapeOf(p);
    }
    const center = (before + shapeOf(pos) / 2) / total(row);
    let acc = 0;
    const targetTotal = total(target);
    for (const p of target.items) {
      acc += shapeOf(p);
      if (acc / targetTotal >= center) return p;
    }
    return target.items[target.items.length - 1];
  };

  onMount(() => {
    const ro = new ResizeObserver(() => setBox({ w: scroller.clientWidth, h: scroller.clientHeight }));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
    props.onReady(
      () => 1,
      ensureVisible,
      () => Math.max(1, Math.floor(scroller.clientHeight / (targetHeight() + BENTO_GAP))) * Math.max(1, Math.round(view().length / Math.max(1, layout().rows.length))),
      vertical,
    );
  });

  const marquee = createMarquee({
    scroller: () => scroller,
    tab: () => props.tab,
    positionsFor: (x1, y1, x2, y2) => {
      const [left, right] = [Math.min(x1, x2) - PAD, Math.max(x1, x2) - PAD];
      const [top, bottom] = [Math.min(y1, y2) - PAD, Math.max(y1, y2) - PAD];
      const W = innerWidth();
      const out: number[] = [];
      for (const row of layout().rows) {
        if (row.top > bottom || row.top + row.height < top) continue;
        const sum = row.items.reduce((n, p) => n + shapeOf(p), 0);
        let x = 0;
        for (const p of row.items) {
          const width = row.full ? ((W - BENTO_GAP * (row.items.length - 1)) * shapeOf(p)) / sum : shapeOf(p) * row.height;
          if (x + width >= left && x <= right) out.push(p);
          x += width + BENTO_GAP;
        }
      }
      return out;
    },
  });

  return (
    <div
      ref={scroller}
      class="bento-view"
      classList={{ "drop-list": ent.listDrop() }}
      onScroll={() => setScrollTop(scroller.scrollTop)}
      onContextMenu={(e) => props.onMenu(e, null)}
      onWheel={(e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        A.zoomView(props.tab, e.deltaY < 0 ? 1 : -1);
      }}
      onMouseDown={(e) => {
        const bg = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("bento-rows");
        if (!bg || e.button !== 0) return;
        if (!e.ctrlKey && !e.shiftKey) props.tab.setSelection(new Set<number>());
        e.preventDefault();
        marquee.start(e);
      }}
      {...ent.background}
    >
      <div class="bento-rows" style={{ height: `${layout().height}px` }}>
        <Show when={marquee.box()}>
          {(b) => <div class="marquee" style={{ left: `${b().left - PAD}px`, top: `${b().top - PAD}px`, width: `${b().width}px`, height: `${b().height}px` }} />}
        </Show>
        <Index each={visibleRows()}>
          {(rowIndex) => {
            const row = () => layout().rows[rowIndex()];
            return (
              <Show when={row()}>
                {(r) => (
                  <div class="bento-row" classList={{ full: r().full }} style={{ height: `${r().height}px`, transform: `translateY(${r().top}px)` }}>
                    <For each={r().items}>
                      {(pos) => {
                        const entry = () => view()[pos];
                        const l = () => props.tab.listing();
                        return (
                          <Show when={entry() !== undefined}>
                            <div
                              class="bento-item"
                              classList={ent.classes(pos)}
                              style={{ "--a": String(shapeOf(pos)), width: r().full ? undefined : `${Math.round(shapeOf(pos) * r().height)}px` }}
                              data-tooltip={l().names[entry()]}
                              {...ent.handlers(() => pos)}
                            >
                              <BentoPicture tab={props.tab} entry={entry()} px={thumbBucket(r().height * 1.6)} />
                              <span class="bento-label">{shownName(props.tab, entry())}</span>
                            </div>
                          </Show>
                        );
                      }}
                    </For>
                  </div>
                )}
              </Show>
            );
          }}
        </Index>
      </div>
      <ListState tab={props.tab} />
    </div>
  );
}
