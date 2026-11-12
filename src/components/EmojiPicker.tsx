import { createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import { createSupportCheck, loadEmojiFonts } from "../lib/emojiSupport";
import { baseName } from "../lib/paths";
import { folderIcons } from "../state/folderIcons";
import { ui } from "../state/ui";

type Entry = readonly [emoji: string, label: string, tags?: string];

/** Unicode's emoji groups, in order, each with a representative emoji for its tab. */
export const EMOJI_GROUPS = [
  { name: "Smileys & Emotion", icon: "😀" },
  { name: "People & Body", icon: "👋" },
  { name: "Component", icon: "🦰" },
  { name: "Animals & Nature", icon: "🐻" },
  { name: "Food & Drink", icon: "🍎" },
  { name: "Travel & Places", icon: "🚗" },
  { name: "Activities", icon: "⚽" },
  { name: "Objects", icon: "💡" },
  { name: "Symbols", icon: "❤️" },
  { name: "Flags", icon: "🏁" },
] as const;

/** Flags the bundled flag font has no artwork for (it draws letter tiles instead). */
const NO_GLYPH = new Set(["🇨🇶"]);
const SEARCH_LIMIT = 240;
const RECENT = -1;

/** Hair styles and skin tones: building blocks, not useful as icons on their own. */
const HIDDEN_GROUPS = new Set<string>(["Component"]);
const isHidden = (i: number) => HIDDEN_GROUPS.has(EMOJI_GROUPS[i]?.name ?? "");

/** Emoji this PC can't draw, remembered so later opens skip the slow per-emoji drawing test. */
const UNSUPPORTED_KEY = "octopolis.emoji.unsupported.v1";
/** Emoji tested per slice (~3 ms each). */
const TEST_SLICE = 12;

function readUnsupported(signature: string): Set<string> | null {
  try {
    const saved = JSON.parse(localStorage.getItem(UNSUPPORTED_KEY) ?? "null") as { signature: string; emoji: string[] } | null;
    return saved?.signature === signature ? new Set(saved.emoji) : null;
  } catch {
    return null;
  }
}

function saveUnsupported(signature: string, emoji: string[]) {
  try {
    localStorage.setItem(UNSUPPORTED_KEY, JSON.stringify({ signature, emoji }));
  } catch {
    // Storage full or blocked: the test just runs again next time.
  }
}

async function loadEmoji(): Promise<Entry[][]> {
  const [m] = await Promise.all([import("../data/emoji.json"), loadEmojiFonts()]);
  const groups = (m.default as unknown as Entry[][]).map((g, i) => (isHidden(i) ? [] : g));
  // A WebView2 update (new user agent) or a new emoji list runs the test again.
  const signature = `${navigator.userAgent}|${groups.reduce((n, g) => n + g.length, 0)}`;
  let unsupported = readUnsupported(signature);
  if (!unsupported) {
    // Leave out emoji this Windows can't draw (they would show as empty boxes).
    // The test takes seconds in all, so it runs in short slices that keep the window responsive.
    const supported = createSupportCheck();
    const all = groups.flat().map(([emoji]) => emoji);
    unsupported = new Set<string>();
    for (let i = 0; i < all.length; i += TEST_SLICE) {
      for (const emoji of all.slice(i, i + TEST_SLICE)) if (!supported(emoji)) unsupported.add(emoji);
      await new Promise((r) => setTimeout(r));
    }
    saveUnsupported(signature, [...unsupported]);
  }
  return groups.map((g) => g.filter(([emoji]) => !NO_GLYPH.has(emoji) && !unsupported.has(emoji)));
}

/** Loaded once per run and shared by every open of the picker. */
let emojiPromise: Promise<Entry[][]> | null = null;
const getEmoji = () => {
  emojiPromise ??= loadEmoji().catch((e: unknown) => {
    emojiPromise = null;
    throw e;
  });
  return emojiPromise;
};

// Warm up while the app is idle, so the picker opens instantly the first time too.
if (typeof window !== "undefined") {
  const warm = () => void getEmoji().catch(() => undefined);
  setTimeout(() => ("requestIdleCallback" in window ? requestIdleCallback(warm, { timeout: 10_000 }) : warm()), 4000);
}

export function EmojiPicker(props: { path: string }) {
  let search!: HTMLInputElement;
  const [data] = createResource(getEmoji);
  const [query, setQuery] = createSignal("");
  const hasRecent = () => folderIcons.recent().length > 0;
  const [group, setGroup] = createSignal<number>(hasRecent() ? RECENT : 0);
  const current = () => folderIcons.get(props.path);

  onMount(() => search.focus());

  const results = createMemo<readonly (readonly [string, string])[]>(() => {
    const all = data();
    if (!all) return [];
    const q = query().trim().toLowerCase();
    if (q) {
      const words = q.split(/\s+/);
      const named: (readonly [string, string])[] = [];
      const tagged: (readonly [string, string])[] = [];
      for (const g of all) {
        for (const [emoji, label, tags] of g) {
          const name = label.toLowerCase();
          if (words.every((w) => name.includes(w))) named.push([emoji, label]);
          else if (words.every((w) => `${name} ${tags ?? ""}`.toLowerCase().includes(w))) tagged.push([emoji, label]);
        }
      }
      return [...named, ...tagged].slice(0, SEARCH_LIMIT);
    }
    if (group() === RECENT) return folderIcons.recent().map((e) => [e, ""] as const);
    return (all[group()] ?? []).map(([e, l]) => [e, l] as const);
  });

  const close = () => ui.setEmojiTarget(null);
  const choose = (emoji: string | null) => {
    folderIcons.set(props.path, emoji);
    close();
  };

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="dialog emoji-picker"
        role="dialog"
        aria-label="Choose a folder icon"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") close();
        }}
      >
        <h2>
          Folder icon <span class="emoji-for">{baseName(props.path) || props.path}</span>
        </h2>
        <input
          ref={search}
          class="text-input"
          type="search"
          placeholder="Search emoji (cat, music, heart…)"
          spellcheck={false}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <div class="emoji-tabs" role="tablist" aria-label="Emoji categories">
          <Show when={hasRecent()}>
            <button
              class="emoji-tab"
              classList={{ active: !query() && group() === RECENT }}
              role="tab"
              aria-selected={!query() && group() === RECENT}
              data-tooltip="Recent"
              onClick={() => (setQuery(""), setGroup(RECENT))}
            >
              <span class="emoji">🕘</span>
            </button>
          </Show>
          <For each={EMOJI_GROUPS}>
            {(g, i) => (
              <Show when={!isHidden(i())}>
                <button
                  class="emoji-tab"
                  classList={{ active: !query() && group() === i() }}
                  role="tab"
                  aria-selected={!query() && group() === i()}
                  data-tooltip={g.name}
                  onClick={() => (setQuery(""), setGroup(i()))}
                >
                  <span class="emoji">{g.icon}</span>
                </button>
              </Show>
            )}
          </For>
        </div>
        <div class="emoji-heading">{query() ? `Results for “${query().trim()}”` : group() === RECENT ? "Recent" : EMOJI_GROUPS[group()].name}</div>
        <div class="emoji-grid" role="listbox" aria-label="Emoji">
          <Show when={!data.loading} fallback={<div class="emoji-empty">Loading…</div>}>
            <For each={results()} fallback={<div class="emoji-empty">No emoji match that</div>}>
              {([emoji, label]) => (
                <button class="emoji-cell" classList={{ chosen: emoji === current() }} role="option" aria-selected={emoji === current()} title={label} onClick={() => choose(emoji)}>
                  <span class="emoji">{emoji}</span>
                </button>
              )}
            </For>
          </Show>
        </div>
        <div class="dialog-actions">
          <Show when={current()}>
            <button class="btn" onClick={() => choose(null)}>
              Use the default icon
            </button>
          </Show>
          <button class="btn" onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
