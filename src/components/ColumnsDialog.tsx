// Customize Details-view columns: visibility, display order, and per-column widths.
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { allColumnsInOrder, clampWidth, columnDef, DEFAULT_COLUMNS, moveColumn, stepColumn, toggleColumn, type ColumnKey } from "../lib/columns";
import { settings } from "../state/settings";
import { ui } from "../state/ui";
import { IconClose, MaterialIcon } from "./Icons";

export function ColumnsDialog() {
  const [dragKey, setDragKey] = createSignal<ColumnKey | null>(null);
  const [dropTarget, setDropTarget] = createSignal<{ key: ColumnKey; place: "before" | "after" } | null>(null);
  let listEl!: HTMLDivElement;

  const active = () => settings.fileColumns();
  const activeSet = () => new Set(active());
  const ordered = () => allColumnsInOrder(active());
  const widths = () => settings.columnWidths();

  const setWidth = (key: ColumnKey, raw: number) => {
    if (!Number.isFinite(raw)) return;
    settings.set({ columnWidths: { ...widths(), [key]: clampWidth(key, raw) } });
  };

  const resetWidth = (key: ColumnKey) => {
    const { [key]: _gone, ...rest } = widths();
    settings.set({ columnWidths: rest });
  };

  const startDrag = (e: PointerEvent, key: ColumnKey) => {
    if (e.button !== 0 || !activeSet().has(key as ColumnKey)) return;
    e.preventDefault();
    const startY = e.clientY;
    let activeDrag = false;
    let currentDrop: { key: ColumnKey; place: "before" | "after" } | null = null;

    const resolveDrop = (clientY: number) => {
      const rows = Array.from(listEl.querySelectorAll<HTMLElement>("[data-col-key]"));
      for (const row of rows) {
        const k = row.dataset.colKey as ColumnKey;
        if (!activeSet().has(k)) continue;
        const r = row.getBoundingClientRect();
        if (clientY >= r.top && clientY <= r.bottom) {
          return { key: k, place: clientY < r.top + r.height / 2 ? ("before" as const) : ("after" as const) };
        }
      }
      return null;
    };

    const move = (m: PointerEvent) => {
      if (!activeDrag && Math.abs(m.clientY - startY) < 4) return;
      activeDrag = true;
      setDragKey(key);
      currentDrop = resolveDrop(m.clientY);
      setDropTarget(currentDrop);
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (activeDrag && currentDrop && currentDrop.key !== key) {
        settings.set({ fileColumns: moveColumn(active(), key, currentDrop.key, currentDrop.place) });
      }
      setDragKey(null);
      setDropTarget(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        ui.setColumnsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  createEffect(() => {
    // Keep focus inside the dialog if open.
    listEl?.focus();
  });

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && ui.setColumnsOpen(false)}>
      <div class="dialog columns-dialog" role="dialog" aria-modal="true" aria-labelledby="columns-dialog-title">
        <div class="bin-head">
          <h2 id="columns-dialog-title">Customize columns</h2>
          <button class="icon-btn" aria-label="Close" onClick={() => ui.setColumnsOpen(false)}>
            <IconClose size={14} />
          </button>
        </div>

        <div class="dialog-body columns-dialog-body">
          <p class="muted small columns-dialog-note">
            Choose which columns appear in Details view, drag or use the arrows to reorder them, and adjust widths. You can also drag column headers directly in the file list.
          </p>

          <div class="columns-list" ref={listEl} tabIndex={-1}>
            <div class="col-cfg-row locked">
              <span class="col-cfg-grip muted" aria-hidden="true">
                <MaterialIcon name="lock" size={14} />
              </span>
              <label class="col-cfg-check">
                <input type="checkbox" checked disabled />
                <span>Name</span>
              </label>
              <span class="muted small col-cfg-meta">Always shown · fills remaining space</span>
            </div>

            <For each={ordered()}>
              {(key) => {
                const def = columnDef(key);
                const on = () => activeSet().has(key);
                const idx = () => active().indexOf(key);
                const customW = () => widths()[key];
                const currentW = () => customW() ?? def.width;
                const isDropBefore = () => dropTarget()?.key === key && dropTarget()?.place === "before" && dragKey() !== key;
                const isDropAfter = () => dropTarget()?.key === key && dropTarget()?.place === "after" && dragKey() !== key;

                return (
                  <div
                    class="col-cfg-row"
                    data-col-key={key}
                    classList={{
                      off: !on(),
                      dragging: dragKey() === key,
                      "drop-before": isDropBefore(),
                      "drop-after": isDropAfter(),
                    }}
                  >
                    <button
                      type="button"
                      class="col-cfg-grip"
                      classList={{ disabled: !on() }}
                      disabled={!on()}
                      aria-label={`Drag to reorder ${def.label}`}
                      onPointerDown={(e) => startDrag(e, key)}
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                        <circle cx="4.5" cy="3" r="1.1" />
                        <circle cx="9.5" cy="3" r="1.1" />
                        <circle cx="4.5" cy="7" r="1.1" />
                        <circle cx="9.5" cy="7" r="1.1" />
                        <circle cx="4.5" cy="11" r="1.1" />
                        <circle cx="9.5" cy="11" r="1.1" />
                      </svg>
                    </button>

                    <label class="col-cfg-check">
                      <input
                        type="checkbox"
                        checked={on()}
                        onChange={() => settings.set({ fileColumns: toggleColumn(active(), key) })}
                      />
                      <span>{def.label}</span>
                    </label>

                    <div class="col-cfg-controls">
                      <label class="col-cfg-width" aria-label={`${def.label} width in pixels`}>
                        <input
                          type="number"
                          class="col-cfg-width-input num"
                          min={def.min}
                          max={600}
                          value={currentW()}
                          onChange={(e) => setWidth(key, Number(e.currentTarget.value))}
                        />
                        <span class="muted small">px</span>
                      </label>
                      <Show when={customW() !== undefined}>
                        <button
                          type="button"
                          class="icon-btn tiny"
                          data-tooltip={`Reset ${def.label} width (${def.width} px)`}
                          aria-label={`Reset ${def.label} width`}
                          onClick={() => resetWidth(key)}
                        >
                          <MaterialIcon name="restart_alt" size={14} />
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="icon-btn tiny"
                        disabled={!on() || idx() <= 0}
                        data-tooltip="Move up"
                        aria-label={`Move ${def.label} up`}
                        onClick={() => settings.set({ fileColumns: stepColumn(active(), key, -1) })}
                      >
                        <MaterialIcon name="expand_less" size={16} />
                      </button>
                      <button
                        type="button"
                        class="icon-btn tiny"
                        disabled={!on() || idx() < 0 || idx() >= active().length - 1}
                        data-tooltip="Move down"
                        aria-label={`Move ${def.label} down`}
                        onClick={() => settings.set({ fileColumns: stepColumn(active(), key, 1) })}
                      >
                        <MaterialIcon name="expand_more" size={16} />
                      </button>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </div>

        <div class="dialog-actions">
          <button
            type="button"
            class="btn"
            onClick={() => settings.set({ fileColumns: [...DEFAULT_COLUMNS], columnWidths: {} })}
          >
            Reset to defaults
          </button>
          <span class="bin-spacer" />
          <button type="button" class="btn primary" onClick={() => ui.setColumnsOpen(false)}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
