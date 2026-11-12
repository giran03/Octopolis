// Custom folder icons: an emoji per folder, kept on this computer (local storage).
import { createRoot, createSignal } from "solid-js";
import { loadJson, saveJson } from "./settings";

const KEY = "octopolis.folderIcons.v1";
const RECENT_KEY = "octopolis.folderIcons.recent.v1";
const MAX_RECENT = 24;
const MAX_ICONS = 5000;

/** Case-insensitive key for a folder path, without a trailing separator. */
export const iconKey = (path: string) => path.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();

/** An emoji is a short run of graphemes; reject anything that looks like arbitrary text. */
export function isEmoji(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 32) return false;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}]|[#*0-9]️?⃣/u.test(v);
}

export const folderIcons = createRoot(() => {
  const clean = (raw: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (typeof raw !== "object" || raw === null) return out;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && isEmoji(v)) out[k] = v;
    }
    return out;
  };
  const [icons, setIcons] = createSignal<Readonly<Record<string, string>>>(clean(loadJson<unknown>(KEY, {})));
  const [recent, setRecent] = createSignal<readonly string[]>(loadJson<string[]>(RECENT_KEY, []).filter(isEmoji).slice(0, MAX_RECENT));

  const save = (next: Record<string, string>) => {
    setIcons(next);
    saveJson(KEY, next);
  };

  return {
    /** The emoji chosen for `path`, if any. Reactive. */
    get: (path: string): string | undefined => icons()[iconKey(path)],
    /** Sets (or, with null, removes) the emoji for a folder. */
    set(path: string, emoji: string | null) {
      const key = iconKey(path);
      const next = { ...icons() };
      if (emoji === null) {
        delete next[key];
      } else {
        if (!isEmoji(emoji)) return;
        if (!(key in next) && Object.keys(next).length >= MAX_ICONS) return;
        next[key] = emoji;
        const r = [emoji, ...recent().filter((e) => e !== emoji)].slice(0, MAX_RECENT);
        setRecent(r);
        saveJson(RECENT_KEY, r);
      }
      save(next);
    },
    /** Moves a folder's emoji (and its subfolders') when the folder is renamed or moved. */
    move(from: string, to: string) {
      const a = iconKey(from);
      const b = iconKey(to);
      if (a === b) return;
      const cur = icons();
      const next: Record<string, string> = {};
      let changed = false;
      for (const [k, v] of Object.entries(cur)) {
        if (k === a || k.startsWith(`${a}\\`)) {
          next[`${b}${k.slice(a.length)}`] = v;
          changed = true;
        } else {
          next[k] = v;
        }
      }
      if (changed) save(next);
    },
    count: () => Object.keys(icons()).length,
    recent,
    clear: () => save({}),
  };
});
