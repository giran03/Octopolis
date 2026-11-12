// Virtualized details list. Only the visible rows (plus overscan) exist in the
// DOM; the same row nodes are reused as the list scrolls.
import { createEffect, createMemo, createSignal, For, Index, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import * as A from "../actions";
import { formatDate, formatSize, typeLabel } from "../lib/format";
import { ATTR_REPARSE, baseOf, cloudState, dirOf, isDir, isHidden } from "../lib/listing";
import { attributeLetters, clampWidth, columnDef, DEFAULT_COLUMNS, gridTemplate, OPTIONAL_COLUMNS, toggleColumn, visibleColumns, type ColumnKey } from "../lib/columns";
import { baseName, extensionOf, joinPath, parentPath, sameVolume, samePath, stemLength } from "../lib/paths";
import { rowsInBand, selectAt } from "../lib/selection";
import { createMarquee } from "./marquee";
import { createDirTags, TagMarks } from "./Tags";
import type { SortKey } from "../lib/sort";
import { compare } from "../state/compare";
import { ops } from "../state/ops";
import type { TabModel } from "../state/tab";
import { ui, type MenuEntry } from "../state/ui";
import { DENSITIES } from "../lib/themes";
import { settings } from "../state/settings";
import { sidebar } from "../state/sidebar";
import { isPinned } from "../lib/sidebar";
import { iconFor } from "../state/icons";
import { cancelSpring, DRAG_MIME, dragState, springLoad } from "../state/drag";
import { fileIconSpec } from "../lib/fileicons";
import { FileGlyph, FileIcon, FolderEmoji, Glyph } from "./Icons";
import { folderIcons } from "../state/folderIcons";

/** Row height in pixels, from the density setting. */
const rowHeight = () => DENSITIES[settings.density()];
const OVERSCAN = 6;

/** Scroll offset per tab, so switching tabs returns to the same place. */
const scrollMemory = new WeakMap<TabModel, number>();
/** Paths being dragged (dragover can't read the payload, only its types). */
let dragging: readonly string[] = [];
let draggingArchive: string | null = null;

/** A sortable column header. */
function HeadButton(props: { label: string; sortKey: SortKey; tab: TabModel; end?: boolean }) {
  const sorted = () => props.tab.sort().key === props.sortKey;
  return (
    <button
      class={`col-head col-${props.sortKey}`}
      role="columnheader"
      aria-sort={sorted() ? (props.tab.sort().dir === 1 ? "ascending" : "descending") : "none"}
      classList={{ end: props.end, sorted: sorted() }}
      onClick={() => props.tab.sortBy(props.sortKey)}
    >
      <span>{props.label}</span>
      <Show when={sorted()}>
        <span class="sort-arrow">{props.tab.sort().dir === 1 ? <Glyph code="E70E" size={9} /> : <Glyph code="E70D" size={9} />}</span>
      </Show>
    </button>
  );
}

export interface ListHandle {
  ensureVisible: (pos: number) => void;
  pageRows: () => number;
  /** Grid view only: items per row. */
  columns?: () => number;
}

let listSerial = 0;

export function FileList(props: { tab: TabModel; active: boolean; onReady: (h: ListHandle) => void }) {
  let scroller!: HTMLDivElement;
  /** Row ids for aria-activedescendant, unique per list. */
  const idBase = ++listSerial;
  const rowId = (pos: number) => `fl${idBase}-r${pos}`;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(600);
  const [dropTarget, setDropTarget] = createSignal<number | "list" | null>(null);
  const [dropCopy, setDropCopy] = createSignal(false);
  /** A ghost row at the end of the list previews dropped items landing in this folder. */
  const ghostItems = () =>
    dropTarget() === "list" && !tab().archive() ? dragState.paths : [];
  const showGhost = () => ghostItems().some((p) => !samePath(parentPath(p) ?? "", tab().path()));

  const tab = () => props.tab;
  const showCommitColumn = () => settings.showCommits() && !!tab().git();
  const view = () => tab().view();
  const first = () => Math.max(0, Math.floor(scrollTop() / rowHeight()) - OVERSCAN);
  const slotCount = () => Math.max(0, Math.min(view().length - first(), Math.ceil(height() / rowHeight()) + OVERSCAN * 2));
  const slots = createMemo(() => Array.from({ length: slotCount() }, (_, i) => i));

  const ensureVisible = (pos: number) => {
    const top = pos * rowHeight();
    const bottom = top + rowHeight();
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
  };

  // Tags of the items in this folder (search results span folders, so they show none).
  const dirTags = createDirTags(() => (tab().search() || tab().archive() ? null : tab().path()));

  // ----- columns -----
  const [paneWidth, setPaneWidth] = createSignal(0);
  /** Widths while a resize drag is under way; saved to settings when it ends. */
  const [dragWidths, setDragWidths] = createSignal<Readonly<Record<string, number>> | null>(null);
  const widths = () => dragWidths() ?? settings.columnWidths();
  const columns = createMemo(() => visibleColumns(settings.fileColumns(), paneWidth(), showCommitColumn()));
  const startResize = (e: PointerEvent, key: ColumnKey) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = widths()[key] ?? columnDef(key).width;
    const scale = settings.uiScale() / 100;
    // The handle sits on the column's left edge, so dragging left widens it.
    const move = (m: PointerEvent) => setDragWidths({ ...settings.columnWidths(), [key]: clampWidth(key, startW + (startX - m.clientX) / scale) });
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      const done = dragWidths();
      setDragWidths(null);
      if (done) settings.set({ columnWidths: done });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const resetWidth = (key: ColumnKey) => {
    const { [key]: _gone, ...rest } = settings.columnWidths();
    settings.set({ columnWidths: rest });
  };
  const headerMenu = (e: MouseEvent) => {
    e.preventDefault();
    const shown = new Set(settings.fileColumns());
    ui.openMenu(e.clientX, e.clientY, [
      ...OPTIONAL_COLUMNS.map((key) => ({
        label: `${shown.has(key) ? "✓ " : "    "}${columnDef(key).label}`,
        run: () => settings.set({ fileColumns: toggleColumn(settings.fileColumns(), key) }),
      })),
      "separator" as const,
      { label: "Reset columns", run: () => settings.set({ fileColumns: [...DEFAULT_COLUMNS], columnWidths: {} }) },
    ]);
  };

  onMount(() => {
    const widthObserver = new ResizeObserver(() => setPaneWidth(scroller.clientWidth));
    widthObserver.observe(scroller);
    onCleanup(() => widthObserver.disconnect());
    const ro = new ResizeObserver(() => setHeight(scroller.clientHeight));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
    scroller.scrollTop = scrollMemory.get(tab()) ?? 0;
    setScrollTop(scroller.scrollTop);
    props.onReady({ ensureVisible, pageRows: () => Math.floor(scroller.clientHeight / rowHeight()) });
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

  const contextRow = (e: MouseEvent, pos: number | null) => contextMenu(tab(), e, pos);

  // Drag a box from empty space or from any column but the name to select rows.
  const marquee = createMarquee({
    scroller: () => scroller,
    tab,
    positionsFor: (_x1, y1, _x2, y2) => {
      const band = rowsInBand(view().length, rowHeight(), y1, y2);
      return band ? Array.from({ length: band[1] - band[0] + 1 }, (_, i) => band[0] + i) : [];
    },
  });

  // ----- drag and drop -----
  const dragStart = (e: DragEvent, pos: number) => {
    const t = tab();
    if (!t.selection().has(view()[pos])) {
      t.setSelection(new Set([view()[pos]]));
      t.setFocus(pos);
    }
    dragging = t.selectedPaths();
    draggingArchive = t.archive();
    dragState.paths = dragging;
    dragState.archive = draggingArchive;
    dragState.dirs = !t.archive() ? [...t.selection()].filter((i) => isDir(t.listing(), i)).map((i) => t.pathOf(i)) : [];
    dragState.allDirs = !t.archive() && [...t.selection()].every((i) => isDir(t.listing(), i));
    e.dataTransfer!.setData(DRAG_MIME, JSON.stringify(dragging));
    e.dataTransfer!.effectAllowed = "copyMove";
  };
  const destFor = (target: number | "list") => (target === "list" ? tab().path() : tab().pathOf(view()[target]));
  const dragOver = (e: DragEvent, target: number | "list") => {
    if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
    if (target !== "list" && !isDir(tab().listing(), view()[target])) target = "list";
    const dest = destFor(target);
    // Resting on a folder opens it, so the drop can go deeper.
    if (target === "list" || tab().archive()) cancelSpring();
    else springLoad(`row:${dest}`, () => void tab().navigate(dest));
    if (dragging.some((p) => p.toLowerCase() === dest.toLowerCase())) return; // onto itself
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.ctrlKey || dragging.some((s) => !sameVolume(s, dest)) ? "copy" : "move";
    setDropCopy(e.dataTransfer.dropEffect === "copy");
    setDropTarget(target);
  };
  const drop = (e: DragEvent) => {
    cancelSpring();
    const target = dropTarget();
    setDropTarget(null);
    if (target === null) return;
    e.preventDefault();
    e.stopPropagation();
    const paths: string[] = JSON.parse(e.dataTransfer?.getData(DRAG_MIME) || "[]");
    A.dropPaths(paths, destFor(target), e.ctrlKey, draggingArchive, !!tab().archive());
  };

  return (
    <div
      class="filelist"
      classList={{ active: props.active }}
      style={{ "--cols": gridTemplate(columns(), widths()) }}
      role="grid"
      tabIndex={0}
      aria-label={baseName(tab().path()) || tab().path()}
      aria-multiselectable="true"
      aria-rowcount={view().length + 1}
      aria-activedescendant={view().length ? rowId(tab().focus()) : undefined}
    >
      <div class="filelist-head" role="row" onContextMenu={headerMenu}>
        <HeadButton label="Name" sortKey="name" tab={tab()} />
        <For each={columns()}>
          {(key) => {
            const def = columnDef(key);
            return (
              <div class={`col-head-wrap col-${key}`}>
                <span class="col-resizer" title="Drag to resize. Double-click to reset" onPointerDown={(e) => startResize(e, key)} onDblClick={() => resetWidth(key)} />
                <Show when={def.sort} fallback={<div class="col-head" role="columnheader" classList={{ end: def.align === "end" }}>{def.label}</div>}>
                  <HeadButton label={def.label} sortKey={def.sort!} tab={tab()} end={def.align === "end"} />
                </Show>
              </div>
            );
          }}
        </For>
      </div>
      <div
        ref={scroller}
        class="filelist-body"
        classList={{ "drop-list": dropTarget() === "list" }}
        role="rowgroup"
        onScroll={onScroll}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("rows")) {
            if (!e.ctrlKey && !e.shiftKey) tab().setSelection(new Set<number>());
            if (e.button === 0) {
              e.preventDefault();
              marquee.start(e);
            }
          }
        }}
        onContextMenu={(e) => contextRow(e, null)}
        onDragOver={(e) => dragOver(e, "list")}
        onDragLeave={(e) => e.currentTarget === e.target && setDropTarget(null)}
        onDrop={drop}
      >
        <div class="rows" style={{ height: `${view().length * rowHeight()}px` }}>
          <Show when={marquee.box()}>
            {(b) => <div class="marquee" style={{ left: `${b().left}px`, top: `${b().top}px`, width: `${b().width}px`, height: `${b().height}px` }} />}
          </Show>
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
                    id={rowId(pos())}
                    aria-rowindex={pos() + 2}
                    aria-selected={tab().selection().has(entry())}
                    draggable={tab().renaming() !== entry()}
                    style={{ transform: `translateY(${pos() * rowHeight()}px)` }}
                    classList={{
                      selected: tab().selection().has(entry()),
                      focused: props.active && tab().focus() === pos(),
                      dim: isHidden(l(), entry()) || ops.isCut(joinPath(l().path, name())),
                      "drop-row": dropTarget() === pos(),
                      [`cmp-${compare.statusOf(tab())?.get(baseOf(name()).toLowerCase()) ?? "none"}`]: !!compare.statusOf(tab()),
                    }}
                    onMouseDown={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        return A.openEntryInTab(tab(), entry(), !e.shiftKey);
                      }
                      clickRow(e, pos());
                      // Dragging from the name moves files; from anywhere else it draws a selection box.
                      const onName = (e.target as HTMLElement).closest(".cell.name, input");
                      if (e.button === 0 && !onName && !e.shiftKey) {
                        e.preventDefault();
                        marquee.start(e);
                      }
                    }}
                    onDblClick={(e) => (e.ctrlKey ? A.openEntryInTab(tab(), entry(), !e.shiftKey) : A.openEntry(tab(), entry()))}
                    onContextMenu={(e) => {
                      e.stopPropagation();
                      contextRow(e, pos());
                    }}
                    onDragStart={(e) => dragStart(e, pos())}
                    onDragOver={(e) => dragOver(e, pos())}
                    onDragEnd={() => {
                      dragging = [];
                      dragState.dirs = [];
                      cancelSpring();
                      setDropTarget(null);
                    }}
                  >
                    <div role="gridcell" class="cell name">
                      <RowIcon path={tab().pathOf(entry())} name={baseOf(name())} isDir={dir()} virtual={!!tab().archive()} link={(l().attrs[entry()] & ATTR_REPARSE) !== 0} />
                      <Show when={tab().renaming() === entry()} fallback={<><NameLabel name={name()} /><GitBadge tab={tab()} name={name()} /><CloudBadge attrs={l().attrs[entry()]} /><TagMarks tags={dirTags()?.get(baseOf(name()).toLowerCase())} /></>}>
                        <RenameInput name={baseOf(name())} isDir={dir()} onDone={(v) => (v === null ? tab().setRenaming(null) : void A.commitRename(tab(), entry(), v))} />
                      </Show>
                    </div>
                    <For each={columns()}>
                      {(key) => (
                        <Switch>
                          <Match when={key === "modified"}>
                            <div role="gridcell" class="cell muted col-modified">{formatDate(l().mtimes[entry()])}</div>
                          </Match>
                          <Match when={key === "type"}>
                            <div role="gridcell" class="cell muted col-type">{typeLabel(baseOf(name()), dir())}</div>
                          </Match>
                          <Match when={key === "size"}>
                            <SizeCell tab={tab()} entry={entry()} name={name()} dir={dir()} />
                          </Match>
                          <Match when={key === "extension"}>
                            <div role="gridcell" class="cell muted col-extension">{dir() ? "" : extensionOf(name())}</div>
                          </Match>
                          <Match when={key === "attributes"}>
                            <div role="gridcell" class="cell muted col-attributes num">{attributeLetters(l().attrs[entry()])}</div>
                          </Match>
                          <Match when={key === "commit"}>
                            <CommitCell tab={tab()} name={name()} />
                          </Match>
                        </Switch>
                      )}
                    </For>
                  </div>
                </Show>
              );
            }}
          </Index>
        </div>
        <Show when={showGhost()}>
          <div class="row ghost-row" aria-hidden="true">
            <div role="gridcell" class="cell name">
              <Show
                when={ghostItems().length === 1}
                fallback={
                  <>
                    <FileGlyph category="folder" size={18} />
                    <span class="label">{ghostItems().length} items</span>
                  </>
                }
              >
                <RowIcon path={ghostItems()[0]} name={baseName(ghostItems()[0])} isDir={dragState.dirs.includes(ghostItems()[0])} virtual={false} link={false} />
                <span class="label">{baseName(ghostItems()[0])}</span>
              </Show>
            </div>
            <div role="gridcell" class="cell muted col-modified" />
            <div role="gridcell" class="cell muted col-type">{dropCopy() ? "Copy here" : "Move here"}</div>
            <div role="gridcell" class="cell muted" />
          </div>
        </Show>
        <ListState tab={tab()} />
      </div>
    </div>
  );
}

/** Where the last context menu opened, so a follow-up menu can open in the same place. */
let menuX = 0;
let menuY = 0;

/** Opens the curated context menu for a position (null: the background). */
export function contextMenu(t: TabModel, e: MouseEvent, pos: number | null) {
  e.preventDefault();
  const v = t.view();
  if (pos !== null && !t.selection().has(v[pos])) {
    t.setSelection(new Set([v[pos]]));
    t.setAnchor(pos);
    t.setFocus(pos);
  }
  if (pos === null) t.setSelection(new Set<number>());
  menuX = e.clientX;
  menuY = e.clientY;
  ui.openMenu(e.clientX, e.clientY, menuFor(t, pos !== null));
}

const SKELETON_WIDTHS = [34, 52, 28, 44, 38, 56, 30, 48, 36, 42];

function ListState(props: { tab: TabModel }) {
  const s = () => props.tab.status();
  const empty = () => props.tab.view().length === 0;
  return (
    <>
    <Show when={empty() && s().loading && !s().error}>
      <div class="skel" aria-hidden="true">
        <For each={SKELETON_WIDTHS}>
          {(w) => (
            <div class="skel-row" style={{ "--w": `${w}%` }}>
              <span />
              <span />
            </div>
          )}
        </For>
      </div>
    </Show>
    <Show when={empty() && !(s().loading && !s().error)}>
      <div class="list-state">
        <Show
          when={s().error}
          fallback={<span>{props.tab.filter() ? "No items match the filter" : "This folder is empty"}</span>}
        >
          <span class="error-text">{s().error}</span>
          <button class="btn" onClick={() => void props.tab.refresh()}>Try again</button>
        </Show>
      </div>
    </Show>
    </>
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

/** "Open in new tab" when exactly one folder (or archive) is selected. */
function openInTabEntry(tab: TabModel): MenuEntry[] {
  const picked = [...tab.selection()];
  if (picked.length !== 1) return [];
  const l = tab.listing();
  if (!isDir(l, picked[0]) && !A.ARCHIVE_NAME.test(l.names[picked[0]])) return [];
  return [{ label: "Open in new tab", shortcut: "Middle-click", run: () => A.openEntryInTab(tab, picked[0], false) }];
}

/** "Open with…" and "Run as administrator" for a single file outside archives. */
function fileOpenEntries(tab: TabModel): MenuEntry[] {
  const picked = [...tab.selection()];
  if (picked.length !== 1 || tab.archive() || isDir(tab.listing(), picked[0])) return [];
  const name = tab.listing().names[picked[0]];
  return [
    { label: "Open with…", run: () => A.openWithDialog(tab) },
    { label: "Open in editor", shortcut: "Ctrl+Shift+O", run: () => A.editSelection(tab) },
    ...(A.ADMIN_RUNNABLE.test(name) ? [{ label: "Run as administrator", run: () => A.runSelectedAsAdmin(tab) }] : []),
  ];
}

/** "Pin to sidebar" when exactly one folder is selected. */
function pinEntry(tab: TabModel): MenuEntry[] {
  const picked = [...tab.selection()];
  if (picked.length !== 1 || !isDir(tab.listing(), picked[0])) return [];
  const path = tab.pathOf(picked[0]);
  return [{ label: isPinned(sidebar.pins(), path) ? "Unpin from sidebar" : "Pin to sidebar", run: () => sidebar.togglePin(path) }];
}

/** "Change icon…" for a single selected folder, plus a way back to the default. */
function folderIconEntries(tab: TabModel): MenuEntry[] {
  const path = A.singleFolderPath(tab);
  if (!path) return [];
  return [
    { label: "Change icon…", run: () => ui.setEmojiTarget(path) },
    ...(folderIcons.get(path) ? [{ label: "Reset icon", run: () => folderIcons.set(path, null) }] : []),
  ];
}

function menuFor(tab: TabModel, onItems: boolean): MenuEntry[] {
  const hasClip = ops.canPaste();
  const single = tab.selection().size === 1;
  const items: MenuEntry[] = onItems
    ? [
        // Open & launch
        { label: "Open", shortcut: "Enter", run: () => A.openSelection(tab) },
        ...openInTabEntry(tab),
        ...fileOpenEntries(tab),
        "separator",
        // Clipboard
        { label: "Cut", shortcut: "Ctrl+X", run: () => A.copySelection(tab, "cut") },
        { label: "Copy", shortcut: "Ctrl+C", run: () => A.copySelection(tab, "copy") },
        { label: "Paste", shortcut: "Ctrl+V", disabled: !hasClip, run: () => A.pasteInto(tab) },
        "separator",
        // Rename & paths
        { label: "Rename", shortcut: "F2", disabled: !single, run: () => A.startRename(tab) },
        { label: "Batch rename…", disabled: tab.selection().size < 2, run: () => A.openBatchRename(tab) },
        { label: "Copy path", shortcut: "Ctrl+Shift+C", run: () => void A.copyPaths(tab) },
        { label: "Copy as…", run: () => A.openCopyAsMenu(tab, menuX, menuY) },
        "separator",
        // Transfer & archive
        { label: "Add to shelf", shortcut: "Ctrl+Shift+D", run: () => A.addToShelf(tab) },
        ...(A.otherPaneTab() ? [{ label: "Copy to the other pane", shortcut: "Ctrl+Shift+→", run: () => A.sendToOtherPane(tab, "copy") }, { label: "Move to the other pane", run: () => A.sendToOtherPane(tab, "move") }] : []),
        ...(tab.archive() ? [{ label: "Extract next to the archive", run: () => A.extractHere(tab) }] : [{ label: "Compress to…", run: () => A.openCompressMenu(tab, menuX, menuY) }]),
        "separator",
        // Organize & customize
        ...(tab.archive() ? [] : [{ label: "Tags…", shortcut: "Ctrl+Shift+G", run: () => A.editTags(tab) }]),
        ...pinEntry(tab),
        ...folderIconEntries(tab),
        ...(tab.archive() ? [] : [{ label: "Actions…", run: () => A.openActionsMenu(tab, menuX, menuY) }]),
        ...cloudEntries(tab),
        "separator",
        // Git
        ...gitEntries(tab),
        "separator",
        // Inspect & system
        { label: "Show in Explorer", run: () => A.reveal(tab) },
        { label: "What is locking this?", run: () => A.whoLocks(tab) },
        { label: "Properties", shortcut: "Alt+Enter", run: () => A.showProperties(tab) },
        { label: "More options (Windows menu)", shortcut: "Shift+F10", run: () => A.nativeContextMenu(tab) },
        "separator",
        // Destructive
        { label: "Delete", shortcut: "Del", run: () => A.deleteSelection(tab, false) },
        { label: "Delete permanently", shortcut: "Shift+Del", danger: true, run: () => A.deleteSelection(tab, true) },
      ]
    : [
        // Clipboard
        { label: "Paste", shortcut: "Ctrl+V", disabled: !hasClip, run: () => A.pasteInto(tab) },
        { label: "Paste as link…", disabled: !(ops.clip()?.paths.length && !ops.clip()?.archive), run: () => A.openPasteAsLinkMenu(tab, menuX, menuY) },
        "separator",
        // Create
        { label: "New folder", shortcut: "Ctrl+Shift+N", run: () => void A.newFolder(tab) },
        { label: "New text file", shortcut: "Ctrl+Alt+N", run: () => void A.newFile(tab) },
        { label: "New file from template…", run: () => void A.openNewFileMenu(tab, menuX, menuY) },
        "separator",
        // View & compare
        { label: "Refresh", shortcut: "F5", run: () => void tab.refresh() },
        { label: tab.sizesLive() ? "Hide folder sizes" : "Calculate folder sizes", shortcut: "Ctrl+Shift+S", run: () => (tab.sizesLive() ? tab.clearSizes() : tab.computeSizes()) },
        ...(A.otherPaneTab() ? [{ label: compare.active() ? "Stop comparing" : "Compare with the other pane", run: A.toggleCompare }, ...(compare.statusOf(tab) ? [{ label: "Select differences", run: () => A.selectDifferences(tab) }] : [])] : []),
        "separator",
        // Tools
        ...(tab.archive() ? [] : [{ label: "Find duplicate files…", run: () => ui.setDuplicatesRoot(tab.path()) }, { label: "Clean up…", run: () => ui.setCleanupRoot(tab.path()) }]),
        ...(tab.search() ? [{ label: "Save this search…", run: () => A.saveSearch(tab) }] : []),
        "separator",
        // Folder & system
        { label: isPinned(sidebar.pins(), tab.path()) ? "Unpin folder from sidebar" : "Pin folder to sidebar", run: () => sidebar.togglePin(tab.path()) },
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

/** The Windows shell icon for this type, with a drawn glyph until it loads. */
function RowIcon(props: { path: string; name: string; isDir: boolean; virtual: boolean; link: boolean }) {
  // Types Octopolis knows get its own icon; the rest use the Windows icon for their type.
  const own = () => !props.isDir && fileIconSpec(props.name) !== null;
  const url = () => (props.virtual || own() ? null : iconFor(props.path, props.name, props.isDir)());
  const emoji = () => (props.isDir && !props.virtual ? folderIcons.get(props.path) : undefined);
  return (
    <Show when={!emoji()} fallback={<FolderEmoji emoji={emoji()!} size={16} class="row-icon" />}>
      <Show when={url()} fallback={<FileIcon name={props.name} isDir={props.isDir} link={props.link} />}>
        {(u) => <img class="row-icon" src={u()} alt="" width="16" height="16" />}
      </Show>
    </Show>
  );
}

/** File size, or a folder's computed size with a proportional bar. */
function SizeCell(props: { tab: TabModel; entry: number; name: string; dir: boolean }) {
  const known = () => (props.dir ? props.tab.dirSizes()?.get(props.name.toLowerCase()) : undefined);
  return (
    <div role="gridcell" class="cell end muted num size-cell">
      <Show when={known() !== undefined}>
        <span class="size-bar" style={{ width: `${(known()! / props.tab.dirSizeMax()) * 100}%` }} />
      </Show>
      <span class="size-text" classList={{ stale: props.dir && props.tab.dirSizeStale(props.name) }}>{props.dir ? (known() === undefined ? "" : formatSize(known()!)) : formatSize(props.tab.listing().sizes[props.entry])}</span>
    </div>
  );
}

const CLOUD_BADGES = {
  online: { glyph: "E753", title: "Online only: downloads when you open it" },
  pinned: { glyph: "E73E", title: "Always kept on this device" },
  local: { glyph: "E930", title: "On this device; can be freed to save space" },
} as const;

function CloudBadge(props: { attrs: number }) {
  const state = () => cloudState(props.attrs);
  return (
    <Show when={state()}>
      {(s) => (
        <span class={`cloud cloud-${s()}`} title={CLOUD_BADGES[s()].title} aria-label={CLOUD_BADGES[s()].title}>
          <Glyph code={CLOUD_BADGES[s()].glyph} size={11} />
        </span>
      )}
    </Show>
  );
}

/** Stage / Unstage / Discard when the selection has Git changes. */
function gitEntries(tab: TabModel): MenuEntry[] {
  const g = tab.git();
  if (!g || tab.search()) return [];
  const l = tab.listing();
  const states = [...tab.selection()].map((e) => g.children[l.names[e].toLowerCase()]).filter(Boolean);
  if (!states.length) return [];
  const changed = states.some((s) => s === "M" || s === "U" || s === "D" || s === "C");
  const staged = states.includes("S");
  const tracked = states.some((s) => s === "M" || s === "S" || s === "D");
  return [
    ...(changed ? [{ label: "Stage", run: () => A.gitAct(tab, "stage") }] : []),
    ...(staged ? [{ label: "Unstage", run: () => A.gitAct(tab, "unstage") }] : []),
    ...(tracked ? [{ label: "Discard changes…", danger: true, run: () => A.gitAct(tab, "discard") }] : []),
  ];
}

/** OneDrive actions when the selection contains synced files. */
function cloudEntries(tab: TabModel): MenuEntry[] {
  const l = tab.listing();
  if (tab.archive() || ![...tab.selection()].some((e) => cloudState(l.attrs[e]) !== null)) return [];
  return [
    { label: "Always keep on this device", run: () => void A.setCloudKeep(tab, true) },
    { label: "Free up space", run: () => void A.setCloudKeep(tab, false) },
  ];
}

const GIT_TITLES: Record<string, string> = { S: "Staged", M: "Modified", U: "Untracked", D: "Deleted", C: "Conflict", I: "Ignored" };

function GitBadge(props: { tab: TabModel; name: string }) {
  const status = () => props.tab.git()?.children[props.name.toLowerCase()];
  return (
    <Show when={status()}>
      {(s) => <span class={`git git-${s()}`} title={GIT_TITLES[s()]}>{s()}</span>}
    </Show>
  );
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function ago(ms: number): string {
  const days = (ms - Date.now()) / 86_400_000;
  if (days > -1) return relative.format(Math.round(days * 24), "hour");
  if (days > -30) return relative.format(Math.round(days), "day");
  if (days > -365) return relative.format(Math.round(days / 30), "month");
  return relative.format(Math.round(days / 365), "year");
}

function CommitCell(props: { tab: TabModel; name: string }) {
  const c = () => props.tab.commits()?.[props.name.toLowerCase()];
  return (
    <div role="gridcell" class="cell muted col-commit" data-tooltip={c()?.author} data-tooltip-truncated="">
      {c() ? `${ago(c()!.timeMs)} · ${c()!.author}` : ""}
    </div>
  );
}
