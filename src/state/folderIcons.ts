// Custom folder icons: an emoji, or the Windows icon of a special folder (Documents, 3D Objects...), per folder,
// kept on this computer (local storage).
import { createRoot, createSignal } from "solid-js";
import { folderIconStyles, type KnownFolder } from "../lib/ipc";
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

/** A borrowed Windows folder icon is stored as "sys:<id>" (documents, downloads, 3dobjects...). */
const SYSTEM_VALUE = /^(sys:[a-z0-9]{1,24}|res:[a-z0-9]{3,10}:\d{1,5}|app:[A-Za-z0-9 ._!{}\-:\\()&'+,]{1,260})$/;
export const isSystemValue = (value: string) => SYSTEM_VALUE.test(value) && !value.includes("..");
/** A special folder's icon ("sys:documents"), an app's ("app:<Start menu id>") or one inside a system file ("res:imageres:109"). */
export const systemValue = (id: string) => `sys:${id}`;
export const appValue = (id: string) => `app:${id}`;
export const resourceValue = (dll: string, index: number) => `res:${dll}:${index}`;

export const folderIcons = createRoot(() => {
  const clean = (raw: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (typeof raw !== "object" || raw === null) return out;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && (isEmoji(v) || isSystemValue(v))) out[k] = v;
    }
    return out;
  };
  const [icons, setIcons] = createSignal<Readonly<Record<string, string>>>(clean(loadJson<unknown>(KEY, {})));
  const [recent, setRecent] = createSignal<readonly string[]>(loadJson<string[]>(RECENT_KEY, []).filter(isEmoji).slice(0, MAX_RECENT));

  const save = (next: Record<string, string>) => {
    setIcons(next);
    saveJson(KEY, next);
  };

  // The special folders whose icons can be borrowed, asked of Windows once and only when needed.
  const [styles, setStyles] = createSignal<readonly KnownFolder[] | null>(null);
  let loadingStyles = false;
  const loadStyles = () => {
    if (styles() || loadingStyles) return;
    loadingStyles = true;
    folderIconStyles()
      .then(setStyles, () => setStyles([]))
      .finally(() => (loadingStyles = false));
  };
  if (Object.values(icons()).some(isSystemValue)) loadStyles();

  return {
    /** The emoji chosen for `path`, if any. Reactive. */
    get: (path: string): string | undefined => {
      const v = icons()[iconKey(path)];
      return v !== undefined && !isSystemValue(v) ? v : undefined;
    },
    /** Whether `path` has any custom icon (an emoji or a borrowed Windows icon). */
    has: (path: string) => iconKey(path) in icons(),
    /** A short note on the custom icon `path` has, for menus: the emoji itself, or what kind of Windows icon it wears. */
    describe: (path: string): string | undefined => {
      const v = icons()[iconKey(path)];
      if (v === undefined) return undefined;
      if (!isSystemValue(v)) return v;
      return v.startsWith("app:") ? "App icon" : v.startsWith("res:") ? "Windows icon" : "Folder icon";
    },
    /** The folder whose Windows icon `path` shows instead of its own, once Windows has said where that is. */
    source: (path: string): string | undefined => {
      const v = icons()[iconKey(path)];
      if (v === undefined || !isSystemValue(v)) return undefined;
      // An app's icon is asked of the shell by its Start menu id; an icon in a system file by "res:<file>,<number>".
      if (v.startsWith("app:")) return `shell:AppsFolder\\${v.slice(4)}`;
      if (v.startsWith("res:")) {
        const [, dll, index] = v.split(":");
        return `res:${dll},${index}`;
      }
      loadStyles();
      return styles()?.find((s) => systemValue(s.id) === v)?.path;
    },
    /** The Windows folder icons available on this PC (empty until loaded). */
    styles: (): readonly KnownFolder[] => {
      loadStyles();
      return styles() ?? [];
    },
    /** The borrowed icon chosen for `path`, as its id. */
    systemId: (path: string): string | undefined => {
      const v = icons()[iconKey(path)];
      return v !== undefined && v.startsWith("sys:") ? v.slice(4) : undefined;
    },
    /** The stored value when `path` wears any Windows icon (special folder, app or system icon). */
    systemValueOf: (path: string): string | undefined => {
      const v = icons()[iconKey(path)];
      return v !== undefined && isSystemValue(v) ? v : undefined;
    },
    /** Sets (or, with null, removes) the icon for a folder: an emoji, or a "sys:<id>" Windows folder icon. */
    set(path: string, emoji: string | null) {
      const key = iconKey(path);
      const next = { ...icons() };
      if (emoji === null) {
        delete next[key];
      } else {
        const system = isSystemValue(emoji);
        if (!system && !isEmoji(emoji)) return;
        if (!(key in next) && Object.keys(next).length >= MAX_ICONS) return;
        next[key] = emoji;
        if (!system) {
          const r = [emoji, ...recent().filter((e) => e !== emoji)].slice(0, MAX_RECENT);
          setRecent(r);
          saveJson(RECENT_KEY, r);
        }
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
