// The app icon in the active theme's colors: tiles in the text color, the hub in the accent, on the theme background.

export interface IconColors {
  readonly bg: string;
  readonly tiles: string;
  readonly hub: string;
}

const TILE = 58;
const GAP = 21;
const OUTER = 12;
const INNER = 24;
const MID = 14;

function tilePath(x: number, y: number, [tl, tr, br, bl]: [number, number, number, number]): string {
  const t = TILE;
  return (
    `M${x + tl} ${y}H${x + t - tr}A${tr} ${tr} 0 0 1 ${x + t} ${y + tr}V${y + t - br}A${br} ${br} 0 0 1 ${x + t - br} ${y + t}` +
    `H${x + bl}A${bl} ${bl} 0 0 1 ${x} ${y + t - bl}V${y + tl}A${tl} ${tl} 0 0 1 ${x + tl} ${y}Z`
  );
}

/** SVG markup of the app icon for the given colors (256 x 256 units). */
export function appIconSvg(c: IconColors): string {
  const p = [0, 1, 2].map((k) => 20 + k * (TILE + GAP));
  const o = OUTER, i = INNER, m = MID;
  const cells: [number, number, [number, number, number, number]][] = [
    [0, 0, [o, o, i, o]], [1, 0, [o, o, m, m]], [2, 0, [o, o, o, i]],
    [0, 1, [o, m, m, o]], [2, 1, [m, o, o, m]],
    [0, 2, [o, i, o, o]], [1, 2, [m, m, o, o]], [2, 2, [i, o, o, o]],
  ];
  const d = cells.map(([cx, cy, r]) => tilePath(p[cx], p[cy], r)).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">` +
    `<rect width="256" height="256" rx="56" fill="${c.bg}"/>` +
    `<g transform="translate(128 128) scale(0.78) translate(-128 -128)">` +
    `<path fill="${c.tiles}" d="${d}"/><circle cx="128" cy="128" r="29" fill="${c.hub}"/></g></svg>`
  );
}

/** Rasterizes the icon to RGBA pixels. */
export async function renderAppIcon(c: IconColors, px = 128): Promise<ImageData> {
  const url = URL.createObjectURL(new Blob([appIconSvg(c)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = px;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D canvas");
    ctx.drawImage(img, 0, 0, px, px);
    return ctx.getImageData(0, 0, px, px);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Reads the current theme's colors from the page, so presets, custom themes, accents and the system scheme all count. */
export function currentIconColors(root: HTMLElement = document.documentElement): IconColors {
  const css = getComputedStyle(root);
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return { bg: get("--bg", "#101216"), tiles: get("--text", "#e3e6ed"), hub: get("--accent", "#6d8cff") };
}
