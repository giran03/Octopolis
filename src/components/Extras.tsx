// Portal Dropzone shelf, settings dialog, text prompt, grid and Miller views.
import { createEffect, createMemo, createResource, createSignal, For, Index, on, onCleanup, onMount, Show } from "solid-js";
import * as A from "../actions";
import { formatSize } from "../lib/format";
import { listDir, thumbnail } from "../lib/ipc";
import { baseOf, createBuilder, decodeBatch, isDir, snapshot, type Listing } from "../lib/listing";
import { baseName, joinPath, parentPath } from "../lib/paths";
import { selectAt } from "../lib/selection";
import { BUILT_IN_THEMES, DENSITIES, parseTheme, type Density } from "../lib/themes";
import { settings } from "../state/settings";
import { shelf } from "../state/shelf";
import type { TabModel } from "../state/tab";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";
import { IconClose } from "./Icons";

const DRAG_MIME = "application/x-octopolis-paths";

export function Shelf() {
  const dest = () => workspace.activeTab()?.path() ?? "";
  const [over, setOver] = createSignal(false);
  return (
    <div
      class="shelf"
      classList={{ open: shelf.open(), over: over() }}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes(DRAG_MIME)) {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const raw = e.dataTransfer?.getData(DRAG_MIME);
        if (!raw) return;
        e.preventDefault();
        e.stopPropagation();
        shelf.add(JSON.parse(raw) as string[]);
      }}
    >
      <button class="shelf-tab" title="Shelf (Ctrl+Shift+D adds the selection)" onClick={() => shelf.setOpen(!shelf.open())}>
        Shelf <span class="shelf-count">{shelf.items().length}</span>
      </button>
      <Show when={shelf.open()}>
        <div class="shelf-body">
          <div class="shelf-list">
            <For each={shelf.items()} fallback={<p class="muted small">Drag files here from any folder.</p>}>
              {(p) => (
                <div class="shelf-item" title={p}>
                  <span>{baseName(p)}</span>
                  <button class="icon-btn" aria-label={`Remove ${baseName(p)}`} onClick={() => shelf.remove(p)}>
                    <IconClose size={11} />
                  </button>
                </div>
              )}
            </For>
          </div>
          <div class="shelf-actions">
            <button class="btn small" disabled={!shelf.items().length} onClick={() => shelf.deliver("copy", dest())}>Copy here</button>
            <button class="btn small" disabled={!shelf.items().length} onClick={() => shelf.deliver("move", dest())}>Move here</button>
            <button class="btn small" disabled={!shelf.items().length} onClick={shelf.clear}>Clear</button>
          </div>
        </div>
      </Show>
    </div>
  );
}

export function SettingsDialog() {
  const [json, setJson] = createSignal("");
  const close = () => ui.setSettingsOpen(false);
  const importTheme = () => {
    try {
      const t = parseTheme(json());
      settings.setCustomTheme(t);
      settings.setTheme(t.name);
      setJson("");
      ui.toast(`Theme "${t.name}" applied`);
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    }
  };
  const themes = () => [...BUILT_IN_THEMES, ...(settings.customTheme() ? [settings.customTheme()!] : [])];
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="dialog settings" role="dialog" aria-label="Settings" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); }}>
        <h2>Settings</h2>
        <div class="settings-grid">
          <label>Theme
            <select class="text-input" value={settings.theme()} onChange={(e) => settings.setTheme(e.currentTarget.value)}>
              <option value="System">Follow Windows</option>
              <For each={themes()}>{(t) => <option value={t.name}>{t.name}</option>}</For>
            </select>
          </label>
          <label>Accent color
            <span class="row-inline">
              <input type="color" value={settings.accent() ?? "#6d8cff"} onInput={(e) => settings.setAccent(e.currentTarget.value)} />
              <button class="btn small" onClick={() => settings.setAccent(null)}>Theme default</button>
            </span>
          </label>
          <label>Text size
            <input type="range" min="85" max="130" step="5" value={settings.uiScale()} onInput={(e) => settings.setUiScale(Number(e.currentTarget.value))} />
          </label>
          <label>List density
            <select class="text-input" value={settings.density()} onChange={(e) => settings.setDensity(e.currentTarget.value as Density)}>
              <For each={Object.keys(DENSITIES)}>{(d) => <option value={d}>{d[0].toUpperCase() + d.slice(1)}</option>}</For>
            </select>
          </label>
          <label>Transfer speed limit
            <select class="text-input" value={String(settings.speedLimit() ?? "")} onChange={(e) => settings.setSpeedLimit(e.currentTarget.value ? Number(e.currentTarget.value) : null)}>
              <option value="">Unlimited</option>
              <For each={[10, 50, 100, 500]}>{(mb) => <option value={String(mb * 1048576)}>{mb} MB/s</option>}</For>
            </select>
          </label>
          <div class="settings-checks">
            <label class="check"><input type="checkbox" checked={settings.verifyCopies()} onChange={settings.toggleVerify} /> Verify copies with checksums</label>
            <label class="check"><input type="checkbox" checked={settings.showCommits()} onChange={settings.toggleCommits} /> Show last commit column in Git folders</label>
            <label class="check"><input type="checkbox" checked={settings.vimMode()} onChange={settings.toggleVim} /> Vim keys</label>
          </div>
        </div>
        <label class="settings-import">Import a theme (JSON with "name", "scheme" and "tokens")
          <textarea class="text-input" rows="3" spellcheck={false} value={json()} onInput={(e) => setJson(e.currentTarget.value)} />
        </label>
        <div class="dialog-actions">
          <button class="btn" disabled={!json().trim()} onClick={importTheme}>Import theme</button>
          <button class="btn primary" onClick={close}>Done</button>
        </div>
      </div>
    </div>
  );
}

export function PromptDialog(props: { title: string; label: string; onSubmit: (value: string) => void }) {
  let input!: HTMLInputElement;
  onMount(() => input.focus());
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
        <label class="settings-import">{props.label}<input ref={input} class="text-input" spellcheck={false} /></label>
        <div class="dialog-actions">
          <button class="btn" onClick={() => ui.closePrompt()}>Cancel</button>
          <button class="btn primary" onClick={submit}>Save</button>
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
const pendingThumbs = new Map<string, Promise<string | null>>();

function loadThumb(key: string, path: string): Promise<string | null> {
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
          }
          const u = URL.createObjectURL(new Blob([b], { type: "image/png" }));
          thumbs.set(key, u);
          return u;
        },
        () => null,
      )
      .finally(() => pendingThumbs.delete(key));
    pendingThumbs.set(key, pending);
  }
  return pending;
}

function GridThumb(props: { path: string; modified: number; virtual: boolean; name: string; dir: boolean }) {
  const [url, setUrl] = createSignal<string | null>(null);
  const key = () => `${props.path}|${props.modified}`;
  createEffect(
    on(key, (k) => {
      setUrl(null);
      if (props.virtual) return;
      void loadThumb(k, props.path).then((u) => {
        if (key() === k) setUrl(u);
      });
    }),
  );
  return (
    <div class="grid-thumb">
      <Show when={url()} fallback={<span class="grid-fallback">{props.dir ? "📁" : "📄"}</span>}>
        {(u) => <img src={u()} alt="" draggable={false} />}
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

  const click = (e: MouseEvent, pos: number) => {
    const t = props.tab;
    const r = selectAt(view(), t.selection(), t.anchor(), pos, { ctrl: e.ctrlKey, shift: e.shiftKey });
    t.setSelection(r.selection);
    t.setAnchor(r.anchor);
    t.setFocus(pos);
  };

  return (
    <div ref={scroller} class="grid-view" onScroll={() => setScrollTop(scroller.scrollTop)} onContextMenu={(e) => props.onMenu(e, null)}>
      <div class="grid-rows" style={{ height: `${rows() * CELL_H}px` }}>
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
                  onMouseDown={(e) => e.button === 0 && click(e, pos())}
                  onDblClick={() => A.openEntry(props.tab, entry())}
                  onContextMenu={(e) => {
                    e.stopPropagation();
                    props.onMenu(e, pos());
                  }}
                  title={l().names[entry()]}
                >
                  <GridThumb path={props.tab.pathOf(entry())} modified={l().mtimes[entry()]} virtual={!!props.tab.archive()} name={l().names[entry()]} dir={isDir(l(), entry())} />
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

const MILLER_ROW_LIMIT = 3000;

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

function MillerColumn(props: { path: string; selected: string | null; onPick: (path: string, dir: boolean) => void; onOpen: (path: string) => void }) {
  const [listing] = createResource(() => props.path, readFolder);
  return (
    <div class="miller-col">
      <Show when={listing()} fallback={<p class="muted small miller-msg">{listing.loading ? "Loading…" : "Can't read this folder"}</p>}>
        {(l) => (
          <For each={sortedEntries(l())}>
            {(i) => {
              const full = joinPath(l().path, l().names[i]);
              const dir = isDir(l(), i);
              return (
                <button
                  class="miller-row"
                  classList={{ selected: props.selected?.toLowerCase() === l().names[i].toLowerCase() }}
                  onClick={() => props.onPick(full, dir)}
                  onDblClick={() => props.onOpen(full)}
                  title={l().names[i]}
                >
                  <span class="miller-name">{l().names[i]}</span>
                  <Show when={dir} fallback={<span class="muted small">{formatSize(l().sizes[i])}</span>}>
                    <span class="muted">›</span>
                  </Show>
                </button>
              );
            }}
          </For>
        )}
      </Show>
    </div>
  );
}

/** macOS-style columns: the current folder, its parents, and the next level. */
export function MillerView(props: { tab: TabModel }) {
  let box!: HTMLDivElement;
  const [preview, setPreview] = createSignal<string | null>(null);
  const columns = createMemo(() => {
    const chain = [props.tab.path()];
    for (let p = parentPath(props.tab.path()); p && chain.length < 3; p = parentPath(p)) chain.unshift(p);
    return chain;
  });
  createEffect(on(() => props.tab.path(), () => {
    setPreview(null);
    queueMicrotask(() => (box.scrollLeft = box.scrollWidth));
  }));
  const pick = (path: string, dir: boolean) => {
    if (dir) void props.tab.navigate(path);
    else props.tab.selectNames([baseName(path)]);
  };
  const selectedIn = (i: number) => (columns()[i + 1] ? baseName(columns()[i + 1]) : (preview() ? baseName(preview()!) : null));
  return (
    <div ref={box} class="miller">
      <Index each={columns()}>
        {(c, i) => <MillerColumn path={c()} selected={selectedIn(i)} onPick={pick} onOpen={(p) => A.openFromPath(props.tab, p)} />}
      </Index>
    </div>
  );
}
