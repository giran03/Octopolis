// Icons are Material Symbols (outlined, weight 100) from a bundled font subset. Colored icons (files, folders,
// drives, places) keep the Segoe Fluent Icons font and are drawn by `SegoeGlyph`, `FileGlyph` and friends.
// Each export keeps the old `size` prop; `Glyph` takes the legacy Segoe hex code and `MaterialIcon` takes a symbol name.
import { type JSX, Show } from "solid-js";
import { categoryOf, type FileCategory } from "../lib/format";
import { fileIconSpec } from "../lib/fileicons";
import { folderIcons } from "../state/folderIcons";
import { iconFor } from "../state/icons";

type P = { size?: number; class?: string };

/**
 * One Material Symbol by name (https://fonts.google.com/icons). Only the names listed in
 * `src/assets/fonts/material-symbols-outlined.woff2` exist; add a name there before using a new one.
 */
export const MaterialIcon = (p: { name: string; size?: number; class?: string; fill?: boolean }) => (
  <span class={`ms${p.fill ? " ms-fill" : ""}${p.class ? ` ${p.class}` : ""}`} style={{ "font-size": `calc(${p.size ?? 16}px * var(--icon-scale, 1))` }} aria-hidden="true">
    {p.name}
  </span>
);

/** Segoe Fluent Icons code points used for the plain UI icons, and the Material Symbol that replaces each. */
const SYMBOL_FOR_CODE: Record<string, { name: string; fill?: boolean }> = {
  E710: { name: "add" },
  E711: { name: "close" },
  E8BB: { name: "close" },
  E70D: { name: "expand_more" },
  E70E: { name: "expand_less" },
  E72A: { name: "arrow_forward" },
  E72B: { name: "arrow_back" },
  E74A: { name: "arrow_upward" },
  E72C: { name: "refresh" },
  E76C: { name: "chevron_right" },
  E721: { name: "search" },
  E74D: { name: "delete" },
  E81E: { name: "layers" },
  E7B3: { name: "visibility" },
  E89F: { name: "left_panel_open" },
  E8A0: { name: "left_panel_close" },
  E80F: { name: "home" },
  E734: { name: "star" },
  E735: { name: "star", fill: true },
  E718: { name: "push_pin" },
  E121: { name: "schedule" },
  E713: { name: "settings" },
  EC4F: { name: "fork_right" },
  E7B8: { name: "inventory_2" },
  E8C8: { name: "content_copy" },
  E8EC: { name: "sell" },
  E8B7: { name: "draft" },
  E790: { name: "palette" },
  E765: { name: "keyboard" },
  E9E9: { name: "tune" },
  E895: { name: "sync" },
  E946: { name: "info" },
  E73E: { name: "check" },
  E783: { name: "error" },
  E753: { name: "cloud" },
  E930: { name: "check_circle" },
  E921: { name: "remove" },
  E922: { name: "crop_square" },
  E923: { name: "filter_none" },
  E756: { name: "terminal" },
  EDA2: { name: "hard_drive" },
};

/** A plain UI icon, by its legacy Segoe code point. Pass the code as hex, e.g. "E74D" for the trash can. */
export const Glyph = (p: { code: string; size?: number; class?: string }) => {
  const sym = SYMBOL_FOR_CODE[p.code.toUpperCase()];
  return <MaterialIcon name={sym?.name ?? "help"} fill={sym?.fill} size={p.size} class={p.class} />;
};

/** One Segoe Fluent Icons glyph, for the colored icons (files, folders, drives, places). */
export const SegoeGlyph = (p: { code: string; size?: number; class?: string }) => (
  <span class={`gi${p.class ? ` ${p.class}` : ""}`} style={{ "font-size": `${p.size ?? 16}px` }} aria-hidden="true">
    {String.fromCodePoint(parseInt(p.code, 16))}
  </span>
);

const make = (code: string, extra = "") => (p: P) => <Glyph code={code} size={p.size} class={[extra, p.class].filter(Boolean).join(" ") || undefined} />;
/** An icon drawn from a Material Symbol name. */
const sym = (name: string, fill = false) => (p: P) => <MaterialIcon name={name} fill={fill} size={p.size} class={p.class} />;

export const IconBack = make("E72B");
export const IconForward = make("E72A");
export const IconUp = make("E74A");
export const IconDown = make("E70D");
export const IconRefresh = make("E72C");
export const IconReset = sym("restart_alt");
export const IconPlus = make("E710");
export const IconClose = make("E711");
export const IconChevron = make("E76C");
export const IconSearch = make("E721");
export const IconLayers = make("E81E");
export const IconSplitRow = sym("vertical_split");
export const IconSplitCol = sym("horizontal_split");
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
export const IconDiskSpace = sym("hard_disk");
/** A mop, for the Free up space button. */
export const IconMop = sym("mop");
export const IconBolt = sym("bolt");
export const IconZoomIn = sym("zoom_in");
export const IconZoomOut = sym("zoom_out");
export const IconFit = sym("fit_screen");
export const IconInfo = sym("info");
export const IconGitIgnore = sym("hide_source");
export const IconGitCommit = sym("commit");

export const IconDrive = (p: P & { kind?: string }) => <SegoeGlyph code={p.kind === "removable" ? "E88E" : "EDA2"} size={p.size} class={p.class} />;

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
  return <SegoeGlyph code={place().code} size={p.size ?? 18} class={`place place-${place().tone}`} />;
}

/** A folder's chosen emoji, drawn in place of its normal icon. */
export const FolderEmoji = (p: { emoji: string; size?: number; class?: string }) => (
  <span
    class={`emoji folder-emoji${p.class ? ` ${p.class}` : ""}`}
    style={{ "font-size": `${Math.round((p.size ?? 16) * 0.9)}px`, width: `${p.size ?? 16}px`, height: `${p.size ?? 16}px` }}
    aria-hidden="true"
  >
    {p.emoji}
  </span>
);

/**
 * The Windows icon for a path, shown at `size`, with `fallback` until it arrives (or when Windows icons are off).
 * `exact` asks for this path's own icon, which differs for drives and special folders.
 * A folder with a chosen emoji shows that instead.
 */
export function PathIcon(p: { path: string; name: string; isDir: boolean; exact?: boolean; size?: number; fallback: JSX.Element }) {
  const emoji = () => (p.isDir ? folderIcons.get(p.path) : undefined);
  // A folder can wear the Windows icon of a special folder (Documents, 3D Objects...).
  const borrowed = () => (p.isDir && !emoji() ? folderIcons.source(p.path) : undefined);
  const url = () => (emoji() ? null : borrowed() ? iconFor(borrowed()!, p.name, true, true)() : iconFor(p.path, p.name, p.isDir, p.exact)());
  return (
    <Show when={!emoji()} fallback={<FolderEmoji emoji={emoji()!} size={p.size} />}>
      <Show when={url()} fallback={p.fallback}>
        {(u) => <img class="path-icon" src={u()} alt="" width={p.size ?? 16} height={p.size ?? 16} />}
      </Show>
    </Show>
  );
}

/** The Octopolis mark: eight blocks around one hub. Brand artwork, so it stays an SVG and follows the theme. */
export const AppMark = (p: { class?: string }) => (
  <svg class={p.class} viewBox="0 0 256 256" aria-hidden="true">
    <path fill="var(--text)" d="M28 20H76A8 8 0 0 1 84 28V54A30 30 0 0 1 54 84H28A8 8 0 0 1 20 76V28A8 8 0 0 1 28 20ZM104 20H152A8 8 0 0 1 160 28V66A18 18 0 0 1 142 84H114A18 18 0 0 1 96 66V28A8 8 0 0 1 104 20ZM180 20H228A8 8 0 0 1 236 28V76A8 8 0 0 1 228 84H202A30 30 0 0 1 172 54V28A8 8 0 0 1 180 20ZM28 96H66A18 18 0 0 1 84 114V142A18 18 0 0 1 66 160H28A8 8 0 0 1 20 152V104A8 8 0 0 1 28 96ZM190 96H228A8 8 0 0 1 236 104V152A8 8 0 0 1 228 160H190A18 18 0 0 1 172 142V114A18 18 0 0 1 190 96ZM28 172H54A30 30 0 0 1 84 202V228A8 8 0 0 1 76 236H28A8 8 0 0 1 20 228V180A8 8 0 0 1 28 172ZM114 172H142A18 18 0 0 1 160 190V228A8 8 0 0 1 152 236H104A8 8 0 0 1 96 228V190A18 18 0 0 1 114 172ZM202 172H228A8 8 0 0 1 236 180V228A8 8 0 0 1 228 236H180A8 8 0 0 1 172 228V202A30 30 0 0 1 202 172Z" />
    <circle cx="128" cy="128" r="30" fill="var(--accent)" />
  </svg>
);
