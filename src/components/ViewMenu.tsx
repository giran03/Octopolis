// The View button: the ways to show a folder, and one slider that moves through them.
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { ViewMode } from "../lib/folderViews";
import { ICON_PRESETS, viewAt, viewLabel, ZOOM_MAX, zoomOf } from "../lib/viewZoom";
import { settings } from "../state/settings";
import type { TabModel } from "../state/tab";
import { MaterialIcon } from "./Icons";

interface Entry {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly mode: ViewMode;
  /** Icon size, for the icon entries. */
  readonly size?: number;
  readonly keys: string;
}

const ICONS_FOR_PRESET = ["crop_landscape", "crop_square", "grid_view", "apps"] as const;

export const VIEW_ENTRIES: readonly Entry[] = [
  ...ICON_PRESETS.map((p, i) => ({ id: `icons-${p.size}`, label: p.label, icon: ICONS_FOR_PRESET[i], mode: "grid" as const, size: p.size, keys: `Ctrl+Shift+${i + 1}` })),
  { id: "list", label: "List", icon: "view_list", mode: "list", keys: "Ctrl+Shift+5" },
  { id: "details", label: "Details", icon: "table_rows", mode: "details", keys: "Ctrl+Shift+6" },
  { id: "tiles", label: "Tiles", icon: "view_module", mode: "tiles", keys: "Ctrl+Shift+7" },
  { id: "content", label: "Content", icon: "view_agenda", mode: "content", keys: "Ctrl+Shift+8" },
  { id: "bento", label: "Bento", icon: "dashboard", mode: "bento", keys: "Ctrl+Shift+9" },
  { id: "columns", label: "Columns", icon: "view_column", mode: "columns", keys: "Ctrl+3" },
];

/** The entry that matches how the tab is showing its folder now. */
function currentEntry(tab: TabModel): Entry {
  const mode = tab.viewMode();
  if (mode !== "grid") return VIEW_ENTRIES.find((e) => e.mode === mode) ?? VIEW_ENTRIES[5];
  const size = tab.iconSize();
  const icons = VIEW_ENTRIES.filter((e) => e.mode === "grid");
  return icons.reduce((best, e) => (Math.abs((e.size ?? 0) - size) < Math.abs((best.size ?? 0) - size) ? e : best));
}

export function ViewMenu(props: { tab: TabModel }) {
  let button!: HTMLButtonElement;
  let panel: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ left: 0, top: 0 });
  const close = () => setOpen(false);

  const place = () => {
    const z = Math.max(0.1, settings.uiScale() / 100);
    const r = button.getBoundingClientRect();
    const width = 252;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width));
    setPos({ left: left / z, top: (r.bottom + 4) / z });
  };
  const toggle = () => {
    if (open()) return close();
    place();
    setOpen(true);
    queueMicrotask(() => panel?.focus());
  };

  createEffect(() => {
    if (!open()) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (button.contains(t) || panel?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        button.focus();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
    });
  });

  const choose = (e: Entry) => props.tab.setView(e.mode, e.size);
  /** Auto for this folder: on when the setting is on and the folder was not given a view by hand. */
  const autoActive = () => settings.autoView() && props.tab.viewIsAuto();
  const toggleAuto = () => {
    if (autoActive()) {
      // Turning Auto off keeps the view the folder has now.
      settings.set({ autoView: false });
      return;
    }
    settings.set({ autoView: true });
    props.tab.useAutoView();
  };
  /** Where the slider's thumb sits: on the view's own step, so dragging through the compact views snaps. */
  const zoom = () => zoomOf(props.tab.viewMode(), props.tab.iconSize());
  const onSlide = (value: number) => {
    const v = viewAt(value, props.tab.iconSize());
    props.tab.setView(v.mode, v.mode === "grid" ? v.size : undefined);
  };

  return (
    <>
      <button ref={button} class="icon-btn view-btn" classList={{ on: open(), auto: settings.autoView() && props.tab.viewIsAuto() }} aria-haspopup="dialog" aria-expanded={open()} aria-label="View" data-tooltip={settings.autoView() && props.tab.viewIsAuto() ? `View · Auto chose ${props.tab.autoNote() ?? "this view"}` : "View · Ctrl+wheel zooms"} onClick={toggle}>
        <MaterialIcon name={currentEntry(props.tab).icon} size={16} />
      </button>
      <Show when={open()}>
        <Portal>
          <div ref={panel} class="view-pop" role="dialog" aria-label="View" tabIndex={-1} style={{ left: `${pos().left}px`, top: `${pos().top}px` }}>
            <button class="view-opt view-auto" classList={{ on: autoActive() }} onClick={toggleAuto} aria-pressed={autoActive()} title="Choose the view from what the folder holds">
              <span class="view-dot" aria-hidden="true">{autoActive() ? "•" : ""}</span>
              <MaterialIcon name="auto_awesome" size={18} />
              <span class="view-label">Auto</span>
              <span class="view-keys muted small">Ctrl+Shift+0</span>
            </button>
            <Show when={autoActive() && props.tab.autoNote()}>{(n) => <div class="view-note muted small">{n()}</div>}</Show>
            <div class="view-sep" />
            <For each={VIEW_ENTRIES}>
              {(e) => (
                <button class="view-opt" classList={{ on: currentEntry(props.tab).id === e.id }} onClick={() => choose(e)}>
                  <span class="view-dot" aria-hidden="true">{currentEntry(props.tab).id === e.id ? "•" : ""}</span>
                  <MaterialIcon name={e.icon} size={18} />
                  <span class="view-label">{e.label}</span>
                  <span class="view-keys muted small">{e.keys}</span>
                </button>
              )}
            </For>
            <div class="view-zoom">
              <div class="view-zoom-head">
                <span class="muted small">Zoom</span>
                <span class="small">{viewLabel(props.tab.viewMode(), props.tab.iconSize())}</span>
              </div>
              <input
                type="range"
                class="view-slider"
                aria-label="Zoom through the views"
                min={0}
                max={ZOOM_MAX}
                step={1}
                disabled={zoom() === null}
                value={zoom() ?? ZOOM_MAX}
                onInput={(e) => onSlide(Number(e.currentTarget.value))}
              />
              <div class="view-ticks small muted" aria-hidden="true">
                <i style={{ left: "0%" }} />
                <i style={{ left: "12%" }} />
                <i style={{ left: "24%" }} />
                <i style={{ left: "36%" }} />
                <span class="view-ticks-a">List · Details · Content · Tiles</span>
                <span class="view-ticks-icons">Icons</span>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
}
