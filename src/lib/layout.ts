// Split-pane layout as an immutable tree. Every function returns a new tree.

export type Direction = "row" | "column";

export type LayoutNode =
  | { readonly kind: "leaf"; readonly paneId: string }
  | {
      readonly kind: "split";
      readonly dir: Direction;
      readonly children: readonly LayoutNode[];
      /** Fractions that sum to 1, one per child. */
      readonly sizes: readonly number[];
    };

export const MIN_FRACTION = 0.12;

export function leaf(paneId: string): LayoutNode {
  return { kind: "leaf", paneId };
}

export function leaves(node: LayoutNode): string[] {
  return node.kind === "leaf" ? [node.paneId] : node.children.flatMap(leaves);
}

/**
 * Splits the pane `target`, placing `newPaneId` after it (or before it, for
 * the left or top edge). Splitting in the same direction as the parent adds a
 * sibling instead of nesting, so repeated splits make an even grid of panes.
 */
export function splitPane(root: LayoutNode, target: string, newPaneId: string, dir: Direction, before = false): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === "leaf") {
      return node.paneId === target
        ? { kind: "split", dir, children: before ? [leaf(newPaneId), node] : [node, leaf(newPaneId)], sizes: [0.5, 0.5] }
        : node;
    }
    const at = node.children.findIndex((c) => c.kind === "leaf" && c.paneId === target);
    if (at >= 0 && node.dir === dir) {
      const half = node.sizes[at] / 2;
      const at2 = before ? at : at + 1;
      return {
        ...node,
        children: [...node.children.slice(0, at2), leaf(newPaneId), ...node.children.slice(at2)],
        sizes: [...node.sizes.slice(0, at), half, half, ...node.sizes.slice(at + 1)],
      };
    }
    return { ...node, children: node.children.map(walk) };
  };
  return walk(root);
}

/** Which side of a pane a drop zone is on. */
export type Edge = "left" | "right" | "top" | "bottom";

/** The split direction and placement an edge stands for. */
export function edgeSplit(edge: Edge): { dir: Direction; before: boolean } {
  return { dir: edge === "left" || edge === "right" ? "row" : "column", before: edge === "left" || edge === "top" };
}

/** The number of panes in a layout. */
export const paneTotal = (node: LayoutNode): number => leaves(node).length;

/** Removes a pane, collapsing splits left with one child. Null if it was the last pane. */
export function removePane(root: LayoutNode, target: string): LayoutNode | null {
  const walk = (node: LayoutNode): LayoutNode | null => {
    if (node.kind === "leaf") return node.paneId === target ? null : node;
    const kept: LayoutNode[] = [];
    const sizes: number[] = [];
    let freed = 0;
    node.children.forEach((child, i) => {
      const next = walk(child);
      if (next) {
        kept.push(next);
        sizes.push(node.sizes[i]);
      } else {
        freed += node.sizes[i];
      }
    });
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0];
    const scale = 1 / (1 - freed);
    return { ...node, children: kept, sizes: sizes.map((s) => s * scale) };
  };
  return walk(root);
}

/**
 * Moves the divider between children `index` and `index + 1` of the split at
 * `path` (child indices from the root) by `delta` (a fraction of the split).
 */
export function resizeSplit(root: LayoutNode, path: readonly number[], index: number, delta: number): LayoutNode {
  if (path.length > 0) {
    if (root.kind === "leaf") return root;
    const [head, ...tail] = path;
    return {
      ...root,
      children: root.children.map((c, i) => (i === head ? resizeSplit(c, tail, index, delta) : c)),
    };
  }
  if (root.kind === "leaf" || index < 0 || index >= root.children.length - 1) return root;
  const pair = root.sizes[index] + root.sizes[index + 1];
  const left = Math.min(Math.max(root.sizes[index] + delta, MIN_FRACTION), pair - MIN_FRACTION);
  const sizes = root.sizes.map((s, i) => (i === index ? left : i === index + 1 ? pair - left : s));
  return { ...root, sizes };
}

/** A rectangle as fractions (0 to 1) of the whole pane area. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A draggable divider between two children of a split. */
export interface DividerSpec {
  /** Child indices from the root to the split this divider belongs to. */
  readonly path: readonly number[];
  /** The divider sits between children `index` and `index + 1`. */
  readonly index: number;
  readonly dir: Direction;
  /** Where the line is: zero width for a vertical line (row split), zero height for a horizontal one. */
  readonly line: Rect;
  /** The split it resizes, so a drag can turn pixels into a fraction. */
  readonly split: Rect;
}

/**
 * Where every pane and divider goes, as fractions of the whole area. Panes are placed by these rectangles
 * (instead of nested boxes), so adding or removing one moves the others smoothly rather than rebuilding them.
 */
export function computeLayout(root: LayoutNode): { panes: Map<string, Rect>; dividers: DividerSpec[] } {
  const panes = new Map<string, Rect>();
  const dividers: DividerSpec[] = [];
  const walk = (node: LayoutNode, rect: Rect, path: readonly number[]) => {
    if (node.kind === "leaf") {
      panes.set(node.paneId, rect);
      return;
    }
    const row = node.dir === "row";
    let offset = 0;
    node.children.forEach((child, i) => {
      const size = node.sizes[i];
      if (i > 0) {
        dividers.push({
          path,
          index: i - 1,
          dir: node.dir,
          line: row ? { x: rect.x + offset * rect.w, y: rect.y, w: 0, h: rect.h } : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: 0 },
          split: rect,
        });
      }
      const childRect: Rect = row ? { x: rect.x + offset * rect.w, y: rect.y, w: size * rect.w, h: rect.h } : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: size * rect.h };
      walk(child, childRect, [...path, i]);
      offset += size;
    });
  };
  walk(root, { x: 0, y: 0, w: 1, h: 1 }, []);
  return { panes, dividers };
}
