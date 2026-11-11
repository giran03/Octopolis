// Saved arrangements of panes and tabs (workspaces and the last session).
import { leaves, type LayoutNode } from "./layout";

export interface PresetPane {
  readonly tabs: readonly string[];
  readonly active: number;
  /** Per tab, in the same order: pinned to the front of the strip. */
  readonly pinned?: readonly boolean[];
  /** Per tab: a color name from TAB_COLORS, or null. */
  readonly colors?: readonly (string | null)[];
}

/** Colors a tab can be marked with. */
export const TAB_COLORS = ["red", "orange", "yellow", "green", "blue", "purple"] as const;

/** A saved arrangement of panes, tabs and folders. */
export interface Preset {
  readonly layout: LayoutNode;
  readonly panes: Readonly<Record<string, PresetPane>>;
}

const MAX_DEPTH = 16;

function parseNode(raw: unknown, depth: number): LayoutNode | null {
  if (typeof raw !== "object" || raw === null || depth > MAX_DEPTH) return null;
  const n = raw as Record<string, unknown>;
  if (n.kind === "leaf") return typeof n.paneId === "string" ? { kind: "leaf", paneId: n.paneId } : null;
  if (n.kind !== "split" || (n.dir !== "row" && n.dir !== "column")) return null;
  if (!Array.isArray(n.children) || !Array.isArray(n.sizes) || n.children.length < 2 || n.children.length !== n.sizes.length) return null;
  const children = n.children.map((c) => parseNode(c, depth + 1));
  if (children.some((c) => c === null)) return null;
  const sizes = n.sizes.map(Number);
  if (sizes.some((s) => !Number.isFinite(s) || s <= 0)) return null;
  const total = sizes.reduce((a, b) => a + b, 0);
  return { kind: "split", dir: n.dir, children: children as LayoutNode[], sizes: sizes.map((s) => s / total) };
}

/**
 * Checks a stored preset, so a damaged or hand-edited value can't break startup.
 * Returns null unless every pane in the layout appears once and has at least one tab.
 */
export function parsePreset(raw: unknown): Preset | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const layout = parseNode(r.layout, 0);
  if (!layout || typeof r.panes !== "object" || r.panes === null) return null;
  const ids = leaves(layout);
  if (new Set(ids).size !== ids.length) return null;
  const panes: Record<string, PresetPane> = {};
  for (const id of ids) {
    const p = (r.panes as Record<string, unknown>)[id] as Record<string, unknown> | undefined;
    if (!p || !Array.isArray(p.tabs)) return null;
    const rawTabs: readonly unknown[] = p.tabs;
    const keep = rawTabs.map((t) => typeof t === "string" && t.length > 0);
    const tabs = rawTabs.filter((_, i) => keep[i]) as string[];
    if (tabs.length === 0) return null;
    const active = Number.isInteger(p.active) ? Math.min(Math.max(0, p.active as number), tabs.length - 1) : 0;
    const perTab = <T,>(raw: unknown, ok: (v: unknown) => v is T, fallback: T): T[] =>
      Array.isArray(raw) ? rawTabs.map((_: unknown, i: number) => (ok(raw[i]) ? raw[i] : fallback)).filter((_: T, i: number) => keep[i]) : tabs.map(() => fallback);
    const pinned = perTab(p.pinned, (v): v is boolean => typeof v === "boolean", false);
    const colors = perTab(p.colors, (v): v is string | null => v === null || (TAB_COLORS as readonly unknown[]).includes(v), null);
    panes[id] = { tabs, active, pinned, colors };
  }
  return { layout, panes };
}
