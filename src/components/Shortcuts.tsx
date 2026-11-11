// Keyboard shortcuts editor: record a new key or chord for any command.
import { createSignal, For, onCleanup, Show } from "solid-js";
import { COMMANDS, commandById } from "../commands";
import { fuzzyRank } from "../lib/fuzzy";
import { eventToKey, formatKeys } from "../lib/keymap";
import { keybindings } from "../state/keybindings";
import { settings } from "../state/settings";
import { ui } from "../state/ui";

const CHORD_WAIT_MS = 900;

export function Shortcuts() {
  const [filter, setFilter] = createSignal("");
  const [recording, setRecording] = createSignal<string | null>(null);
  const [captured, setCaptured] = createSignal<string[]>([]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  const visible = () => {
    const list = COMMANDS.filter((c) => !c.hidden || c.vimKeys);
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
    e.stopPropagation();
    const id = recording();
    if (!id) {
      if (e.key === "Escape") ui.setShortcutsOpen(false);
      return;
    }
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
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && ui.setShortcutsOpen(false)}>
      <div class="dialog shortcuts" role="dialog" aria-label="Keyboard shortcuts" onKeyDown={onKey}>
        <div class="shortcuts-head">
          <h2>Keyboard shortcuts</h2>
          <label class="check">
            <input type="checkbox" checked={settings.vimMode()} onChange={() => settings.toggleVim()} /> Vim keys
          </label>
        </div>
        <input
          class="text-input"
          placeholder="Filter commands"
          value={filter()}
          ref={(el) => queueMicrotask(() => el.focus())}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
        <div class="shortcuts-list">
          <For each={visible()}>
            {(c) => (
              <div class="shortcut-row">
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
                    <button class="btn small" onClick={() => keybindings.reset(c.id)}>
                      Reset
                    </button>
                  </Show>
                </span>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
