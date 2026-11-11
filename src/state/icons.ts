// Windows shell icons for the list, cached by file type.
import { createSignal, type Accessor } from "solid-js";
import { settings } from "./settings";
import { thumbnail } from "../lib/ipc";
import { extensionOf } from "../lib/paths";

const ICON_PX = 32;
/** These types have a different icon per file. */
const PER_FILE = new Set(["exe", "lnk", "ico", "url", "cur", "msi"]);

const cache = new Map<string, Accessor<string | null>>();

export const iconCacheCount = () => cache.size;
export function clearIconCache() {
  for (const get of cache.values()) {
    const u = get();
    if (u) URL.revokeObjectURL(u);
  }
  cache.clear();
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
  const key = exact ? `path:${path.toLowerCase()}` : keyFor(path, name, isDir);
  const known = cache.get(key);
  if (known) return known;
  const [url, setUrl] = createSignal<string | null>(null);
  cache.set(key, url);
  thumbnail(path, ICON_PX, true).then(
    (buf) => setUrl(URL.createObjectURL(new Blob([buf], { type: "image/png" }))),
    () => cache.delete(key), // try again with another file of this type
  );
  return url;
}
