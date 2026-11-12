// Windows shell icons for the list, cached by file type.
import { createSignal, type Accessor } from "solid-js";
import { settings } from "./settings";
import { thumbnail } from "../lib/ipc";
import { extensionOf } from "../lib/paths";

const ICON_PX = 32;
/** These types have a different icon per file. */
const PER_FILE = new Set(["exe", "lnk", "ico", "url", "cur", "msi", "scr", "cpl", "appx", "msix", "appref-ms"]);
const RETRY_MS = [250, 1000, 3000];
const isDriveRoot = (path: string) => /^[a-z]:[\\/]?$/i.test(path);

const cache = new Map<string, Accessor<string | null>>();
/** Per-file icons (exe, lnk...) in least recently used order; type icons are few and stay. */
const perFile = new Map<string, (url: string | null) => void>();
/** Enough for any folder on screen; browsing System32 and the like no longer grows memory without end. */
const MAX_PER_FILE = 1500;

/** Forgets the least recently used per-file icons beyond the cap. A row still showing one falls back to its type icon. */
function trimPerFile() {
  while (perFile.size > MAX_PER_FILE) {
    const [key, setUrl] = perFile.entries().next().value!;
    perFile.delete(key);
    const u = cache.get(key)?.();
    cache.delete(key);
    setUrl(null);
    if (u) URL.revokeObjectURL(u);
  }
}

export const iconCacheCount = () => cache.size;
export function clearIconCache() {
  for (const get of cache.values()) {
    const u = get();
    if (u) URL.revokeObjectURL(u);
  }
  cache.clear();
  perFile.clear();
}

function keyFor(path: string, name: string, isDir: boolean): string {
  if (isDir) return "<folder>";
  const ext = extensionOf(name);
  if (!ext) return "<none>";
  return PER_FILE.has(ext) ? path.toLowerCase() : ext;
}

const NO_ICON: Accessor<string | null> = () => null;

/** The icon's object URL, or null until it arrives (or if there is none). */
/** `exact` asks for this very path's icon (drives, Desktop, Downloads...) instead of the shared one for its type. */
export function iconFor(path: string, name: string, isDir: boolean, exact = false): Accessor<string | null> {
  if (!settings.shellIcons()) return NO_ICON;
  // A drive always has its own icon, so it never shares the generic folder icon.
  const key = exact || isDriveRoot(path) ? `path:${path.toLowerCase()}` : keyFor(path, name, isDir);
  const known = cache.get(key);
  if (known) {
    const touch = perFile.get(key);
    if (touch) {
      perFile.delete(key);
      perFile.set(key, touch);
    }
    return known;
  }
  const [url, setUrl] = createSignal<string | null>(null);
  cache.set(key, url);
  // Per-file keys are paths; type keys are a bare extension or a <tag>.
  if (!key.startsWith("<") && !key.startsWith("path:") && /[\\/]/.test(key)) {
    perFile.set(key, setUrl);
    trimPerFile();
  }
  const load = (attempt: number) =>
    thumbnail(path, ICON_PX, true).then(
      (buf) => {
        if (cache.get(key) === url) setUrl(URL.createObjectURL(new Blob([buf], { type: "image/png" })));
      },
      () => {
        // The shell can be busy or a drive still waking up: try again shortly, keeping the drawn icon meanwhile.
        if (attempt < RETRY_MS.length && cache.get(key) === url) setTimeout(() => load(attempt + 1), RETRY_MS[attempt]);
        else if (cache.get(key) === url) {
          cache.delete(key); // give up; a later file of this type tries again
          perFile.delete(key);
        }
      },
    );
  void load(0);
  return url;
}
