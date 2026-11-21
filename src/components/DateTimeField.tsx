// Theme-matched date/time picker, rendered in a body portal. Replaces the browser's own
// <input type="datetime-local"> / <input type="time"> popup, which ignores the app's theme.
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { settings } from "../state/settings";
import { MaterialIcon } from "./Icons";

type Mode = "datetime" | "time";
interface Parts {
  y: number;
  mo: number; // 0-11
  d: number;
  h: number;
  mi: number;
  s: number;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Reads `YYYY-MM-DDTHH:mm[:ss]` (or `HH:mm` in time mode); anything else gives today at 00:00:00. */
export function parseValue(value: string, mode: Mode): Parts {
  const now = new Date();
  const base: Parts = { y: now.getFullYear(), mo: now.getMonth(), d: now.getDate(), h: 0, mi: 0, s: 0 };
  if (mode === "time") {
    const m = /^(\d{1,2}):(\d{2})/.exec(value);
    return m ? { ...base, h: Math.min(23, +m[1]), mi: Math.min(59, +m[2]) } : base;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  return m ? { y: +m[1], mo: +m[2] - 1, d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] ?? 0) } : base;
}

export function formatValue(p: Parts, mode: Mode): string {
  if (mode === "time") return `${pad(p.h)}:${pad(p.mi)}`;
  return `${pad(p.y, 4)}-${pad(p.mo + 1)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2));

let nextId = 1;

export function DateTimeField(props: {
  /** `YYYY-MM-DDTHH:mm:ss` (datetime) or `HH:mm` (time); empty shows today / midnight. */
  value: string;
  onChange: (value: string) => void;
  label: string;
  mode?: Mode;
  class?: string;
  id?: string;
}) {
  const mode = (): Mode => props.mode ?? "datetime";
  const popId = `octo-datetime-${nextId++}`;
  const [open, setOpen] = createSignal(false);
  const [cur, setCur] = createSignal<Parts>(parseValue(props.value, mode()));
  const [view, setView] = createSignal({ y: cur().y, mo: cur().mo });
  const [coords, setCoords] = createSignal({ left: 0, top: 0 });
  let triggerEl!: HTMLButtonElement;
  let popEl: HTMLDivElement | undefined;

  const shown = () => {
    if (!props.value) return "";
    const p = parseValue(props.value, mode());
    if (mode() === "time") return formatValue(p, "time");
    return new Date(p.y, p.mo, p.d, p.h, p.mi, p.s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
  };

  const commit = (next: Parts) => {
    setCur(next);
    props.onChange(formatValue(next, mode()));
  };

  const place = () => {
    if (!popEl) return;
    const z = Math.max(0.1, settings.uiScale() / 100);
    const tr = triggerEl.getBoundingClientRect();
    const pr = popEl.getBoundingClientRect();
    const spaceBelow = window.innerHeight - tr.bottom - 8;
    const flip = pr.height > spaceBelow && tr.top > spaceBelow;
    const top = flip ? Math.max(8, tr.top - pr.height - 4) : Math.max(8, Math.min(tr.bottom + 4, window.innerHeight - pr.height - 8));
    const left = Math.min(Math.max(8, window.innerWidth - pr.width - 8), Math.max(8, tr.left));
    setCoords({ left: left / z, top: top / z });
  };

  const openPop = () => {
    const p = parseValue(props.value, mode());
    setCur(p);
    setView({ y: p.y, mo: p.mo });
    setOpen(true);
    queueMicrotask(() => {
      place();
      popEl?.focus();
    });
  };
  const closePop = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerEl?.focus();
  };

  createEffect(() => {
    if (!open()) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (triggerEl.contains(t) || popEl?.contains(t)) return;
      closePop(false);
    };
    const onScroll = (e: Event) => {
      if (popEl && e.target instanceof Node && popEl.contains(e.target)) return;
      closePop(false);
    };
    const onResize = () => closePop(false);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    });
  });

  const cells = createMemo(() => {
    const { y, mo } = view();
    const lead = new Date(y, mo, 1).getDay();
    return Array.from({ length: 42 }, (_, i) => new Date(y, mo, 1 - lead + i));
  });
  const today = new Date();
  const isSame = (d: Date, y: number, mo: number, day: number) => d.getFullYear() === y && d.getMonth() === mo && d.getDate() === day;
  const shiftMonth = (by: number) => setView((v) => {
    const d = new Date(v.y, v.mo + by, 1);
    return { y: d.getFullYear(), mo: d.getMonth() };
  });
  const pickDay = (d: Date) => {
    commit({ ...cur(), y: d.getFullYear(), mo: d.getMonth(), d: d.getDate() });
    setView({ y: d.getFullYear(), mo: d.getMonth() });
  };

  const setField = (key: "h" | "mi" | "s", raw: string) => {
    const max = key === "h" ? 23 : 59;
    const n = Math.min(max, Math.max(0, Math.floor(Number(raw)) || 0));
    commit({ ...cur(), [key]: n });
  };

  return (
    <>
      <button
        ref={triggerEl}
        id={props.id}
        type="button"
        class={`text-input select-btn datetime-btn${props.class ? ` ${props.class}` : ""}`}
        classList={{ open: open() }}
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-controls={popId}
        aria-label={props.label}
        onClick={() => (open() ? closePop(false) : openPop())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            openPop();
          }
        }}
      >
        <span class="select-value">{shown() || "Not set"}</span>
        <Show
          when={!open()}
          fallback={<MaterialIcon name="close" size={16} class="select-caret" />}
        >
          <Show when={mode() === "time"} fallback={<CalendarIcon />}>
            <MaterialIcon name="schedule" size={16} class="select-caret" />
          </Show>
        </Show>
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={popEl}
            id={popId}
            class="datetime-pop"
            classList={{ "time-only": mode() === "time" }}
            role="dialog"
            aria-label={props.label}
            tabIndex={-1}
            style={{ left: `${coords().left}px`, top: `${coords().top}px` }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape" || (e.key === "Enter" && !(e.target instanceof HTMLButtonElement))) {
                e.preventDefault();
                closePop(true);
              }
            }}
          >
            <Show when={mode() === "datetime"}>
              <div class="dt-cal">
                <div class="dt-head">
                  <button type="button" class="dt-nav" aria-label="Previous month" onClick={() => shiftMonth(-1)}>
                    <MaterialIcon name="chevron_right" size={18} class="dt-flip" />
                  </button>
                  <span class="dt-title" aria-live="polite">{new Date(view().y, view().mo, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
                  <button type="button" class="dt-nav" aria-label="Next month" onClick={() => shiftMonth(1)}>
                    <MaterialIcon name="chevron_right" size={18} />
                  </button>
                </div>
                <div class="dt-grid" role="grid">
                  <For each={WEEKDAYS}>{(w) => <span class="dt-dow">{w}</span>}</For>
                  <For each={cells()}>
                    {(d) => (
                      <button
                        type="button"
                        class="dt-day"
                        classList={{
                          out: d.getMonth() !== view().mo,
                          today: isSame(d, today.getFullYear(), today.getMonth(), today.getDate()),
                          sel: isSame(d, cur().y, cur().mo, cur().d),
                        }}
                        aria-label={d.toLocaleDateString(undefined, { dateStyle: "full" })}
                        aria-pressed={isSame(d, cur().y, cur().mo, cur().d)}
                        onClick={() => pickDay(d)}
                      >
                        {d.getDate()}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
            <div class="dt-time">
              <span class="dt-time-label">Time</span>
              <TimeBox label="Hours" value={cur().h} max={23} onChange={(v) => setField("h", v)} />
              <span class="dt-colon">:</span>
              <TimeBox label="Minutes" value={cur().mi} max={59} onChange={(v) => setField("mi", v)} />
              <Show when={mode() === "datetime"}>
                <span class="dt-colon">:</span>
                <TimeBox label="Seconds" value={cur().s} max={59} onChange={(v) => setField("s", v)} />
              </Show>
            </div>
            <div class="dt-foot">
              <Show when={mode() === "datetime"}>
                <button
                  type="button"
                  class="link-btn small"
                  onClick={() => {
                    const n = new Date();
                    pickDay(n);
                  }}
                >
                  Today
                </button>
              </Show>
              <button type="button" class="btn small primary" onClick={() => closePop(true)}>
                Done
              </button>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
}

/** A two-digit number box that steps with the arrow keys and the mouse wheel. */
function TimeBox(props: { label: string; value: number; max: number; onChange: (v: string) => void }) {
  const step = (by: number) => props.onChange(String((props.value + by + props.max + 1) % (props.max + 1)));
  return (
    <input
      class="text-input dt-box"
      inputmode="numeric"
      maxLength={2}
      aria-label={props.label}
      value={pad(props.value)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        props.onChange(e.currentTarget.value);
        e.currentTarget.value = pad(Math.min(props.max, Math.max(0, Math.floor(Number(e.currentTarget.value)) || 0)));
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          step(e.key === "ArrowUp" ? 1 : -1);
        }
      }}
      onWheel={(e) => {
        if (document.activeElement !== e.currentTarget) return;
        e.preventDefault();
        step(e.deltaY < 0 ? 1 : -1);
      }}
    />
  );
}

/** A calendar outline; the bundled icon font is a subset without one. */
const CalendarIcon = () => (
  <svg class="select-caret" style={{ width: "calc(15px * var(--icon-scale, 1))", height: "calc(15px * var(--icon-scale, 1))" }} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="12" height="11" rx="2" />
    <path d="M2 6.5h12M5.5 1.8v2.4M10.5 1.8v2.4" />
  </svg>
);
