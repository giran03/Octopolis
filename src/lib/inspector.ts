// Pure width bounds and clamping helpers for the resizable inspector panel.

export const MIN_INSPECTOR_WIDTH = 240;
export const MAX_INSPECTOR_WIDTH = 760;
export const DEFAULT_INSPECTOR_WIDTH = 380;

export function clampInspectorWidth(width: number, maxAvailable = MAX_INSPECTOR_WIDTH): number {
  const ceil = Math.max(MIN_INSPECTOR_WIDTH, Math.min(MAX_INSPECTOR_WIDTH, Math.round(maxAvailable)));
  if (!Number.isFinite(width)) return DEFAULT_INSPECTOR_WIDTH;
  return Math.min(ceil, Math.max(MIN_INSPECTOR_WIDTH, Math.round(width)));
}
