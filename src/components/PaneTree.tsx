// Draws the panes and the dividers between them.
//
// Every pane sits in its own absolutely placed slot, keyed by pane id and sized from the layout tree
// (see `computeLayout`). Adding, closing or resizing a pane only changes numbers, so the slots glide to
// their new places and the panes themselves are never rebuilt.
import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import { computeLayout, type DividerSpec, type LayoutNode, type Rect } from "../lib/layout";
import { workspace } from "../state/workspace";
import { Pane } from "./Pane";

/** Space between neighbouring panes, split evenly: a pane keeps half of it on each inner side. */
const GAP = 6;
const EPS = 1e-6;

const dividerKey = (d: DividerSpec) => `${d.path.join(".")}:${d.index}`;

/** A pane that just closed: its frame fades out where it was while the others spread into its space. */
interface Ghost {
  readonly key: number;
  readonly rect: Rect;
}
let ghostKey = 1;

export function PaneTree(props: { node: LayoutNode }) {
  let root!: HTMLDivElement;
  const info = createMemo(() => computeLayout(props.node));
  const ids = createMemo(() => [...info().panes.keys()]);
  const dividerKeys = createMemo(() => info().dividers.map(dividerKey));
  const spec = (key: string) => info().dividers.find((d) => dividerKey(d) === key);
  const [resizing, setResizing] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [ghosts, setGhosts] = createSignal<readonly Ghost[]>([]);
  // Panes that exist at start-up don't animate in; later ones do.
  onMount(() => setTimeout(() => setReady(true), 0));

  createEffect(
    on(
      () => info().panes,
      (now, before) => {
        if (!before) return;
        for (const [id, rect] of before) {
          if (now.has(id)) continue;
          const ghost = { key: ghostKey++, rect };
          setGhosts((g) => [...g, ghost]);
          setTimeout(() => setGhosts((g) => g.filter((x) => x !== ghost)), 320);
        }
      },
    ),
  );

  const slotStyle = (id: string) => {
    const r = info().panes.get(id);
    if (!r) return {};
    const half = `${GAP / 2}px`;
    return {
      left: `${r.x * 100}%`,
      top: `${r.y * 100}%`,
      width: `${r.w * 100}%`,
      height: `${r.h * 100}%`,
      "padding-left": r.x > EPS ? half : "0px",
      "padding-top": r.y > EPS ? half : "0px",
      "padding-right": r.x + r.w < 1 - EPS ? half : "0px",
      "padding-bottom": r.y + r.h < 1 - EPS ? half : "0px",
    };
  };

  const dividerStyle = (d: DividerSpec) => {
    const row = d.dir === "row";
    return row
      ? { left: `calc(${d.line.x * 100}% - ${GAP / 2}px)`, top: `${d.line.y * 100}%`, width: `${GAP}px`, height: `${d.line.h * 100}%` }
      : { left: `${d.line.x * 100}%`, top: `calc(${d.line.y * 100}% - ${GAP / 2}px)`, width: `${d.line.w * 100}%`, height: `${GAP}px` };
  };

  const startDrag = (e: PointerEvent, key: string) => {
    const d = spec(key);
    if (!d) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setResizing(true);
    const horizontal = d.dir === "row";
    const total = horizontal ? d.split.w * root.clientWidth : d.split.h * root.clientHeight;
    let last = horizontal ? e.clientX : e.clientY;
    const move = (ev: PointerEvent) => {
      const now = horizontal ? ev.clientX : ev.clientY;
      workspace.resize(d.path, d.index, (now - last) / total);
      last = now;
    };
    const up = () => {
      setResizing(false);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div ref={root} class="panes-root" classList={{ resizing: resizing(), ready: ready(), split: ids().length > 1 }}>
      <For each={ids()}>
        {(id) => (
          <div class="pane-slot" style={slotStyle(id)}>
            <Pane pane={workspace.paneModel(id)} />
          </div>
        )}
      </For>
      <For each={dividerKeys()}>
        {(key) => (
          <Show when={spec(key)}>
            {(d) => <div class="pane-divider" classList={{ "pane-divider-h": d().dir === "row", "pane-divider-v": d().dir === "column" }} style={dividerStyle(d())} role="separator" onPointerDown={(e) => startDrag(e, key)} />}
          </Show>
        )}
      </For>
      <For each={ghosts()}>
        {(g) => (
          <div
            class="pane-slot pane-ghost"
            aria-hidden="true"
            style={{ left: `${g.rect.x * 100}%`, top: `${g.rect.y * 100}%`, width: `${g.rect.w * 100}%`, height: `${g.rect.h * 100}%` }}
          >
            <div class="pane-ghost-frame" />
          </div>
        )}
      </For>
    </div>
  );
}
