import { describe, expect, it } from "vitest";
import {
  clampPan,
  computeFitScale,
  formatAspectRatio,
  isOverflowing,
  MAX_ZOOM,
  MIN_ZOOM,
  minimapGeometry,
  panForMinimapFraction,
  stepZoomScale,
  zoomAround,
} from "./imageView";

describe("imageView geometry", () => {
  it("computes fit scale without upscaling raster images unless allowed", () => {
    expect(computeFitScale({ w: 416, h: 416 }, { w: 2000, h: 1000 })).toBeCloseTo(0.2, 4);
    expect(computeFitScale({ w: 416, h: 416 }, { w: 100, h: 100 })).toBe(1);
    expect(computeFitScale({ w: 416, h: 416 }, { w: 100, h: 100 }, true)).toBe(4);
  });

  it("clamps pan to image edges and keeps smaller dimensions centered", () => {
    expect(clampPan({ x: 300, y: -300 }, { w: 200, h: 200 }, { w: 400, h: 100 }, 1)).toEqual({ x: 100, y: 0 });
    expect(isOverflowing({ w: 200, h: 200 }, { w: 200, h: 200 }, 1)).toBe(false);
    expect(isOverflowing({ w: 200, h: 200 }, { w: 400, h: 200 }, 1)).toBe(true);
  });

  it("anchors zoom around cursor and clamps scale bounds", () => {
    const view = { w: 400, h: 300 };
    const img = { w: 1000, h: 800 };
    const anchor = { x: 100, y: -50 };
    const res = zoomAround({ x: 0, y: 0 }, 1, 2, anchor, view, img);
    expect(res.scale).toBe(2);
    // Point under anchor before zoom was (+100, -50) from image center -> must remain at (+100, -50) screen offset.
    expect(res.pan.x + 100 * 2).toBeCloseTo(anchor.x, 4);
    expect(res.pan.y + -50 * 2).toBeCloseTo(anchor.y, 4);
    expect(stepZoomScale(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoomScale(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });

  it("maps viewport pan to minimap rectangle and back", () => {
    const view = { w: 200, h: 100 };
    const img = { w: 800, h: 400 };
    // At scale 1 centered, visible window covers middle 25% of width and 25% of height.
    const centered = minimapGeometry(view, img, 1, { x: 0, y: 0 });
    expect(centered.rect.left).toBeCloseTo(0.375, 4);
    expect(centered.rect.top).toBeCloseTo(0.375, 4);
    expect(centered.rect.width).toBeCloseTo(0.25, 4);
    expect(centered.rect.height).toBeCloseTo(0.25, 4);
    expect(centered.box).toEqual({ w: 124, h: 62 });

    // Clicking top-left corner of minimap pans as far top-left as clamping permits.
    const topLeftPan = panForMinimapFraction(0, 0, view, img, 1);
    expect(topLeftPan).toEqual({ x: 300, y: 150 });
    const mapped = minimapGeometry(view, img, 1, topLeftPan);
    expect(mapped.rect.left).toBeCloseTo(0, 4);
    expect(mapped.rect.top).toBeCloseTo(0, 4);
  });

  it("formats aspect ratios cleanly", () => {
    expect(formatAspectRatio(1920, 1080)).toBe("16:9");
    expect(formatAspectRatio(1600, 1200)).toBe("4:3");
    expect(formatAspectRatio(1999, 1000)).toBe("2.00:1");
  });
});
