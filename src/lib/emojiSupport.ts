// Newer emoji than the system's emoji font knows draw as an empty box. This finds them so the picker can leave them out.

const FONT = '32px "Twemoji Country Flags", "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
const SIDE = 48;
/** A code point nothing has a glyph for: the font's "missing" box. */
const MISSING = "\u{10FFFF}";

export type SupportCheck = (emoji: string) => boolean;

/** Builds a checker backed by a small canvas. Without a canvas (tests, odd webviews) everything counts as supported. */
export function createSupportCheck(): SupportCheck {
  const canvas = typeof document === "undefined" ? null : document.createElement("canvas");
  const ctx = canvas?.getContext("2d", { willReadFrequently: true });
  if (!canvas || !ctx) return () => true;
  canvas.width = canvas.height = SIDE;
  ctx.font = FONT;
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#000";

  const draw = (text: string) => {
    ctx.clearRect(0, 0, SIDE, SIDE);
    ctx.fillText(text, 2, SIDE / 2);
    return ctx.getImageData(0, 0, SIDE, SIDE).data;
  };
  const same = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  /** Color emoji paint their own colors; a plain text glyph (letters standing in for a flag, a missing box) is all black. */
  const hasColor = (d: Uint8ClampedArray) => {
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2])) return true;
    return false;
  };

  const one = ctx.measureText("😀").width;
  const missing = draw(MISSING);
  const cache = new Map<string, boolean>();

  return (emoji) => {
    const known = cache.get(emoji);
    if (known !== undefined) return known;
    // A sequence the font can't join is drawn as several emoji side by side, so it is much wider than one.
    let ok = ctx.measureText(emoji).width <= one * 1.6;
    if (ok) {
      const pixels = draw(emoji);
      ok = hasColor(pixels) && !same(pixels, missing);
    }
    cache.set(emoji, ok);
    return ok;
  };
}

/** Loads the flag font (it is fetched lazily) so flags are measured and drawn with it. */
export async function loadEmojiFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  try {
    await document.fonts.load('32px "Twemoji Country Flags"', "🇺🇸");
  } catch {
    // Without it flags just fall back to the system font.
  }
}
