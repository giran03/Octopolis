// Custom folder icons: an emoji, an uploaded picture, or the Windows icon of a special folder (Documents, 3D Objects...), per folder,
// kept on this computer (local storage).
import { createRoot, createSignal } from "solid-js";
import { folderIconStyles, type KnownFolder } from "../lib/ipc";
import { loadJson, saveJson } from "./settings";

const KEY = "octopolis.folderIcons.v1";
const RECENT_KEY = "octopolis.folderIcons.recent.v1";
const MAX_RECENT = 24;
const IMAGES_KEY = "octopolis.folderIcons.images.v1";
const MAX_ICONS = 5000;
const MAX_IMAGES = 200;
const MAX_IMAGE_CHARS = 2_000_000;

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

/** An uploaded picture is stored as "img:<id>"; the picture itself lives in a separate library. */
export const isImageValue = (value: string) => /^img:[0-9a-f]{16}$/.test(value);
const DATA_URL = /^data:(?:image\/(?:png|gif|webp|apng|avif|jpeg|svg\+xml|x-icon|bmp)|video\/(?:webm|mp4|quicktime|ogg));base64,[A-Za-z0-9+/=]+$/i;

/** A short content hash, so uploading the same picture twice stores it once. */
function imageId(data: string): string {
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (b >>> 0).toString(16).padStart(8, "0") + (a >>> 0).toString(16).padStart(8, "0");
}

export const folderIcons = createRoot(() => {
  const cleanImages = (raw: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (typeof raw !== "object" || raw === null) return out;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (isImageValue(k) && typeof v === "string" && v.length <= MAX_IMAGE_CHARS && DATA_URL.test(v)) out[k] = v;
    }
    return out;
  };
  const [images, setImages] = createSignal<Readonly<Record<string, string>>>(cleanImages(loadJson<unknown>(IMAGES_KEY, {})));
  /** Stores the image library; false when storage is full or blocked (the pictures then last this session only). */
  const saveImages = (next: Record<string, string>): boolean => {
    setImages(next);
    try {
      localStorage.setItem(IMAGES_KEY, JSON.stringify(next));
      return true;
    } catch {
      return false;
    }
  };
  const clean = (raw: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (typeof raw !== "object" || raw === null) return out;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && (isEmoji(v) || isSystemValue(v) || (isImageValue(v) && v in images()))) out[k] = v;
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
    /** The emoji (or "img:<id>" uploaded picture, see `imageUrl`) chosen for `path`, if any. Reactive. */
    get: (path: string): string | undefined => {
      const v = icons()[iconKey(path)];
      return v !== undefined && !isSystemValue(v) && (!isImageValue(v) || v in images()) ? v : undefined;
    },
    /** The picture behind an "img:<id>" value, as a data URL. Reactive. */
    imageUrl: (value: string): string | undefined => (isImageValue(value) ? images()[value] : undefined),
    /** Every uploaded picture, newest first. Reactive. */
    images: (): readonly { value: string; url: string }[] =>
      Object.entries(images())
        .map(([value, url]) => ({ value, url }))
        .reverse(),
    /** Adds a picture or short looping video data URL to the library and returns its value, or null when it can't be kept. */
    addImage(dataUrl: string): { value: string; saved: boolean } | null {
      if (!DATA_URL.test(dataUrl) || dataUrl.length > MAX_IMAGE_CHARS) return null;
      const value = `img:${imageId(dataUrl)}`;
      const cur = images();
      if (value in cur) return { value, saved: true };
      if (Object.keys(cur).length >= MAX_IMAGES) return null;
      return { value, saved: saveImages({ ...cur, [value]: dataUrl }) };
    },
    /** Deletes an uploaded picture; folders that wore it go back to their normal icon. */
    removeImage(value: string) {
      if (!(value in images())) return;
      const rest = { ...images() };
      delete rest[value];
      saveImages(rest);
      const entries = Object.entries(icons());
      const kept = entries.filter(([, v]) => v !== value);
      if (kept.length !== entries.length) save(Object.fromEntries(kept));
    },
    /** Whether `path` has any custom icon (an emoji, an uploaded picture or a borrowed Windows icon). */
    has: (path: string) => iconKey(path) in icons(),
    /** A short note on the custom icon `path` has, for menus: the emoji itself, or what kind of Windows icon it wears. */
    describe: (path: string): string | undefined => {
      const v = icons()[iconKey(path)];
      if (v === undefined) return undefined;
      if (isImageValue(v)) return images()[v]?.startsWith("data:video/") ? "Custom video" : "Custom image";
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
        const image = isImageValue(emoji);
        if (image && !(emoji in images())) return;
        const system = isSystemValue(emoji);
        if (!image && !system && !isEmoji(emoji)) return;
        if (!(key in next) && Object.keys(next).length >= MAX_ICONS) return;
        next[key] = emoji;
        if (!system && !image) {
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
