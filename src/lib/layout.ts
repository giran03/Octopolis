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
 * Splits the pane `target`, placing `newPaneId` after it. Splitting in the
 * same direction as the parent adds a sibling instead of nesting.
 */
export function splitPane(root: LayoutNode, target: string, newPaneId: string, dir: Direction): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === "leaf") {
      return node.paneId === target
        ? { kind: "split", dir, children: [node, leaf(newPaneId)], sizes: [0.5, 0.5] }
        : node;
    }
    const at = node.children.findIndex((c) => c.kind === "leaf" && c.paneId === target);
    if (at >= 0 && node.dir === dir) {
      const half = node.sizes[at] / 2;
      return {
        ...node,
        children: [...node.children.slice(0, at + 1), leaf(newPaneId), ...node.children.slice(at + 1)],
        sizes: [...node.sizes.slice(0, at), half, half, ...node.sizes.slice(at + 1)],
      };
    }
    return { ...node, children: node.children.map(walk) };
  };
  return walk(root);
}

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
