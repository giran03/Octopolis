// Keyboard shortcuts editor: record a new key or chord for any command.
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { allCommands, commandById, type Category, type Command } from "../commands";
import { fuzzyRank } from "../lib/fuzzy";
import { eventToKey, formatKeys } from "../lib/keymap";
import { keybindings } from "../state/keybindings";
import { settings } from "../state/settings";
import { ui } from "../state/ui";
import { IconReset, MaterialIcon } from "./Icons";

const CHORD_WAIT_MS = 900;

const CATEGORY_META: Record<Category, { icon: string; note?: string }> = {
  Navigate: { icon: "folder_open", note: "Move between folders, history, and the path bar." },
  File: { icon: "draft", note: "Create, rename, copy, delete, tag, and inspect items." },
  Tabs: { icon: "content_copy", note: "Open, close, pin, and switch tabs." },
  Panes: { icon: "swap_horiz", note: "Split panes and move focus between them." },
  View: { icon: "tune", note: "Switch layouts, zoom, sidebar, inspector, and terminal." },
  Search: { icon: "search", note: "Filter the current folder or search subfolders." },
  List: { icon: "rule", note: "Keyboard navigation and selection inside the file list." },
  App: { icon: "apps", note: "Command palette, settings, help guide, and window actions." },
  Actions: { icon: "bolt", note: "Your custom actions and folder rules." },
};

const CATEGORY_ORDER: readonly Category[] = ["Navigate", "File", "Tabs", "Panes", "View", "Search", "List", "App", "Actions"];

export function ShortcutsPanel() {
  const [filter, setFilter] = createSignal("");
  const [activeCategory, setActiveCategory] = createSignal<Category | "All">("All");
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
    setActiveCategory("All");
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

  const baseCommands = createMemo(() => allCommands().filter((c) => !c.hidden || c.vimKeys));

  const availableCategories = createMemo(() => {
    const present = new Set(baseCommands().map((c) => c.category));
    return CATEGORY_ORDER.filter((cat) => present.has(cat));
  });

  const visible = createMemo(() => {
    const cat = activeCategory();
    const list = cat === "All" ? baseCommands() : baseCommands().filter((c) => c.category === cat);
    return filter() ? fuzzyRank(filter(), list, (c) => `${c.category} ${c.title}`).map((r) => r.item) : list;
  });

  const sections = createMemo(() => {
    const byCat = new Map<Category, Command[]>();
    for (const c of visible()) {
      const bucket = byCat.get(c.category);
      if (bucket) bucket.push(c);
      else byCat.set(c.category, [c]);
    }
    const ordered: Array<{ category: Category; items: Command[] }> = [];
    for (const cat of CATEGORY_ORDER) {
      const items = byCat.get(cat);
      if (items?.length) ordered.push({ category: cat, items });
    }
    return ordered;
  });

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
      <div class="shortcut-cats" role="tablist" aria-label="Shortcut categories">
        <button
          class="shortcut-cat-chip"
          classList={{ active: activeCategory() === "All" }}
          role="tab"
          aria-selected={activeCategory() === "All"}
          onClick={() => setActiveCategory("All")}
        >
          All
        </button>
        <For each={availableCategories()}>
          {(cat) => (
            <button
              class="shortcut-cat-chip"
              classList={{ active: activeCategory() === cat }}
              role="tab"
              aria-selected={activeCategory() === cat}
              onClick={() => setActiveCategory(cat)}
            >
              <MaterialIcon name={CATEGORY_META[cat].icon} size={14} />
              <span>{cat}</span>
            </button>
          )}
        </For>
      </div>
      <div class="shortcuts-list">
        <For each={sections()} fallback={<p class="muted sres-none">No shortcuts match.</p>}>
          {(sec) => (
            <section class="sset shortcut-sec">
              <h3 class="sset-title shortcut-sec-title" data-outline-label={sec.category}>
                <MaterialIcon name={CATEGORY_META[sec.category].icon} size={15} />
                <span>{sec.category}</span>
                <span class="shortcut-sec-count">{sec.items.length}</span>
              </h3>
              <Show when={CATEGORY_META[sec.category].note}>
                {(note) => <p class="sset-note">{note()}</p>}
              </Show>
              <div class="sset-card shortcut-card">
                <For each={sec.items}>
                  {(c) => (
                    <div class="shortcut-row" data-command-id={c.id}>
                      <span class="shortcut-title">{c.title}</span>
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
            </section>
          )}
        </For>
      </div>
    </div>
  );
}
