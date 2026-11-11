// Windows shell icons for the list, cached by file type.
import { createSignal, type Accessor } from "solid-js";
import { thumbnail } from "../lib/ipc";
import { extensionOf } from "../lib/paths";

const ICON_PX = 32;
/** These types have a different icon per file. */
const PER_FILE = new Set(["exe", "lnk", "ico", "url", "cur", "msi"]);

const cache = new Map<string, Accessor<string | null>>();

function keyFor(path: string, name: string, isDir: boolean): string {
  if (isDir) return "<folder>";
  const ext = extensionOf(name);
  if (!ext) return "<none>";
  return PER_FILE.has(ext) ? path.toLowerCase() : ext;
}

/** The icon's object URL, or null until it arrives (or if there is none). */
export function iconFor(path: string, name: string, isDir: boolean): Accessor<string | null> {
  const key = keyFor(path, name, isDir);
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
