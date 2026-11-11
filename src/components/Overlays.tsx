// Floating UI: operations tray, context menu, confirmation dialog, toasts.
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { formatSize } from "../lib/format";
import { baseName } from "../lib/paths";
import { ops, type OpView } from "../state/ops";
import { filterMenu } from "../lib/menu";
import { settings } from "../state/settings";
import { ui, type MenuEntry, type MenuItem, type MenuState } from "../state/ui";
import { BatchRename, LockHunter } from "./Dialogs";
import { PromptDialog, SettingsDialog } from "./Extras";
import { IconClose } from "./Icons";
import { Palette } from "./Palette";
import { Shortcuts } from "./Shortcuts";

export function Overlays() {
  return (
    <>
      <OpsTray />
      <Show when={ui.menu()} keyed>
        {(m) => <ContextMenu menu={m} />}
      </Show>
      <ConfirmDialog />
      {/* Keyed on the mode so switching Ctrl+P / Ctrl+Shift+P restarts the input. */}
      <Show when={ui.palette()} keyed>
        {(_mode) => <Palette />}
      </Show>
      <Show when={ui.shortcutsOpen()}>
        <Shortcuts />
      </Show>
      <Show when={ui.settingsOpen()}>
        <SettingsDialog />
      </Show>
      <Show when={ui.prompt()} keyed>
        {(p) => <PromptDialog title={p.title} label={p.label} onSubmit={p.onSubmit} />}
      </Show>
      <Show when={ui.batchRenameOpen()}>
        <BatchRename />
      </Show>
      <Show when={ui.lockPaths()} keyed>
        {(paths) => <LockHunter paths={paths} />}
      </Show>
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
  const finished = () => props.op.state === "finished";
  const fraction = () => {
    const p = o();
    if (p.totalBytes > 0) return p.doneBytes / p.totalBytes;
    return p.totalItems > 0 ? p.doneItems / p.totalItems : 0;
  };
  const summary = () => {
    const p = o();
    if (p.state === "queued") return "Waiting in queue";
    if (p.state === "paused") return `Paused at ${formatSize(p.doneBytes)}`;
    if (p.state === "finished") {
      if (p.cancelled) return "Cancelled";
      return p.errors.length ? `Finished with ${p.errors.length} problem${p.errors.length === 1 ? "" : "s"}` : "Done";
    }
    return p.totalBytes > 0 ? `${formatSize(p.doneBytes)} of ${formatSize(p.totalBytes)}` : `${p.doneItems} of ${p.totalItems} items`;
  };
  return (
    <div class="op-card" classList={{ failed: finished() && o().errors.length > 0 }}>
      <div class="op-top">
        <span class="op-label">{o().label}</span>
        <Show
          when={finished()}
          fallback={
            <span class="op-buttons">
              <Show when={o().state !== "queued"}>
                <button class="btn small" onClick={() => ops.togglePause(o())}>
                  {o().state === "paused" ? "Resume" : "Pause"}
                </button>
              </Show>
              <button class="btn small" onClick={() => ops.cancel(o())}>
                Cancel
              </button>
            </span>
          }
        >
          <button class="icon-btn" aria-label="Dismiss" onClick={() => ops.dismiss(o().key)}>
            <IconClose size={12} />
          </button>
        </Show>
      </div>
      <div class="progress" role="progressbar" aria-valuenow={Math.round(fraction() * 100)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${(finished() && !o().cancelled ? 1 : fraction()) * 100}%` }} />
      </div>
      <div class="op-sub">
        <span>{summary()}</span>
        <Show when={o().current}>{(c) => <span class="op-current">{baseName(c())}</span>}</Show>
      </div>
      <Show when={o().errors.length > 0}>
        <ul class="op-errors">
          <For each={o().errors.slice(0, 50)}>{(e) => <li title={e.path}>{e.message}</li>}</For>
        </ul>
        <Show when={o().errors.some((e) => e.path && /used by another|being used|access.denied|sharing/i.test(e.message))}>
          <button class="btn small op-hunt" onClick={() => ui.setLockPaths(o().errors.map((e) => e.path).filter(Boolean))}>
            What is locking these?
          </button>
        </Show>
      </Show>
    </div>
  );
}

function ContextMenu(props: { menu: MenuState }) {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal({ x: props.menu.x, y: props.menu.y });
  const [hot, setHot] = createSignal(-1);
  const [filter, setFilter] = createSignal("");
  const pinned = () => new Set(settings.pinnedActions());
  const items = createMemo(() => filterMenu<MenuItem>(props.menu.items, filter(), pinned()));
  const actionable = () => items().map((it, i) => (it !== "separator" && !it.disabled ? i : -1)).filter((i) => i >= 0);

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
    const list = actionable();
    const at = list.indexOf(hot());
    if (e.key === "Escape") ui.closeMenu();
    else if (e.key === "ArrowDown") setHot(list[(at + 1) % list.length]);
    else if (e.key === "ArrowUp") setHot(list[(at - 1 + list.length) % list.length]);
    else if (e.key === "Enter") {
      const target = hot() >= 0 ? items()[hot()] : items()[list[0]];
      if (target && target !== "separator") run(target);
    } else if (e.key === "Backspace") setFilter((f) => f.slice(0, -1));
    else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) setFilter((f) => f + e.key);
  };

  return (
    <div ref={el} class="menu" role="menu" tabIndex={-1} style={{ left: `${pos().x}px`, top: `${pos().y}px` }} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
      <Show when={filter()}>
        <div class="menu-filter">{filter()}</div>
      </Show>
      <For each={items() as MenuEntry[]}>
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
              <span
                class="menu-pin"
                classList={{ on: pinned().has(it.label) }}
                role="button"
                aria-label={`Pin ${it.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  settings.togglePinned(it.label);
                }}
              >
                ★
              </span>
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
