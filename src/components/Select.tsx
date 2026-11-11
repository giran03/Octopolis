// Theme-matched dropdown select rendered in a body portal so parent overflow never clips it.
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { settings } from "../state/settings";
import { Glyph, IconDown } from "./Icons";

export interface Option<T extends string | number> {
  readonly value: T;
  readonly label: string;
}

let nextListId = 1;

export function Select<T extends string | number>(props: {
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  label: string;
  class?: string;
  disabled?: boolean;
}) {
  const listId = `octo-select-${nextListId++}`;
  const [open, setOpen] = createSignal(false);
  const [hot, setHot] = createSignal(0);
  const [coords, setCoords] = createSignal({ left: 0, top: 0, minWidth: 160, flip: false });
  let triggerEl!: HTMLButtonElement;
  let menuEl: HTMLDivElement | undefined;

  const selectedIndex = () => Math.max(0, props.options.findIndex((o) => o.value === props.value));
  const selectedLabel = () => props.options.find((o) => o.value === props.value)?.label ?? "";

  const measure = () => {
    const r = triggerEl.getBoundingClientRect();
    const z = Math.max(0.1, settings.uiScale() / 100);
    const estH = Math.min(264, props.options.length * 32 + 10) * z;
    const spaceBelow = window.innerHeight - r.bottom - 8;
    const flip = spaceBelow < estH && r.top > spaceBelow;
    const rawTop = flip ? Math.max(8, r.top - estH - 4) : r.bottom + 4;
    const maxLeft = Math.max(8, window.innerWidth - r.width - 8);
    setCoords({
      left: Math.min(maxLeft, Math.max(8, r.left)) / z,
      top: rawTop / z,
      minWidth: r.width / z,
      flip,
    });
  };

  const openMenu = () => {
    if (props.disabled || props.options.length === 0) return;
    setHot(selectedIndex());
    measure();
    setOpen(true);
    queueMicrotask(() => {
      if (!menuEl) return;
      // Re-measure with exact rendered menu height so flip/clamping is exact.
      const mr = menuEl.getBoundingClientRect();
      const tr = triggerEl.getBoundingClientRect();
      const z = Math.max(0.1, settings.uiScale() / 100);
      const spaceBelow = window.innerHeight - tr.bottom - 8;
      const flip = spaceBelow < mr.height && tr.top > spaceBelow;
      const top = flip ? Math.max(8, tr.top - mr.height - 4) : Math.min(tr.bottom + 4, window.innerHeight - mr.height - 8);
      const left = Math.min(Math.max(8, window.innerWidth - mr.width - 8), Math.max(8, tr.left));
      setCoords({ left: left / z, top: top / z, minWidth: tr.width / z, flip });
      menuEl.focus();
      scrollHot();
    });
  };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerEl?.focus();
  };

  const pick = (opt: Option<T>) => {
    closeMenu(true);
    if (opt.value !== props.value) props.onChange(opt.value);
  };

  const scrollHot = () => {
    const el = menuEl?.querySelector<HTMLElement>(`[data-idx="${hot()}"]`);
    el?.scrollIntoView({ block: "nearest" });
  };

  createEffect(() => {
    if (!open()) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (triggerEl.contains(t) || menuEl?.contains(t)) return;
      closeMenu(false);
    };
    const onScroll = (e: Event) => {
      if (menuEl && e.target instanceof Node && menuEl.contains(e.target)) return;
      closeMenu(false);
    };
    const onResize = () => closeMenu(false);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    });
  });

  const onMenuKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    const len = props.options.length;
    if (len === 0) return;
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHot((i) => (i + 1) % len);
      scrollHot();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHot((i) => (i - 1 + len) % len);
      scrollHot();
    } else if (e.key === "Home") {
      e.preventDefault();
      setHot(0);
      scrollHot();
    } else if (e.key === "End") {
      e.preventDefault();
      setHot(len - 1);
      scrollHot();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const opt = props.options[hot()];
      if (opt) pick(opt);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const ch = e.key.toLowerCase();
      const hit = props.options.findIndex((o, idx) => idx > hot() && o.label.toLowerCase().startsWith(ch));
      const wrap = hit >= 0 ? hit : props.options.findIndex((o) => o.label.toLowerCase().startsWith(ch));
      if (wrap >= 0) {
        setHot(wrap);
        scrollHot();
      }
    }
  };

  return (
    <>
      <button
        ref={triggerEl}
        type="button"
        class={`text-input select select-btn${props.class ? ` ${props.class}` : ""}`}
        classList={{ open: open() }}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-controls={listId}
        aria-label={props.label}
        disabled={props.disabled}
        onClick={() => (open() ? closeMenu(false) : openMenu())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            openMenu();
          }
        }}
      >
        <span class="select-value">{selectedLabel()}</span>
        <IconDown size={11} class="select-caret" />
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={menuEl}
            id={listId}
            class="select-menu"
            classList={{ flip: coords().flip }}
            role="listbox"
            aria-label={props.label}
            tabIndex={-1}
            style={{
              left: `${coords().left}px`,
              top: `${coords().top}px`,
              "min-width": `${coords().minWidth}px`,
            }}
            onKeyDown={onMenuKey}
          >
            <For each={props.options}>
              {(o, i) => {
                const selected = () => o.value === props.value;
                return (
                  <button
                    type="button"
                    data-idx={i()}
                    class="select-option"
                    classList={{ selected: selected(), hot: hot() === i() }}
                    role="option"
                    aria-selected={selected()}
                    onMouseEnter={() => setHot(i())}
                    onClick={() => pick(o)}
                  >
                    <span class="select-opt-label">{o.label}</span>
                    <Show when={selected()}>
                      <Glyph code="E73E" size={11} class="select-check" />
                    </Show>
                  </button>
                );
              }}
            </For>
          </div>
        </Portal>
      </Show>
    </>
  );
}
