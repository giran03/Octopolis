// Text prompt, grid and Miller views.
import { createEffect, createMemo, createResource, createSignal, Index, on, onCleanup, onMount, Show } from "solid-js";
import * as A from "../actions";
import { formatSize } from "../lib/format";
import { listDir, thumbnail } from "../lib/ipc";
import { baseOf, createBuilder, decodeBatch, isDir, snapshot, type Listing } from "../lib/listing";
import { baseName, joinPath, parentPath } from "../lib/paths";
import { selectAt } from "../lib/selection";
import { settings } from "../state/settings";
import type { TabModel } from "../state/tab";
import { folderIcons } from "../state/folderIcons";
import { FileIcon, FolderEmoji } from "./Icons";
import { thumbBucket } from "../lib/viewZoom";
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
    <div class="scrim scrim-top" onMouseDown={(e) => e.target === e.currentTarget && ui.closePrompt()}>
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

const MAX_THUMBS = 1500;
/** Icons and thumbnails asked of Windows at once: a picker full of them must not flood the shell. */
const MAX_AT_ONCE = 8;
let running = 0;
const waiting: (() => void)[] = [];
const turn = async <T,>(job: () => Promise<T>): Promise<T> => {
  if (running >= MAX_AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await job();
  } finally {
    running--;
    waiting.shift()?.();
  }
};
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

export function loadThumb(key: string, path: string, px: number, iconOnly = false): Promise<string | null> {
  if (!settings.showThumbnails()) return Promise.resolve(null);
  const known = thumbs.get(key);
  if (known) {
    thumbs.delete(key);
    thumbs.set(key, known); // mark as recently used
    return Promise.resolve(known);
  }
  let pending = pendingThumbs.get(key);
  if (!pending) {
    pending = turn(() => thumbnail(path, px, iconOnly))
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

/** The picture of an item at `size` pixels: its thumbnail (made in a few set sizes, so zooming reuses them), else its icon. */
export function GridThumb(props: { path: string; modified: number; virtual: boolean; name: string; dir: boolean; online?: boolean; size: number }) {
  const [url, setUrl] = createSignal<string | null>(null);
  const px = () => thumbBucket(props.size);
  // A folder can wear the Windows icon of a special folder; its picture is then that folder's.
  const source = () => (props.dir ? folderIcons.source(props.path) : undefined);
  const key = () => `${source() ?? props.path}|${props.modified}|${px()}|${source() ? "i" : "t"}`;
  createEffect(
    on(key, (k) => {
      setUrl(null);
      // Reading an online-only file would download it just to draw a thumbnail.
      if (props.virtual || props.online) return;
      void loadThumb(k, source() ?? props.path, px(), source() !== undefined).then((u) => {
        if (key() === k) setUrl(u);
      });
    }),
  );
  const iconPx = () => Math.round(Math.min(96, Math.max(16, props.size * 0.42)));
  return (
    <div class="grid-thumb" style={{ width: `${props.size}px`, height: `${props.size}px`, "--thumb": `${props.size}px` }}>
      <Show when={props.dir && folderIcons.get(props.path)} fallback={
        <Show when={url()} fallback={<span class="grid-fallback"><FileIcon name={props.name} isDir={props.dir} size={iconPx()} /></span>}>
          {(u) => <img src={u()} alt="" draggable={false} />}
        </Show>
      }>
        {(e) => <span class="grid-fallback"><FolderEmoji emoji={e()} size={Math.round(iconPx() * 1.1)} /></span>}
      </Show>
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
  const rowPx = () => settings.rowPx();
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
