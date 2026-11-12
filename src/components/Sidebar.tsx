// Places: pinned folders, quick access, recent folders and drives, in collapsible sections.
import { createEffect, createResource, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { formatSize } from "../lib/format";
import { disconnectNetworkDrive, errorText, knownFolders, listDrives, mapNetworkDrive, wslDistros, type Drive } from "../lib/ipc";
import { baseName, parentPath, samePath } from "../lib/paths";
import { DEFAULT_SIDEBAR_WIDTH, isPinned, type Pin } from "../lib/sidebar";
import * as A from "../actions";
import { DRAG_MIME, dragState, PIN_MIME } from "../state/drag";
import { history } from "../state/history";
import { settings } from "../state/settings";
import { shelf } from "../state/shelf";
import { type SectionId, sidebar } from "../state/sidebar";
import { ui, type MenuEntry } from "../state/ui";
import { folderIcons } from "../state/folderIcons";
import { workspace } from "../state/workspace";
import { savedSearches } from "../state/savedSearches";
import { tags } from "../state/tags";
import { SearchItems, TagItems } from "./Tags";
import { FileGlyph, Glyph, IconChevron, IconDiskSpace, IconDrive, IconPin, IconPlus, IconTrash, PathIcon, PlaceGlyph } from "./Icons";

/** Opens a place; Ctrl+click opens it in a new tab (Ctrl+Shift in front). */
const go = (path: string, e?: MouseEvent) => (e?.ctrlKey ? A.openInNewTab(path, !e.shiftKey) : void workspace.activeTab()?.navigate(path));
/** Middle-click handler: opens the place in a new background tab (Shift: in front). */
const goMiddle = (path: () => string) => (e: MouseEvent) => {
  if (e.button !== 1) return;
  e.preventDefault();
  A.openInNewTab(path(), !e.shiftKey);
};


type PinDrop = { kind: "at"; index: number } | { kind: "into"; path: string } | null;
const [pinDrop, setPinDrop] = createSignal<PinDrop>(null);
let draggedPin: string | null = null;

/** Where in the pinned list the pointer is: the index of the first pin whose middle is below it. */
function pinIndexAt(section: HTMLElement, y: number): number {
  const items = [...section.querySelectorAll<HTMLElement>(".side-item[data-pin]")];
  const i = items.findIndex((el) => {
    const r = el.getBoundingClientRect();
    return y < r.top + r.height / 2;
  });
  return i < 0 ? items.length : i;
}

/** Where the dragged item would land, or -1 when no insertion is being previewed. */
const atIndex = () => {
  const d = pinDrop();
  return d?.kind === "at" ? d.index : -1;
};

/** A ghost row showing where the dragged folder(s) will be pinned. It is a real row, so it also enlarges the drop target. */
function PinSkeleton() {
  const names = () => {
    if (draggedPin) return [pinLabel(draggedPin)];
    return dragState.paths.map((p) => baseName(p) || p);
  };
  const label = () => (names().length > 1 ? `${names().length} folders` : (names()[0] ?? ""));
  return (
    <div class="side-item pin-skeleton" aria-hidden="true">
      <span class="pin-skeleton-icon" />
      <span class="side-label">{label()}</span>
    </div>
  );
}

const pinLabel = (path: string) => sidebar.pins().find((p) => samePath(p.path, path))?.label ?? baseName(path);

const pinDnd = {
  section: {
    onDragEnter(e: DragEvent) {
      const types = e.dataTransfer?.types ?? [];
      if (types.includes(PIN_MIME) || (types.includes(DRAG_MIME) && dragState.allDirs)) e.preventDefault();
    },
    onDragOver(e: DragEvent) {
      const types = e.dataTransfer?.types ?? [];
      const section = e.currentTarget as HTMLElement;
      if (types.includes(PIN_MIME)) {
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        setPinDrop({ kind: "at", index: pinIndexAt(section, e.clientY) });
      } else if (types.includes(DRAG_MIME)) {
        const item = (e.target as HTMLElement).closest<HTMLElement>(".side-item[data-pin]");
        if (item) {
          const r = item.getBoundingClientRect();
          const edge = r.height * 0.25;
          const middle = e.clientY > r.top + edge && e.clientY < r.bottom - edge;
          const path = item.dataset.pin!;
          if (middle || !dragState.allDirs) {
            // Drop onto the folder itself: move or copy into it.
            if (dragState.paths.some((p) => samePath(p, path))) return setPinDrop(null);
            e.preventDefault();
            e.dataTransfer!.dropEffect = e.ctrlKey ? "copy" : "move";
            return setPinDrop({ kind: "into", path });
          }
        } else if (!dragState.allDirs) return setPinDrop(null);
        e.preventDefault();
        e.dataTransfer!.dropEffect = "copy"; // the drag only allows copy/move, so "link" would reject the drop
        setPinDrop({ kind: "at", index: pinIndexAt(section, e.clientY) });
      }
    },
    onDragLeave(e: DragEvent) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const inside = e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom;
      if (!inside) setPinDrop(null);
    },
    onDrop(e: DragEvent) {
      const drop = pinDrop();
      setPinDrop(null);
      if (!drop) return;
      e.preventDefault();
      if (drop.kind === "into") A.dropPaths(dragState.paths, drop.path, e.ctrlKey, dragState.archive, false);
      else if (draggedPin) sidebar.reorderPin(draggedPin, drop.index);
      else sidebar.insertPins(dragState.paths, drop.index);
      sidebar.expand("pinned");
    },
  } satisfies JSX.HTMLAttributes<HTMLElement>,
};

export function Sidebar() {
  const [folders] = createResource(() => knownFolders().catch(() => []));
  const [drives, { refetch }] = createResource(() => listDrives().catch(() => []));
  const [distros] = createResource(() => wslDistros().catch(() => [] as string[]));
  const [binDrag, setBinDrag] = createSignal(false);
  const [binHot, setBinHot] = createSignal(false);

  onMount(() => {
    // Drives come and go (USB sticks); recheck when the window regains focus.
    const onFocus = () => void refetch();
    const dragStart = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes(DRAG_MIME) && !dragState.archive) setBinDrag(true);
    };
    const dragEnd = () => {
      setBinDrag(false);
      setBinHot(false);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("dragstart", dragStart);
    window.addEventListener("dragend", dragEnd);
    window.addEventListener("drop", dragEnd, true);
    onCleanup(() => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("dragstart", dragStart);
      window.removeEventListener("dragend", dragEnd);
      window.removeEventListener("drop", dragEnd, true);
    });
  });

  const current = () => workspace.activeTab()?.path() ?? "";
  const activeDriveRoot = () => {
    const cur = current().toLowerCase();
    const list = drives() ?? [];
    const match = list.find((d) => cur.startsWith(d.root.toLowerCase()));
    if (match) return match.root;
    const driveMatch = /^[a-z]:[\\/]/i.exec(current());
    return driveMatch ? `${driveMatch[0].slice(0, 2)}\\` : (list[0]?.root ?? "C:\\");
  };
  const pinCurrent = () => {
    if (!current()) return;
    sidebar.expand("pinned");
    sidebar.togglePin(current());
  };

  return (
    <div class="sidebar-wrap">
      <nav class="sidebar" aria-label="Places">
        <Show when={settings.showPinned()}>
        <Section
          id="pinned"
          title="Pinned"
          code="E718"
          count={sidebar.pins().length}
          drag={pinDnd.section}
          action={
            <button
              class="icon-btn section-action"
              data-tooltip={isPinned(sidebar.pins(), current()) ? "Unpin this folder" : "Pin this folder"}
              aria-label="Pin current folder"
              disabled={!current()}
              onClick={pinCurrent}
            >
              {isPinned(sidebar.pins(), current()) ? <IconPin size={14} /> : <IconPlus size={14} />}
            </button>
          }
        >
          <Show when={sidebar.pins().length > 0} fallback={<p class="side-empty drop-zone" classList={{ active: pinDrop() !== null }}>Pin folders you return to. Drag a folder here, use + above, or right-click any folder.</p>}>
            <For each={sidebar.pins()}>
              {(pin, i) => (
                <>
                  <Show when={atIndex() === i()}>
                    <PinSkeleton />
                  </Show>
                  <PinnedItem pin={pin} current={current()} />
                </>
              )}
            </For>
            <Show when={atIndex() === sidebar.pins().length}>
              <PinSkeleton />
            </Show>
          </Show>
        </Section>
        </Show>

        <Section id="quick" title="Quick access" code="E734">
          <For each={folders() ?? []}>
            {(f) => (
              <button class="side-item" classList={{ current: samePath(f.path, current()) }} onClick={(e) => go(f.path, e)} onMouseDown={goMiddle(() => f.path)} onContextMenu={(e) => placeMenu(e, f.path)} data-tooltip={f.path}>
                <PathIcon path={f.path} name={f.label} isDir exact size={18} fallback={<PlaceGlyph id={f.id} />} />
                <span class="side-label">{f.label}</span>
              </button>
            )}
          </For>
        </Section>

        <Show when={tags.all().length > 0}>
          <Section id="tags" title="Tags" code="E8EC" count={tags.all().length}>
            <TagItems />
          </Section>
        </Show>
        <Show when={savedSearches.list().length > 0}>
          <Section id="searches" title="Searches" code="E721" count={savedSearches.list().length}>
            <SearchItems />
          </Section>
        </Show>
        <Show when={settings.showRecent()}>
          <RecentSection current={current()} />
        </Show>

        <Section
          id="drives"
          title="Drives"
          code="EDA2"
          count={drives()?.length}
          action={
            <button class="icon-btn section-action" data-tooltip="Map network drive" aria-label="Map network drive" onClick={() => void mapNetworkDrive().catch((e) => ui.toast(errorText(e)))}>
              <IconPlus size={12} />
            </button>
          }
        >
          <For each={drives() ?? []}>{(d) => <DriveItem drive={d} current={current()} home={folders()?.find((x) => x.id === "home")?.path ?? "C:\\"} onEjected={() => void refetch()} />}</For>
          <For each={distros() ?? []}>
            {(root) => (
              <button class="side-item" classList={{ current: samePath(root, current()) }} onClick={(e) => go(root, e)} onMouseDown={goMiddle(() => root)} onContextMenu={(e) => placeMenu(e, root)} data-tooltip={root}>
                <Glyph code="E756" size={18} />
                <span class="side-label">{baseName(root)} (WSL)</span>
              </button>
            )}
          </For>
        </Section>
      </nav>
      <div class="sidebar-foot">
        <button
          class="icon-btn foot-btn"
          data-shelf-toggle
          classList={{ on: shelf.open(), calling: shelf.dragging(), hot: shelf.dragging() && shelf.hot() }}
          onDragOver={(e) => {
            if (!shelf.dragging() || !e.dataTransfer?.types.includes(DRAG_MIME)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            shelf.setHot(true);
          }}
          onDragLeave={() => shelf.setHot(false)}
          onDrop={(e) => {
            const raw = e.dataTransfer?.getData(DRAG_MIME);
            if (!raw) return;
            e.preventDefault();
            shelf.add(JSON.parse(raw) as string[]);
          }}
          aria-label="Shelf"
          aria-pressed={shelf.open()}
          data-tooltip={shelf.open() ? "Hide shelf" : "Shelf · hold files here while you browse"}
          onClick={() => shelf.setOpen(!shelf.open())}
        >
          <Glyph code="E7B8" size={17} />
          <Show when={shelf.items().length > 0}>
            <span class="foot-badge">{shelf.items().length}</span>
          </Show>
        </button>
        <button
          class="icon-btn foot-btn bin-btn"
          classList={{ on: ui.recycleBinOpen(), calling: binDrag(), hot: binDrag() && binHot() }}
          onDragOver={(e) => {
            if (!binDrag() || !e.dataTransfer?.types.includes(DRAG_MIME)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setBinHot(true);
          }}
          onDragLeave={() => setBinHot(false)}
          onDrop={(e) => {
            setBinHot(false);
            setBinDrag(false);
            const raw = e.dataTransfer?.getData(DRAG_MIME);
            if (!raw || dragState.archive) return;
            e.preventDefault();
            A.recyclePaths(JSON.parse(raw) as string[]);
          }}
          aria-label="Recycle Bin"
          aria-pressed={ui.recycleBinOpen()}
          data-tooltip="Recycle Bin · drop items here to delete, or click to open"
          onClick={() => ui.setRecycleBinOpen(true)}
        >
          <IconTrash size={17} />
        </button>
        <button
          class="icon-btn foot-btn"
          classList={{ on: !!ui.diskSpaceRoot() }}
          aria-label="Disk space preview"
          aria-pressed={!!ui.diskSpaceRoot()}
          data-tooltip={`Disk space preview (${activeDriveRoot().replace(/\\$/, "")})`}
          onClick={() => ui.openDiskSpace(activeDriveRoot())}
        >
          <IconDiskSpace size={17} />
        </button>
        <span class="spacer" />
        <button class="icon-btn foot-btn" aria-label="Settings" data-tooltip="Settings · Ctrl+," onClick={() => ui.openSettings()}>
          <Glyph code="E713" size={17} />
        </button>
      </div>
      <Resizer />
    </div>
  );
}

/** A collapsible group. The body animates its height and is inert while collapsed. */
function Section(props: { id: SectionId; title: string; code: string; count?: number; action?: JSX.Element; drag?: JSX.HTMLAttributes<HTMLElement>; children: JSX.Element }) {
  const open = () => !sidebar.isCollapsed(props.id);
  return (
    <section class="side-section" classList={{ collapsed: !open() }} {...props.drag}>
      <div class="side-head">
        <button class="side-toggle" aria-expanded={open()} aria-controls={`side-${props.id}`} onClick={() => sidebar.toggleSection(props.id)}>
          <span class="side-chevron">
            <IconChevron size={12} />
          </span>
          <Glyph code={props.code} size={13} class="side-title-icon" />
          <span class="side-title">{props.title}</span>
          <Show when={props.count !== undefined && props.count > 0}>
            <span class="side-count">{props.count}</span>
          </Show>
        </button>
        {props.action}
      </div>
      <div class="side-collapse" id={`side-${props.id}`} ref={(el) => createEffect(() => (el.inert = !open()))}>
        <div class="side-body">{props.children}</div>
      </div>
    </section>
  );
}

function placeMenu(e: MouseEvent, path: string, extra: MenuEntry[] = []) {
  e.preventDefault();
  const pinned = isPinned(sidebar.pins(), path);
  ui.openMenu(e.clientX, e.clientY, [
    { label: "Open", run: () => go(path) },
    { label: "Open in new tab", run: () => A.openInNewTab(path, false) },
    "separator",
    { label: pinned ? "Unpin from sidebar" : "Pin to sidebar", run: () => sidebar.togglePin(path) },
    ...(/^[a-z]:[\\/]?$/i.test(path)
      ? []
      : [
          { label: "Change icon…", run: () => ui.setEmojiTarget(path) },
          ...(folderIcons.get(path) ? [{ label: "Reset icon", run: () => folderIcons.set(path, null) }] : []),
        ]),
    ...extra,
  ]);
}

function PinnedItem(props: { pin: Pin; current: string }) {
  const pin = () => props.pin;
  const [dragging, setDragging] = createSignal(false);
  const dropInto = () => {
    const d = pinDrop();
    return d?.kind === "into" && samePath(d.path, pin().path);
  };
  const menu = (e: MouseEvent) =>
    placeMenu(e, pin().path, [
      "separator",
      {
        label: "Rename…",
        run: () => ui.askText({ title: "Rename pinned folder", label: "Name shown in the sidebar", onSubmit: (v) => sidebar.renamePin(pin().path, v) }),
      },
      { label: "Move up", run: () => sidebar.movePin(pin().path, -1) },
      { label: "Move down", run: () => sidebar.movePin(pin().path, 1) },
    ]);
  return (
    <button
      class="side-item"
      classList={{
        current: samePath(pin().path, props.current),
        "drop-into": dropInto(),
        "drag-source": dragging(),
      }}
      draggable={true}
      data-pin={pin().path}
      onDragStart={(e) => {
        draggedPin = pin().path;
        dragState.dirs = [pin().path];
        e.dataTransfer!.setData(PIN_MIME, pin().path);
        e.dataTransfer!.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => {
        draggedPin = null;
        dragState.dirs = [];
        setDragging(false);
        setPinDrop(null);
      }}
      onClick={(e) => go(pin().path, e)}
      onMouseDown={goMiddle(() => pin().path)}
      onContextMenu={menu}
      data-tooltip={pin().path}
    >
      <PathIcon path={pin().path} name={pin().label} isDir exact size={18} fallback={<FileGlyph category="folder" size={18} />} />
      <span class="side-label">{pin().label}</span>
    </button>
  );
}

/** Whether the sidebar hides secondary details (parent path, usage bar, free space). */
const sidebarDetailsHidden = () => settings.density() === "compact" || settings.sidebarNamesOnly();

function RecentSection(props: { current: string }) {
  const recent = () => sidebar.recent(8);
  return (
    <Section id="recent" title="Recent" code="E121" count={recent().length}>
      <Show when={recent().length > 0} fallback={<p class="side-empty">Folders you open will show up here.</p>}>
        <For each={recent()}>
          {(r) => (
            <button
              class="side-item recent"
              classList={{ current: samePath(r.path, props.current) }}
              onClick={(e) => go(r.path, e)}
              onMouseDown={goMiddle(() => r.path)}
              onContextMenu={(e) =>
                placeMenu(e, r.path, [
                  "separator",
                  { label: "Remove from recent", run: () => history.forget(r.path) },
                ])
              }
              data-tooltip={r.path}
              data-tooltip-truncated={sidebarDetailsHidden() ? undefined : ".side-label, .side-sub"}
            >
              <PathIcon path={r.path} name={baseName(r.path)} isDir exact size={18} fallback={<FileGlyph category="folder" size={18} />} />
              <span class="side-two">
                <span class="side-label">{baseName(r.path)}</span>
                <span class="side-sub"><bdi>{parentPath(r.path) ?? ""}</bdi></span>
              </span>
            </button>
          )}
        </For>
      </Show>
    </Section>
  );
}

/** Drives Windows can eject: USB sticks, memory cards and discs. */
const ejectable = (d: Drive) => d.kind === "removable" || d.kind === "optical";

function DriveItem(props: { drive: Drive; current: string; home: string; onEjected: () => void }) {
  const d = () => props.drive;
  const letter = () => d().root.replace(/\\$/, "");
  const used = () => (d().totalBytes ? 1 - d().freeBytes / d().totalBytes : 0);
  const active = () => props.current.toLowerCase().startsWith(d().root.toLowerCase());
  const [ejecting, setEjecting] = createSignal(false);
  const eject = () => {
    if (ejecting()) return;
    setEjecting(true);
    void A.ejectDriveSafely(d().root, props.home, () => {
      setEjecting(false);
      props.onEjected();
    });
  };
  const disconnect = () =>
    void disconnectNetworkDrive(d().root)
      .then(() => props.onEjected())
      .catch((e) => ui.toast(`Couldn't disconnect ${letter()}: ${errorText(e)}`));
  const driveMenu = (): MenuEntry[] => [
    "separator",
    { label: "Disk space preview", run: () => ui.openDiskSpace(d().root) },
    ...(ejectable(d()) ? ["separator" as const, { label: "Eject", run: eject }] : []),
    ...(d().kind === "network" ? ["separator" as const, { label: "Disconnect", run: disconnect }] : []),
  ];
  const tooltip = () => {
    if (!sidebarDetailsHidden() && (d().totalBytes > 0 || !d().fileSystem)) return undefined;
    const name = `${d().label || (d().kind === "removable" ? "USB drive" : "Local Disk")} (${letter()})`;
    const space = d().totalBytes > 0 ? `${formatSize(d().freeBytes)} free of ${formatSize(d().totalBytes)}` : "";
    return [name, d().fileSystem, space].filter(Boolean).join(" · ");
  };
  return (
    <div class="drive-row">
    <button
      class="side-item drive"
      classList={{ current: active(), "has-eject": ejectable(d()) }}
      onClick={(e) => go(d().root, e)}
      onMouseDown={goMiddle(() => d().root)}
      onContextMenu={(e) => placeMenu(e, d().root, driveMenu())}
      data-tooltip={tooltip()}
    >
      <PathIcon path={d().root} name={letter()} isDir exact size={20} fallback={<IconDrive kind={d().kind} size={20} />} />
      <span class="drive-text">
        <span class="side-label">
          {d().label || (d().kind === "removable" ? "USB drive" : "Local Disk")} ({letter()})
        </span>
        <Show when={d().totalBytes > 0}>
          <span class="usage" classList={{ full: used() > 0.9 }}>
            <span style={{ width: `${used() * 100}%` }} />
          </span>
          <span class="drive-free">{formatSize(d().freeBytes)} free of {formatSize(d().totalBytes)}</span>
        </Show>
      </span>
    </button>
    <Show when={ejectable(d())}>
      <button class="icon-btn drive-eject" aria-label={`Eject ${letter()}`} data-tooltip={`Eject ${letter()}`} disabled={ejecting()} onClick={eject}>
        <span class="eject-glyph" aria-hidden="true">⏏</span>
      </button>
    </Show>
    </div>
  );
}

/** Drag the sidebar's right edge to resize; double-click or Home resets it. Arrow keys nudge. */
function Resizer() {
  const scale = () => settings.uiScale() / 100;
  const onDown = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    const move = (m: PointerEvent) => sidebar.setWidth(m.clientX / scale());
    const up = () => {
      el.classList.remove("dragging");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") sidebar.setWidth(sidebar.width() - 12);
    else if (e.key === "ArrowRight") sidebar.setWidth(sidebar.width() + 12);
    else if (e.key === "Home") sidebar.setWidth(DEFAULT_SIDEBAR_WIDTH);
    else return;
    e.preventDefault();
  };
  return (
    <div
      class="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={sidebar.width()}
      tabIndex={0}
      onPointerDown={onDown}
      onDblClick={() => sidebar.setWidth(DEFAULT_SIDEBAR_WIDTH)}
      onKeyDown={onKey}
    />
  );
}
