// Floating UI: operations tray, context menu, confirmation dialog, toasts.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { formatSize } from "../lib/format";
import { baseName } from "../lib/paths";
import { ops, type OpView } from "../state/ops";
import { ui, type MenuEntry, type MenuItem, type MenuState } from "../state/ui";
import { IconClose } from "./Icons";

export function Overlays() {
  return (
    <>
      <OpsTray />
      <Show when={ui.menu()} keyed>
        {(m) => <ContextMenu menu={m} />}
      </Show>
      <ConfirmDialog />
      <div class="toasts" role="status" aria-live="polite">
        <For each={ui.toasts()}>{(t) => <div class="toast">{t.text}</div>}</For>
      </div>
    </>
  );
}

function OpsTray() {
  return (
    <div class="ops-tray">
      <For each={ops.list()}>{(o) => <OpCard op={o} />}</For>
    </div>
  );
}

function OpCard(props: { op: OpView }) {
  const o = () => props.op;
  const fraction = () => {
    const p = o();
    if (p.totalBytes > 0) return p.doneBytes / p.totalBytes;
    return p.totalItems > 0 ? p.doneItems / p.totalItems : 0;
  };
  const summary = () => {
    const p = o();
    if (p.finished) {
      if (p.cancelled) return "Cancelled";
      return p.errors.length ? `Finished with ${p.errors.length} problem${p.errors.length === 1 ? "" : "s"}` : "Done";
    }
    return p.totalBytes > 0 ? `${formatSize(p.doneBytes)} of ${formatSize(p.totalBytes)}` : `${p.doneItems} of ${p.totalItems} items`;
  };
  return (
    <div class="op-card" classList={{ failed: o().finished && o().errors.length > 0 }}>
      <div class="op-top">
        <span class="op-label">{o().label}</span>
        <Show
          when={o().finished}
          fallback={
            <button class="btn small" onClick={() => ops.cancel(o())}>
              Cancel
            </button>
          }
        >
          <button class="icon-btn" aria-label="Dismiss" onClick={() => ops.dismiss(o().key)}>
            <IconClose size={12} />
          </button>
        </Show>
      </div>
      <div class="progress" role="progressbar" aria-valuenow={Math.round(fraction() * 100)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${(o().finished && !o().cancelled ? 1 : fraction()) * 100}%` }} />
      </div>
      <div class="op-sub">
        <span>{summary()}</span>
        <Show when={o().current}>{(c) => <span class="op-current">{baseName(c())}</span>}</Show>
      </div>
      <Show when={o().errors.length > 0}>
        <ul class="op-errors">
          <For each={o().errors.slice(0, 50)}>{(e) => <li title={e.path}>{e.message}</li>}</For>
        </ul>
      </Show>
    </div>
  );
}

function ContextMenu(props: { menu: MenuState }) {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal({ x: props.menu.x, y: props.menu.y });
  const [hot, setHot] = createSignal(-1);
  const items = props.menu.items;
  const actionable = items.map((it, i) => (it !== "separator" && !it.disabled ? i : -1)).filter((i) => i >= 0);

  const run = (item: MenuItem) => {
    ui.closeMenu();
    if (!item.disabled) item.run();
  };

  onMount(() => {
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(props.menu.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(props.menu.y, window.innerHeight - r.height - 4)),
    });
    el.focus();
    const away = (e: MouseEvent) => !el.contains(e.target as Node) && ui.closeMenu();
    const blur = () => ui.closeMenu();
    window.addEventListener("mousedown", away, true);
    window.addEventListener("blur", blur);
    onCleanup(() => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("blur", blur);
    });
  });

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const at = actionable.indexOf(hot());
    if (e.key === "Escape") ui.closeMenu();
    if (e.key === "ArrowDown") setHot(actionable[(at + 1) % actionable.length]);
    if (e.key === "ArrowUp") setHot(actionable[(at - 1 + actionable.length) % actionable.length]);
    if (e.key === "Enter" && hot() >= 0) run(items[hot()] as MenuItem);
  };

  return (
    <div ref={el} class="menu" role="menu" tabIndex={-1} style={{ left: `${pos().x}px`, top: `${pos().y}px` }} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
      <For each={items as MenuEntry[]}>
        {(it, i) =>
          it === "separator" ? (
            <div class="menu-sep" role="separator" />
          ) : (
            <button
              class="menu-item"
              role="menuitem"
              disabled={it.disabled}
              classList={{ danger: it.danger, hot: hot() === i() }}
              onMouseEnter={() => setHot(i())}
              onClick={() => run(it)}
            >
              <span>{it.label}</span>
              <Show when={it.shortcut}>
                <kbd>{it.shortcut}</kbd>
              </Show>
            </button>
          )
        }
      </For>
    </div>
  );
}

function ConfirmDialog() {
  return (
    <Show when={ui.confirm()} keyed>
      {(c) => {
        const confirm = () => {
          ui.closeConfirm();
          c.onConfirm();
        };
        return (
          <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && ui.closeConfirm()}>
            <div
              class="dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="dlg-title"
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") ui.closeConfirm();
              }}
            >
              <h2 id="dlg-title">{c.title}</h2>
              <p>{c.body}</p>
              <div class="dialog-actions">
                <button class="btn" ref={(b) => queueMicrotask(() => b.focus())} onClick={() => ui.closeConfirm()}>
                  Cancel
                </button>
                <button class="btn" classList={{ danger: c.danger, primary: !c.danger }} onClick={confirm}>
                  {c.confirmLabel}
                </button>
              </div>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
