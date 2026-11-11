// Building blocks shared by every settings tab: sections, rows and the controls that sit in them.
import { createEffect, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
export { Select, type Option } from "../Select";

export function Section(props: { title: string; note?: string; children: JSX.Element }) {
  return (
    <section class="sset">
      <h3 class="sset-title">{props.title}</h3>
      <Show when={props.note}>
        <p class="sset-note">{props.note}</p>
      </Show>
      <div class="sset-card">{props.children}</div>
    </section>
  );
}

/** A label with an optional hint on the left and its control on the right. */
export function SettingRow(props: { label: string; hint?: string; stacked?: boolean; children?: JSX.Element }) {
  return (
    <div class="srow" classList={{ stacked: props.stacked }}>
      <div class="srow-text">
        <div class="srow-label">{props.label}</div>
        <Show when={props.hint}>
          <div class="srow-hint">{props.hint}</div>
        </Show>
      </div>
      <Show when={props.children}>
        <div class="srow-control">{props.children}</div>
      </Show>
    </div>
  );
}

export function Toggle(props: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      class="switch"
      classList={{ on: props.checked }}
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="switch-knob" />
    </button>
  );
}

import type { Option } from "../Select";

/** A short exclusive choice, with arrow-key movement and a sliding active-pill indicator. */
export function Segmented<T extends string | number>(props: {
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  label: string;
  btnClass?: string;
}) {
  let wrapEl!: HTMLDivElement;
  const [thumb, setThumb] = createSignal({ x: 0, w: 0, show: false, animate: false });

  const syncThumb = (animate: boolean) => {
    const active = wrapEl?.querySelector<HTMLElement>(".seg-btn.on");
    if (!active) {
      setThumb((prev) => ({ ...prev, show: false, animate }));
      return;
    }
    setThumb({ x: active.offsetLeft, w: active.offsetWidth, show: true, animate });
  };

  onMount(() => {
    syncThumb(false);
    const ro = new ResizeObserver(() => syncThumb(false));
    ro.observe(wrapEl);
    onCleanup(() => ro.disconnect());
  });

  createEffect(() => {
    void props.value;
    void props.options;
    queueMicrotask(() => syncThumb(true));
  });

  const hasMatch = () => props.options.some((o) => o.value === props.value);

  const move = (delta: number) => {
    const i = props.options.findIndex((o) => o.value === props.value);
    const base = i < 0 ? (delta > 0 ? -1 : 0) : i;
    const next = props.options[(base + delta + props.options.length) % props.options.length];
    props.onChange(next.value);
  };

  return (
    <div
      ref={wrapEl}
      class="seg"
      role="radiogroup"
      aria-label={props.label}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") move(1);
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(-1);
        else return;
        e.preventDefault();
        queueMicrotask(() => (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
      }}
    >
      <span
        class="seg-thumb"
        classList={{ animate: thumb().animate }}
        aria-hidden="true"
        style={{
          transform: `translateX(${thumb().x}px)`,
          width: `${thumb().w}px`,
          opacity: thumb().show ? 1 : 0,
        }}
      />
      <For each={props.options}>
        {(o, idx) => (
          <button
            class={`seg-btn${props.btnClass ? ` ${props.btnClass}` : ""}`}
            classList={{ on: props.value === o.value }}
            role="radio"
            aria-checked={props.value === o.value}
            tabIndex={props.value === o.value || (!hasMatch() && idx() === 0) ? 0 : -1}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

export function Slider(props: { value: number; min: number; max: number; step: number; onChange: (value: number) => void; label: string; format?: (value: number) => string }) {
  const [draft, setDraft] = createSignal<number | null>(null);
  const [editing, setEditing] = createSignal(false);
  const [text, setText] = createSignal("");
  let inputEl: HTMLInputElement | undefined;

  const clamp = (v: number) => Math.min(props.max, Math.max(props.min, v));
  const snap = (v: number) => clamp(Number((props.min + Math.round((v - props.min) / props.step) * props.step).toFixed(4)));
  const shown = () => clamp(draft() ?? props.value);
  const ratio = () => {
    const span = props.max - props.min;
    return span > 0 ? Math.min(1, Math.max(0, (shown() - props.min) / span)) : 0;
  };

  const commitSlide = (raw: number) => {
    setDraft(null);
    if (raw !== props.value) props.onChange(raw);
  };

  const startEdit = () => {
    setText(String(shown()));
    setEditing(true);
    queueMicrotask(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  };

  const commitEdit = () => {
    if (!editing()) return;
    setEditing(false);
    const parsed = Number(text().replace(/%/g, "").trim());
    if (!Number.isFinite(parsed)) return;
    const clamped = clamp(parsed);
    const rounded = Number.isInteger(props.step) ? Math.round(clamped) : Number(clamped.toFixed(4));
    setDraft(null);
    if (rounded !== props.value) props.onChange(rounded);
  };

  const cancelEdit = () => setEditing(false);

  const onRangeKey = (e: KeyboardEvent) => {
    const dir = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    let next: number | null = null;
    if (dir !== 0) next = clamp(Number((shown() + dir * props.step).toFixed(4)));
    else if (e.key === "PageUp") next = clamp(Number((shown() + props.step * 2).toFixed(4)));
    else if (e.key === "PageDown") next = clamp(Number((shown() - props.step * 2).toFixed(4)));
    else if (e.key === "Home") next = props.min;
    else if (e.key === "End") next = props.max;
    if (next === null) return;
    e.preventDefault();
    commitSlide(next);
  };

  return (
    <span class="slider">
      <input
        type="range"
        aria-label={props.label}
        min={props.min}
        max={props.max}
        step="any"
        value={shown()}
        style={{ "--fill-ratio": String(ratio()) }}
        onInput={(e) => setDraft(snap(Number(e.currentTarget.value)))}
        onChange={(e) => commitSlide(snap(Number(e.currentTarget.value)))}
        onPointerUp={() => {
          const d = draft();
          if (d !== null) commitSlide(d);
        }}
        onBlur={() => {
          const d = draft();
          if (d !== null) commitSlide(d);
        }}
        onKeyDown={onRangeKey}
      />
      <Show
        when={editing()}
        fallback={
          <span class="slider-value num" title="Double-click to enter a value" onDblClick={startEdit}>
            {props.format ? props.format(shown()) : shown()}
          </span>
        }
      >
        <input
          ref={inputEl}
          class="text-input slider-input num"
          aria-label={`${props.label} value`}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commitEdit();
            else if (e.key === "Escape") cancelEdit();
          }}
        />
      </Show>
    </span>
  );
}

/** A button for a one-off action. With `confirm`, the first press arms it and the second one runs it. */
export function ActionButton(props: { label: string; onClick: () => void; danger?: boolean; confirm?: string; disabled?: boolean; primary?: boolean }) {
  const [armed, setArmed] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const press = () => {
    if (props.confirm && !armed()) {
      setArmed(true);
      timer = setTimeout(() => setArmed(false), 3500);
      return;
    }
    clearTimeout(timer);
    setArmed(false);
    props.onClick();
  };
  return (
    <button class="btn" classList={{ danger: props.danger && armed(), primary: props.primary, "btn-danger-text": props.danger && !armed() }} disabled={props.disabled} onClick={press}>
      {armed() ? props.confirm : props.label}
    </button>
  );
}
