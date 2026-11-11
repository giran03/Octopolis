// Squarified treemap layout (Bruls, Huizing, van Wijk).

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Tile<T> extends Rect {
  readonly item: T;
}

function worst(row: number[], side: number): number {
  const sum = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

/** Lays items out in `box`, tile area proportional to `value`. Zero values are dropped. */
export function squarify<T>(items: readonly T[], value: (t: T) => number, box: Rect): Tile<T>[] {
  const positive = items.filter((i) => value(i) > 0).sort((a, b) => value(b) - value(a));
  const total = positive.reduce((s, i) => s + value(i), 0);
  if (total <= 0 || box.w <= 0 || box.h <= 0) return [];
  const scale = (box.w * box.h) / total;
  const areas = positive.map((i) => value(i) * scale);
  const out: Tile<T>[] = [];
  let { x, y, w, h } = box;
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    const row: number[] = [areas[i]];
    let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]], side) <= worst(row, side)) row.push(areas[j++]);
    const sum = row.reduce((a, b) => a + b, 0);
    const thickness = sum / side;
    let offset = 0;
    row.forEach((area, k) => {
      const length = area / thickness;
      const item = positive[i + k];
      if (w >= h) out.push({ item, x, y: y + offset, w: thickness, h: length });
      else out.push({ item, x: x + offset, y, w: length, h: thickness });
      offset += length;
    });
    if (w >= h) {
      x += thickness;
      w -= thickness;
    } else {
      y += thickness;
      h -= thickness;
    }
    i = j;
  }
  return out;
}
