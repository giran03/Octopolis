// What a drop from outside the app carries (a picture dragged from a web page, files from another program),
// and which links in it are worth saving. Reading a drop must happen inside the drop event; saving can follow.

/** Biggest dropped file copied through the page (it is held in memory on the way). */
export const MAX_DROP_FILE_BYTES = 512 * 1024 * 1024;
const MAX_DATA_URL_CHARS = 60 * 1024 * 1024;
const MAX_LINKS = 20;

export interface DropSnapshot {
  readonly files: readonly File[];
  readonly uris: readonly string[];
  readonly html: string;
  readonly text: string;
}

/** Everything the drop carries, copied out so it can be used after the event ends. */
export function readDrop(dt: DataTransfer): DropSnapshot {
  return { files: [...dt.files], uris: parseUriList(dt.getData("text/uri-list")), html: dt.getData("text/html"), text: dt.getData("text/plain") };
}

/** The links in a `text/uri-list` value (one per line; lines starting with # are comments). */
export function parseUriList(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

const isHttp = (u: string) => /^https?:\/\//i.test(u);
const isMediaData = (u: string) => /^data:(image|video|audio)\//i.test(u) && u.length <= MAX_DATA_URL_CHARS;

const ENTITIES: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&lt;": "<", "&gt;": ">" };

/** Media addresses inside dragged HTML: pictures, videos and audio with a full address (relative ones can't be resolved). */
export function mediaFromHtml(html: string): string[] {
  const out: string[] = [];
  const tag = /<(?:img|video|audio|source)\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const m of html.matchAll(tag)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim().replace(/&(?:amp|quot|lt|gt|#39|#x27);/g, (e) => ENTITIES[e] ?? e);
    if (isHttp(raw) || isMediaData(raw)) out.push(raw);
  }
  return out;
}

/**
 * The addresses to save, best first: media inside the dragged HTML (that is what a dragged picture is), else the
 * dragged links, else a single address dropped as plain text. Duplicates are dropped.
 */
export function mediaCandidates(snap: Pick<DropSnapshot, "uris" | "html" | "text">): string[] {
  const fromHtml = mediaFromHtml(snap.html);
  const links = snap.uris.filter((u) => isHttp(u) || isMediaData(u));
  const asText = /^https?:\/\/\S+$/i.test(snap.text.trim()) ? [snap.text.trim()] : [];
  const pool = fromHtml.length ? fromHtml : links.length ? links : asText;
  return [...new Set(pool)].slice(0, MAX_LINKS);
}

const EXT_FOR_TYPE: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp", "image/svg+xml": "svg",
  "image/x-icon": "ico", "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac",
};

/** A name for a dropped file, giving it the extension of its type when the name has none. */
export function nameForDropped(name: string, type: string): string {
  const base = name.trim() || "dropped";
  if (/\.[A-Za-z0-9]{1,5}$/.test(base)) return base;
  const ext = EXT_FOR_TYPE[type.toLowerCase()];
  return ext ? `${base}.${ext}` : base;
}

/** Whether a drop has anything this feature could save. */
export function hasSavable(snap: DropSnapshot): boolean {
  return snap.files.length > 0 || mediaCandidates(snap).length > 0;
}
