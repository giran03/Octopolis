// Icons are glyphs from the Segoe Fluent Icons font (Segoe MDL2 Assets on Windows 10), not SVGs.
// Each export keeps the old `size` prop; `Glyph` takes a raw hex code point for anything else.
import { type JSX, Show } from "solid-js";
import { categoryOf, type FileCategory } from "../lib/format";
import { fileIconSpec } from "../lib/fileicons";
import { iconFor } from "../state/icons";

type P = { size?: number; class?: string };

/** One icon-font glyph. Pass the code point as hex, e.g. "E74D" for the trash can. */
export const Glyph = (p: { code: string; size?: number; class?: string }) => (
  <span class={`gi${p.class ? ` ${p.class}` : ""}`} style={{ "font-size": `${p.size ?? 16}px` }} aria-hidden="true">
    {String.fromCodePoint(parseInt(p.code, 16))}
  </span>
);

const make = (code: string, extra = "") => (p: P) => <Glyph code={code} size={p.size} class={[extra, p.class].filter(Boolean).join(" ") || undefined} />;

export const IconBack = make("E72B");
export const IconForward = make("E72A");
export const IconUp = make("E74A");
export const IconDown = make("E70D");
export const IconRefresh = make("E72C");
export const IconPlus = make("E710");
export const IconClose = make("E711");
export const IconChevron = make("E76C");
export const IconSearch = make("E721");
export const IconLayers = make("E81E");
export const IconSplitRow = make("F57C");
export const IconSplitCol = make("F57C", "gi-rot");
export const IconEye = make("E7B3");
export const IconSidebar = make("E89F");
export const IconSidebarClose = make("E8A0");
export const IconHome = make("E80F");
export const IconStar = make("E734");
export const IconStarFill = make("E735");
export const IconPin = make("E718");
export const IconClock = make("E121");
export const IconSettings = make("E713");
export const IconBranch = make("EC4F");
export const IconTray = make("E7B8");
export const IconCopy = make("E8C8");
export const IconMove = make("E72A");
export const IconTrash = make("E74D");

/** Clean donut-sector icon for the Disk Space Preview footer button. */
export const IconDiskSpace = (p: P) => (
  <svg class={p.class} width={p.size ?? 17} height={p.size ?? 17} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="10" cy="10" r="7.25" />
    <circle cx="10" cy="10" r="2.75" />
    <path d="M10 2.75v4.5M12.75 10h4.5M8.05 11.95l-3.2 3.2" />
  </svg>
);

export const IconZoomIn = (p: P) => (
  <svg class={p.class} width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.4 10.4L14 14M7 5v4M5 7h4" />
  </svg>
);

export const IconZoomOut = (p: P) => (
  <svg class={p.class} width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.4 10.4L14 14M5 7h4" />
  </svg>
);

export const IconFit = (p: P) => (
  <svg class={p.class} width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2.5 5.5V3a.5.5 0 0 1 .5-.5h2.5M10.5 2.5H13a.5.5 0 0 1 .5.5v2.5M13.5 10.5V13a.5.5 0 0 1-.5.5h-2.5M5.5 13.5H3a.5.5 0 0 1-.5-.5v-2.5" />
  </svg>
);

export const IconInfo = (p: P) => (
  <svg class={p.class} width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 7.5v3.5" />
    <circle cx="8" cy="5.1" r="0.6" fill="currentColor" stroke="none" />
  </svg>
);

export const IconDrive = (p: P & { kind?: string }) => <Glyph code={p.kind === "removable" ? "E88E" : "EDA2"} size={p.size} class={p.class} />;

/** Which font glyph stands for each kind of file. */
const CATEGORY_GLYPH: Record<FileCategory, string> = {
  folder: "E8D5",
  code: "E943",
  image: "E91B",
  audio: "E8D6",
  video: "E714",
  archive: "E7B8",
  doc: "E8A5",
  exe: "F012",
  file: "E7C3",
};

/** Folder or file glyph tinted by category; recycled list rows re-read the props, so keep them inside JSX. */
export function FileGlyph(p: { category: FileCategory; link?: boolean; size?: number }) {
  return (
    <span class={`gi glyph glyph-${p.category}${p.link ? " is-link" : ""}`} style={{ "font-size": `${p.size ?? 16}px` }} aria-hidden="true">
      {String.fromCodePoint(parseInt(CATEGORY_GLYPH[p.category], 16))}
      <Show when={p.link}>
        <span class="gi glyph-link">{String.fromCodePoint(0xe71b)}</span>
      </Show>
    </span>
  );
}

/** An icon for a file name: its own glyph and color when Octopolis knows the type, else the category glyph. */
export function FileIcon(p: { name: string; isDir: boolean; link?: boolean; size?: number }) {
  const spec = () => (p.isDir ? null : fileIconSpec(p.name));
  return (
    <Show when={spec()} fallback={<FileGlyph category={categoryOf(p.name, p.isDir)} link={p.link} size={p.size} />}>
      {(s) => (
        <span class={`gi fticon ft-${s().tone}`} style={{ "font-size": `${p.size ?? 16}px` }} aria-hidden="true">
          {String.fromCodePoint(parseInt(s().code, 16))}
        </span>
      )}
    </Show>
  );
}

/** Supported types use the drawn icons; everything else uses the Windows icon for its type. */
export function TypeIcon(p: { path: string; name: string; isDir: boolean; size?: number }) {
  const own = () => !p.isDir && fileIconSpec(p.name) !== null;
  return (
    <Show when={!own()} fallback={<FileIcon name={p.name} isDir={p.isDir} size={p.size} />}>
      <PathIcon path={p.path} name={p.name} isDir={p.isDir} size={p.size} fallback={<FileIcon name={p.name} isDir={p.isDir} size={p.size} />} />
    </Show>
  );
}

/** Well-known places, each with its own glyph and color, used until (or instead of) the Windows icon. */
const PLACE_GLYPH: Record<string, { code: string; tone: string }> = {
  home: { code: "E80F", tone: "home" },
  desktop: { code: "E7F4", tone: "desktop" },
  documents: { code: "E8A5", tone: "documents" },
  downloads: { code: "E896", tone: "downloads" },
  pictures: { code: "E91B", tone: "pictures" },
  music: { code: "E8D6", tone: "music" },
  videos: { code: "E714", tone: "videos" },
};

export function PlaceGlyph(p: { id: string; size?: number }) {
  const place = () => PLACE_GLYPH[p.id] ?? { code: "E8D5", tone: "folder" };
  return <Glyph code={place().code} size={p.size ?? 18} class={`place place-${place().tone}`} />;
}

/**
 * The Windows icon for a path, shown at `size`, with `fallback` until it arrives (or when Windows icons are off).
 * `exact` asks for this path's own icon, which differs for drives and special folders.
 */
export function PathIcon(p: { path: string; name: string; isDir: boolean; exact?: boolean; size?: number; fallback: JSX.Element }) {
  const url = () => iconFor(p.path, p.name, p.isDir, p.exact)();
  return (
    <Show when={url()} fallback={p.fallback}>
      {(u) => <img class="path-icon" src={u()} alt="" width={p.size ?? 16} height={p.size ?? 16} />}
    </Show>
  );
}

/** The Octopolis octopus, drawn in the accent color. Brand artwork, so it stays an SVG. */
export const AppMark = (p: { class?: string }) => (
  <svg class={p.class} viewBox="0 0 1024 1024" aria-hidden="true">
    <defs>
      <linearGradient id="mark-ink" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--accent)" stop-opacity="0.75" />
        <stop offset="1" stop-color="var(--accent)" />
      </linearGradient>
    </defs>
    <path d="M512 196c-138 0-238 100-238 230 0 62 22 112 56 150h364c34-38 56-88 56-150 0-130-100-230-238-230z" fill="url(#mark-ink)" />
    <circle cx="436" cy="430" r="34" fill="var(--bg)" />
    <circle cx="588" cy="430" r="34" fill="var(--bg)" />
    <g fill="none" stroke="url(#mark-ink)" stroke-width="58" stroke-linecap="round">
      <path d="M352 576c-40 70-96 112-150 116" />
      <path d="M452 590c-8 96-40 168-98 210" />
      <path d="M572 590c8 96 40 168 98 210" />
      <path d="M672 576c40 70 96 112 150 116" />
    </g>
  </svg>
);
