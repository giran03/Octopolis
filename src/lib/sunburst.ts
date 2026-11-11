// Sunburst ring geometry and color assignment for the Disk Space Preview.
import type { SpaceNode } from "./ipc";

export interface SunburstArc {
  readonly id: string;
  readonly node: SpaceNode;
  readonly depth: number;
  readonly startAngle: number;
  readonly endAngle: number;
  readonly innerR: number;
  readonly outerR: number;
  readonly pathD: string;
  readonly color: string;
  readonly label: string;
  readonly labelX: number;
  readonly labelY: number;
  readonly labelDeg: number;
  readonly showLabel: boolean;
  readonly shareOfRoot: number;
  readonly shareOfParent: number;
}

/** Ring inner/outer radii in SVG viewBox units (-250..250). */
export const SUNBURST_RINGS = [
  { inner: 60, outer: 112 },
  { inner: 115, outer: 162 },
  { inner: 165, outer: 204 },
  { inner: 207, outer: 240 },
] as const;

export const SUNBURST_HUB_R = 56;

/** Curated sector hues with HSL lightness tuned so #fff labels keep >= 4.5:1 contrast. */
const SECTOR_HUES = [24, 168, 258, 332, 214, 78, 12, 192] as const;

export function sectorColor(topIndex: number, depth: number, isOther: boolean): string {
  if (isOther) return "var(--surface-3)";
  const hue = SECTOR_HUES[topIndex % SECTOR_HUES.length];
  const sat = Math.max(46, 68 - (depth - 1) * 6);
  const light = Math.max(30, 42 - (depth - 1) * 3);
  return `hsl(${hue} ${sat}% ${light}%)`;
}

const pt = (r: number, angle: number): [number, number] => [r * Math.sin(angle), -r * Math.cos(angle)];

/** Builds an SVG path for an annular sector; splits full 360° rings into two 180° arcs so SVG doesn't collapse them. */
export function annularSectorPath(innerR: number, outerR: number, start: number, end: number): string {
  const span = end - start;
  if (span <= 0.0001) return "";
  if (span >= Math.PI * 2 - 0.001) {
    const mid = start + Math.PI;
    const [ox0, oy0] = pt(outerR, start);
    const [ox1, oy1] = pt(outerR, mid);
    const [ix0, iy0] = pt(innerR, start);
    const [ix1, iy1] = pt(innerR, mid);
    return [
      `M ${ox0.toFixed(2)} ${oy0.toFixed(2)}`,
      `A ${outerR} ${outerR} 0 1 1 ${ox1.toFixed(2)} ${oy1.toFixed(2)}`,
      `A ${outerR} ${outerR} 0 1 1 ${ox0.toFixed(2)} ${oy0.toFixed(2)}`,
      `M ${ix0.toFixed(2)} ${iy0.toFixed(2)}`,
      `A ${innerR} ${innerR} 0 1 0 ${ix1.toFixed(2)} ${iy1.toFixed(2)}`,
      `A ${innerR} ${innerR} 0 1 0 ${ix0.toFixed(2)} ${iy0.toFixed(2)} Z`,
    ].join(" ");
  }
  const large = span > Math.PI ? 1 : 0;
  const [ox0, oy0] = pt(outerR, start);
  const [ox1, oy1] = pt(outerR, end);
  const [ix1, iy1] = pt(innerR, end);
  const [ix0, iy0] = pt(innerR, start);
  return [
    `M ${ox0.toFixed(2)} ${oy0.toFixed(2)}`,
    `A ${outerR} ${outerR} 0 ${large} 1 ${ox1.toFixed(2)} ${oy1.toFixed(2)}`,
    `L ${ix1.toFixed(2)} ${iy1.toFixed(2)}`,
    `A ${innerR} ${innerR} 0 ${large} 0 ${ix0.toFixed(2)} ${iy0.toFixed(2)} Z`,
  ].join(" ");
}

function fitLabel(name: string, arcLen: number): string {
  const maxChars = Math.floor((arcLen - 12) / 6.2);
  if (maxChars < 4) return "";
  if (name.length <= maxChars) return name;
  return `${name.slice(0, maxChars - 1)}…`;
}

/** Converts a `SpaceNode` subtree into flat SVG sunburst arcs up to 4 rings deep. */
export function buildSunburstArcs(root: SpaceNode): SunburstArc[] {
  const arcs: SunburstArc[] = [];
  const rootBytes = root.bytes;
  if (rootBytes <= 0) return arcs;

  const visit = (node: SpaceNode, depth: number, start: number, end: number, topIndex: number, parentBytes: number) => {
    if (depth > SUNBURST_RINGS.length || node.children.length === 0) return;
    const ring = SUNBURST_RINGS[depth - 1];
    const span = end - start;
    const base = Math.max(node.bytes, node.children.reduce((s, c) => s + c.bytes, 0));
    if (base <= 0) return;

    let cursor = start;
    node.children.forEach((child, idx) => {
      if (child.bytes <= 0) return;
      const frac = child.bytes / base;
      const cStart = cursor;
      const cEnd = Math.min(end, cStart + span * frac);
      cursor = cEnd;
      const cSpan = cEnd - cStart;
      if (cSpan < 0.008) return; // < 0.45° is sub-pixel at r=240

      const branch = depth === 1 ? idx : topIndex;
      const isOther = child.name === "Other" && child.path === "";
      const midAngle = (cStart + cEnd) / 2;
      const midR = (ring.inner + ring.outer) / 2;
      const [labelX, labelY] = pt(midR, midAngle);
      const rawDeg = (midAngle * 180) / Math.PI;
      const labelDeg = rawDeg > 90 && rawDeg < 270 ? rawDeg + 180 : rawDeg;
      const arcLen = cSpan * midR;
      const label = !isOther && depth <= 3 && ring.outer - ring.inner >= 36 ? fitLabel(child.name, arcLen) : "";

      arcs.push({
        id: `${depth}:${child.path || `${node.path}/${child.name}:${idx}`}`,
        node: child,
        depth,
        startAngle: cStart,
        endAngle: cEnd,
        innerR: ring.inner,
        outerR: ring.outer,
        pathD: annularSectorPath(ring.inner, ring.outer, cStart, cEnd),
        color: sectorColor(branch, depth, isOther),
        label,
        labelX,
        labelY,
        labelDeg,
        showLabel: label.length > 0,
        shareOfRoot: child.bytes / rootBytes,
        shareOfParent: child.bytes / parentBytes,
      });

      visit(child, depth + 1, cStart, cEnd, branch, child.bytes);
    });
  };

  visit(root, 1, 0, Math.PI * 2, 0, rootBytes);
  return arcs;
}

/** Finds a subtree node inside `root` by path (case-insensitive), returning the node and trail. */
export function findSpaceTrail(root: SpaceNode, targetPath: string): SpaceNode[] {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  const needle = norm(targetPath);
  if (!needle || norm(root.path) === needle) return [root];
  const walk = (cur: SpaceNode, trail: SpaceNode[]): SpaceNode[] | null => {
    for (const c of cur.children) {
      const next = [...trail, c];
      if (c.path && norm(c.path) === needle) return next;
      const found = walk(c, next);
      if (found) return found;
    }
    return null;
  };
  return walk(root, [root]) ?? [root];
}
