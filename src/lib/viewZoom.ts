// The folder views and one slider that moves through them: List, Details, Content and Tiles are fixed steps,
// then the icon views grow smoothly from small to extra large.
import type { ViewMode } from "./folderViews";

export const ICON_MIN = 40;
export const ICON_MAX = 256;
export const ICON_DEFAULT = 96;

/** One notch of the mouse wheel or an arrow key on the slider. */
export const ZOOM_NOTCH = 40;

/** The slider runs from 0 to ZOOM_MAX. */
export const ZOOM_MAX = 1000;
const STEP = 120;
/** The compact views sit at 0, 120, 240 and 360 on the slider; icons start at 480. */
const STEPS: readonly ViewMode[] = ["list", "details", "content", "tiles"];
const ICON_START = 480;
/** Below this the nearest fixed step wins; from here up the icon views begin. */
const ICON_EDGE = ICON_START - STEP / 2;

export interface ViewChoice {
  readonly mode: ViewMode;
  /** Icon size in pixels (used by the icon view; remembered for the others). */
  readonly size: number;
}

export const clampIcon = (n: number) => Math.min(ICON_MAX, Math.max(ICON_MIN, Math.round(Number.isFinite(n) ? n : ICON_DEFAULT)));

/** Where a view sits on the slider; null for the column view, which is not part of the zoom. */
export function zoomOf(mode: ViewMode, size: number): number | null {
  const i = STEPS.indexOf(mode);
  if (i >= 0) return i * STEP;
  if (mode !== "grid") return null;
  return Math.round(ICON_START + ((clampIcon(size) - ICON_MIN) / (ICON_MAX - ICON_MIN)) * (ZOOM_MAX - ICON_START));
}

/** The view a slider position stands for. */
export function viewAt(zoom: number, size = ICON_DEFAULT): ViewChoice {
  const z = Math.min(ZOOM_MAX, Math.max(0, Number.isFinite(zoom) ? zoom : 0));
  if (z < ICON_EDGE) return { mode: STEPS[Math.min(STEPS.length - 1, Math.round(z / STEP))], size: clampIcon(size) };
  return { mode: "grid", size: clampIcon(ICON_MIN + (Math.max(0, z - ICON_START) / (ZOOM_MAX - ICON_START)) * (ICON_MAX - ICON_MIN)) };
}

/** The named sizes of the icon view, as in Explorer's View menu. */
export const ICON_PRESETS: readonly { readonly label: string; readonly size: number }[] = [
  { label: "Extra large icons", size: 256 },
  { label: "Large icons", size: 160 },
  { label: "Medium icons", size: 96 },
  { label: "Small icons", size: 56 },
];

/** The name of the preset an icon size falls in (the nearest one). */
export function iconPresetFor(size: number): (typeof ICON_PRESETS)[number] {
  return ICON_PRESETS.reduce((best, p) => (Math.abs(p.size - size) < Math.abs(best.size - size) ? p : best));
}

export const VIEW_LABELS: Record<ViewMode, string> = {
  grid: "Icons",
  list: "List",
  details: "Details",
  tiles: "Tiles",
  content: "Content",
  columns: "Columns",
  bento: "Bento",
};

/** "Large icons · 160 px", "Details"… for the slider's readout. */
export function viewLabel(mode: ViewMode, size: number): string {
  return mode === "grid" ? `${iconPresetFor(size).label} · ${clampIcon(size)} px` : VIEW_LABELS[mode];
}

/** Bento view: the row height a size stands for, and the gap between pictures. */
export const BENTO_GAP = 6;
export const bentoRowHeight = (size: number) => Math.round(clampIcon(size) * 1.25 + 24);

/** Layout of the icon view: cell size and the picture box, from the icon size. */
export function iconCell(size: number): { w: number; h: number; thumb: number } {
  const s = clampIcon(size);
  return { w: Math.max(80, s + 28), h: s + 40, thumb: s };
}

/** Thumbnails are made in a few sizes so scrolling and zooming reuse them. */
export function thumbBucket(px: number): number {
  return [64, 96, 160, 256].find((b) => px <= b) ?? 256;
}

export const TILE = { w: 256, h: 64, thumb: 44 } as const;
export const CONTENT_ROW = { h: 60, thumb: 44 } as const;
/** Width of a column in the List view. */
export const LIST_COLUMN_W = 224;

/** One notch of zoom from a view: icons grow or shrink by about a tenth, the compact views step to their neighbour. */
export function stepView(mode: ViewMode, size: number, dir: 1 | -1): ViewChoice | null {
  if (mode === "columns") return null;
  // The bento view keeps its mode; zooming changes how tall its rows are.
  if (mode === "bento") return { mode, size: clampIcon(clampIcon(size) + dir * Math.max(8, Math.round(clampIcon(size) * 0.12))) };
  const i = STEPS.indexOf(mode);
  if (i >= 0) {
    const next = i + dir;
    if (next < 0) return { mode, size: clampIcon(size) };
    if (next >= STEPS.length) return { mode: "grid", size: ICON_MIN };
    return { mode: STEPS[next], size: clampIcon(size) };
  }
  const s = clampIcon(size);
  if (dir < 0 && s <= ICON_MIN) return { mode: STEPS[STEPS.length - 1], size: s };
  return { mode: "grid", size: clampIcon(s + dir * Math.max(8, Math.round(s * 0.12))) };
}
