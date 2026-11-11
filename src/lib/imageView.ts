// Pure geometry helpers for zoomed image viewing, cursor-anchored zoom,
// edge-clamped panning, and the minimap navigator overlay.

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 16;
const ZOOM_STEP = 1.25;

export interface Size2D {
  readonly w: number;
  readonly h: number;
}

export interface Pan {
  readonly x: number;
  readonly y: number;
}

export interface MinimapRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Scale that fits the image inside the viewport, capping raster images at 100% by default. */
export function computeFitScale(view: Size2D, img: Size2D, allowUpscale = false): number {
  if (view.w <= 0 || view.h <= 0 || img.w <= 0 || img.h <= 0) return 1;
  const padW = Math.max(1, view.w - 16);
  const padH = Math.max(1, view.h - 16);
  const raw = Math.min(padW / img.w, padH / img.h);
  const capped = allowUpscale ? raw : Math.min(1, raw);
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, capped));
}

/** Clamps pan offset so the scaled image stays within viewport bounds (centered when smaller). */
export function clampPan(pan: Pan, view: Size2D, img: Size2D, scale: number): Pan {
  const maxX = Math.max(0, (img.w * scale - view.w) / 2);
  const maxY = Math.max(0, (img.h * scale - view.h) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x)) || 0,
    y: Math.min(maxY, Math.max(-maxY, pan.y)) || 0,
  };
}

/** Whether the scaled image extends past the viewport and can be panned/navigated. */
export function isOverflowing(view: Size2D, img: Size2D, scale: number): boolean {
  return img.w * scale > view.w + 1 || img.h * scale > view.h + 1;
}

/** Computes next clamped scale and pan keeping the point at `anchor` (from viewport center) fixed. */
export function zoomAround(
  pan: Pan,
  oldScale: number,
  nextScale: number,
  anchor: Pan,
  view: Size2D,
  img: Size2D,
): { scale: number; pan: Pan } {
  const clampedScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextScale));
  if (oldScale <= 0) return { scale: clampedScale, pan: { x: 0, y: 0 } };
  const ix = (anchor.x - pan.x) / oldScale;
  const iy = (anchor.y - pan.y) / oldScale;
  const nextPan = clampPan(
    { x: anchor.x - ix * clampedScale, y: anchor.y - iy * clampedScale },
    view,
    img,
    clampedScale,
  );
  return { scale: clampedScale, pan: nextPan };
}

/** Steps zoom scale up or down by one discrete detent within `[MIN_ZOOM, MAX_ZOOM]`. */
export function stepZoomScale(scale: number, dir: 1 | -1): number {
  const next = dir > 0 ? scale * ZOOM_STEP : scale / ZOOM_STEP;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
}

/** Visible viewport rectangle as `[0..1]` fractions of the full image, plus minimap dimensions. */
export function minimapGeometry(
  view: Size2D,
  img: Size2D,
  scale: number,
  pan: Pan,
  maxBox: Size2D = { w: 124, h: 90 },
): { box: Size2D; rect: MinimapRect } {
  const dispW = Math.max(1, img.w * scale);
  const dispH = Math.max(1, img.h * scale);
  const visLeft = Math.max(0, (dispW / 2 - pan.x - view.w / 2) / dispW);
  const visRight = Math.min(1, (dispW / 2 - pan.x + view.w / 2) / dispW);
  const visTop = Math.max(0, (dispH / 2 - pan.y - view.h / 2) / dispH);
  const visBottom = Math.min(1, (dispH / 2 - pan.y + view.h / 2) / dispH);
  const miniScale = img.w > 0 && img.h > 0 ? Math.min(maxBox.w / img.w, maxBox.h / img.h) : 1;
  return {
    box: {
      w: Math.max(24, Math.round(img.w * miniScale)),
      h: Math.max(24, Math.round(img.h * miniScale)),
    },
    rect: {
      left: visLeft,
      top: visTop,
      width: Math.max(0, visRight - visLeft),
      height: Math.max(0, visBottom - visTop),
    },
  };
}

/** Converts normalized minimap coordinates `[0..1]` into clamped viewport pan offset. */
export function panForMinimapFraction(
  fx: number,
  fy: number,
  view: Size2D,
  img: Size2D,
  scale: number,
): Pan {
  const dispW = img.w * scale;
  const dispH = img.h * scale;
  return clampPan(
    { x: (0.5 - fx) * dispW, y: (0.5 - fy) * dispH },
    view,
    img,
    scale,
  );
}

/** Formats an aspect ratio cleanly (e.g. `"16:9"`, `"4:3"`, `"1.85:1"`). */
export function formatAspectRatio(w: number, h: number): string {
  if (w <= 0 || h <= 0) return "—";
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const rw0 = Math.round(w);
  const rh0 = Math.round(h);
  const d = gcd(rw0, rh0);
  const rw = rw0 / d;
  const rh = rh0 / d;
  if (rw <= 32 && rh <= 32) return `${rw}:${rh}`;
  const ratio = w / h;
  return ratio >= 1 ? `${ratio.toFixed(2)}:1` : `1:${(1 / ratio).toFixed(2)}`;
}
