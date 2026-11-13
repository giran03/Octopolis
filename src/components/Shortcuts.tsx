// Keyboard shortcuts editor: record a new key or chord for any command.
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { allCommands, commandById } from "../commands";
import { fuzzyRank } from "../lib/fuzzy";
import { eventToKey, formatKeys } from "../lib/keymap";
import { keybindings } from "../state/keybindings";
import { settings } from "../state/settings";
import { ui } from "../state/ui";
import { IconReset } from "./Icons";

const CHORD_WAIT_MS = 900;

export function ShortcutsPanel() {
  const [filter, setFilter] = createSignal("");
  const [recording, setRecording] = createSignal<string | null>(null);
  const [captured, setCaptured] = createSignal<string[]>([]);
  let filterInput!: HTMLInputElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastNonce = 0;
  onCleanup(() => clearTimeout(timer));

  createEffect(() => {
    const req = ui.shortcutFilter();
    if (!req || req.nonce === lastNonce) return;
    lastNonce = req.nonce;
    setFilter(req.filter);
    queueMicrotask(() => {
      const row = req.commandId
        ? document.querySelector<HTMLElement>(`.shortcut-row[data-command-id="${CSS.escape(req.commandId)}"]`)
        : null;
      if (row) {
        row.scrollIntoView({ block: "center", behavior: "smooth" });
        row.classList.add("srow-flash");
        setTimeout(() => row.classList.remove("srow-flash"), 1400);
        row.querySelector<HTMLButtonElement>(".shortcut-actions button")?.focus();
      } else {
        filterInput?.focus();
      }
      ui.clearShortcutFilter();
    });
  });

  const visible = () => {
    const list = allCommands().filter((c) => !c.hidden || c.vimKeys);
    return filter() ? fuzzyRank(filter(), list, (c) => `${c.category} ${c.title}`).map((r) => r.item) : list;
  };

  const commit = (id: string, seq: string) => {
    const other = keybindings.conflict(seq, id);
    keybindings.set(id, [seq]);
    if (other) ui.toast(`${formatKeys(seq)} was also used by "${commandById(other)?.title}"; that shortcut now does both — change one of them`);
    setRecording(null);
    setCaptured([]);
  };

  const onKey = (e: KeyboardEvent) => {
    const id = recording();
    if (!id) return;
    // Only while recording a key: otherwise Esc and Tab keep working for the modal.
    e.stopPropagation();
    e.preventDefault();
    if (e.key === "Escape") {
      setRecording(null);
      setCaptured([]);
      return;
    }
    const key = eventToKey(e);
    if (!key) return;
    const parts = [...captured(), key];
    setCaptured(parts);
    clearTimeout(timer);
    // Wait briefly for a second key so chords like Ctrl+K Ctrl+S can be entered.
    if (parts.length >= 2) commit(id, parts.join(" "));
    else timer = setTimeout(() => commit(id, parts.join(" ")), CHORD_WAIT_MS);
  };

  return (
    <div class="shortcuts-panel" onKeyDown={onKey}>
        <input
          ref={filterInput}
          class="text-input"
          placeholder="Filter commands"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
        <div class="shortcuts-list">
          <For each={visible()}>
            {(c) => (
              <div class="shortcut-row" data-command-id={c.id}>
                <span class="shortcut-title">
                  <span class="muted">{c.category}:</span> {c.title}
                </span>
                <span class="shortcut-keys">
                  <Show
                    when={recording() === c.id}
                    fallback={
                      <>
                        <For each={keybindings.keysFor(c)}>{(k) => <kbd>{formatKeys(k)}</kbd>}</For>
                        <Show when={settings.vimMode() && c.vimKeys}>
                          <For each={c.vimKeys}>{(k) => <kbd class="vim">{k}</kbd>}</For>
                        </Show>
                      </>
                    }
                  >
                    <kbd class="recording">{captured().length ? formatKeys(captured().join(" ")) : "Press keys…"}</kbd>
                  </Show>
                </span>
                <span class="shortcut-actions">
                  <button class="btn small" onClick={() => (setCaptured([]), setRecording(c.id))}>
                    Change
                  </button>
                  <Show when={keybindings.isCustom(c.id)}>
                    <button class="btn small icon-btn" title="Reset to default" aria-label="Reset to default" onClick={() => keybindings.reset(c.id)}>
                      <IconReset size={16} />
                    </button>
                  </Show>
                </span>
              </div>
            )}
          </For>
        </div>
    </div>
  );
}
