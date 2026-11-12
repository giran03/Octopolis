// Floating UI: operations tray, context menu, confirmation dialog, toasts.
import { createMemo, createSignal, For, Index, lazy, onCleanup, onMount, Show } from "solid-js";
import { formatSize } from "../lib/format";
import { baseName } from "../lib/paths";
import { ops, type OpView } from "../state/ops";
import { clampMenuPosition, filterMenu, MENU_EDGE_GAP } from "../lib/menu";
import { settings } from "../state/settings";
import { ui, type MenuEntry, type MenuItem, type MenuState } from "../state/ui";
import { ConflictDialog } from "./ConflictDialog";
import { TaggedList, TagsDialog } from "./Tags";
import { PromptDialog } from "./Extras";
import { IconClose, IconStarFill } from "./Icons";
import { Palette } from "./Palette";

// Dialogs opened now and then load on first use, keeping them out of startup parsing and memory.
// The conflict prompt and palette stay eager: they must appear the instant they are needed.
const DiskSpaceModal = lazy(() => import("./DiskSpaceModal").then((m) => ({ default: m.DiskSpaceModal })));
const PropertiesDialog = lazy(() => import("./PropertiesDialog").then((m) => ({ default: m.PropertiesDialog })));
const RecycleBin = lazy(() => import("./RecycleBin").then((m) => ({ default: m.RecycleBin })));
const SystemCleanup = lazy(() => import("./SystemCleanup").then((m) => ({ default: m.SystemCleanup })));
const OpsHistory = lazy(() => import("./OpsHistory").then((m) => ({ default: m.OpsHistory })));
const Welcome = lazy(() => import("./Welcome").then((m) => ({ default: m.Welcome })));
const Rules = lazy(() => import("./Rules").then((m) => ({ default: m.Rules })));
const ImageTools = lazy(() => import("./ImageTools").then((m) => ({ default: m.ImageTools })));
const Duplicates = lazy(() => import("./Duplicates").then((m) => ({ default: m.Duplicates })));
const ActionsEditor = lazy(() => import("./ActionsEditor").then((m) => ({ default: m.ActionsEditor })));
const Cleanup = lazy(() => import("./Cleanup").then((m) => ({ default: m.Cleanup })));
const BatchRename = lazy(() => import("./Dialogs").then((m) => ({ default: m.BatchRename })));
const LockHunter = lazy(() => import("./Dialogs").then((m) => ({ default: m.LockHunter })));
const EmojiPicker = lazy(() => import("./EmojiPicker").then((m) => ({ default: m.EmojiPicker })));
const SettingsModal = lazy(() => import("./settings/SettingsModal").then((m) => ({ default: m.SettingsModal })));

export function Overlays() {
  return (
    <>
      <OpsTray />
      <Show when={ui.menu()} keyed>
        {(m) => <ContextMenu menu={m} />}
      </Show>
      <ConfirmDialog />
      <Show when={ui.cleanupRoot()} keyed>
        {(root) => <Cleanup root={root} />}
      </Show>
      <Show when={ui.actionsEditorOpen()}>
        <ActionsEditor />
      </Show>
      <Show when={ui.tagPaths()} keyed>
        {(paths) => <TagsDialog paths={paths} />}
      </Show>
      <Show when={ui.taggedView()} keyed>
        {(tag) => <TaggedList tag={tag} />}
      </Show>
      <Show when={ui.duplicatesRoot()} keyed>
        {(root) => <Duplicates root={root} />}
      </Show>
      <Show when={ui.imageToolsPaths()} keyed>
        {(paths) => <ImageTools paths={paths} />}
      </Show>
      <Show when={ui.rulesOpen()}>
        <Rules />
      </Show>
      <Show when={ui.welcomeOpen()}>
        <Welcome />
      </Show>
      <Show when={ui.opsHistoryOpen()}>
        <OpsHistory />
      </Show>
      <Show when={ui.systemCleanupOpen()}>
        <SystemCleanup />
      </Show>
      <Show when={ui.recycleBinOpen()}>
        <RecycleBin />
      </Show>
      <Show when={ui.diskSpaceRoot()} keyed>
        {(root) => <DiskSpaceModal root={root} />}
      </Show>
      <Show when={ui.propertiesPaths()} keyed>
        {(paths) => <PropertiesDialog paths={paths} />}
      </Show>
      <Show when={ui.conflictPrompt()} keyed>
        {(p) => <ConflictDialog prompt={p} />}
      </Show>
      {/* Keyed on the mode so switching Ctrl+P / Ctrl+Shift+P restarts the input. */}
      <Show when={ui.palette()} keyed>
        {(_mode) => <Palette />}
      </Show>
      <Show when={ui.settingsOpen()}>
        <SettingsModal />
      </Show>
      <Show when={ui.prompt()} keyed>
        {(p) => <PromptDialog title={p.title} label={p.label} initial={p.initial} submitLabel={p.submitLabel} onSubmit={p.onSubmit} />}
      </Show>
      <Show when={ui.emojiTarget()} keyed>
        {(path) => <EmojiPicker path={path} />}
      </Show>
      <Show when={ui.batchRenameOpen()}>
        <BatchRename />
      </Show>
      <Show when={ui.lockPaths()} keyed>
        {(paths) => <LockHunter paths={paths} />}
      </Show>
      <div class="toasts" role="status" aria-live="polite">
        <For each={ui.toasts()}>
          {(t) => (
            <div class="toast">
              <span>{t.text}</span>
              <Show when={t.action}>
                {(a) => (
                  <button
                    class="btn small toast-action"
                    onClick={() => {
                      ui.dismissToast(t.key);
                      a().onClick();
                    }}
                  >
                    <span>{a().label}</span>
                    <Show when={a().shortcut}>
                      <kbd>{a().shortcut}</kbd>
                    </Show>
                  </button>
                )}
              </Show>
            </div>
          )}
        </For>
      </div>
    </>
  );
}

function OpsTray() {
  return (
    <div class="ops-tray" role="region" aria-label="File operations">
      <For each={ops.list()}>{(o) => <OpCard op={o} />}</For>
      {/* Screen readers hear when a job starts and ends, not every progress tick. */}
      <div class="sr-only" role="status" aria-live="polite">
        <Index each={ops.list()}>{(o) => <p>{`${o().label}: ${spokenState(o())}`}</p>}</Index>
      </div>
    </div>
  );
}

function spokenState(o: OpView): string {
  if (o.state === "queued") return "waiting";
  if (o.state === "paused") return "paused";
  if (o.state !== "finished") return "started";
  if (o.cancelled) return "cancelled";
  return o.errors.length ? `finished with ${o.errors.length} problems` : "done";
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
      <div class="progress" role="progressbar" aria-label={o().label} aria-valuenow={Math.round(fraction() * 100)} aria-valuemin={0} aria-valuemax={100}>
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
  const zoom = () => Math.max(0.1, settings.uiScale() / 100);
  const [pos, setPos] = createSignal({ x: props.menu.x / zoom(), y: props.menu.y / zoom() });
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
    const place = () => {
      const z = zoom();
      el.style.maxHeight = `${Math.max(120, (window.innerHeight - MENU_EDGE_GAP * 2) / z)}px`;
      // Use offsetWidth/offsetHeight so the entry scale(0.97) animation never shrinks the measured size.
      const menuW = el.offsetWidth * z;
      const menuH = el.offsetHeight * z;
      setPos(clampMenuPosition(props.menu.x, props.menu.y, menuW, menuH, window.innerWidth, window.innerHeight, z));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    el.focus();
    const away = (e: MouseEvent) => !el.contains(e.target as Node) && ui.closeMenu();
    const blur = () => ui.closeMenu();
    window.addEventListener("mousedown", away, true);
    window.addEventListener("blur", blur);
    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener("resize", place);
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
              <span class="menu-label">{it.label}</span>
              <Show when={it.shortcut}>
                <kbd>{it.shortcut}</kbd>
              </Show>
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
                <IconStarFill size={18} />
              </span>
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
