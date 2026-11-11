// Drag-a-box selection for the details list and the grid, with auto-scroll
// when the pointer goes past the top or bottom edge.
import { createSignal, onCleanup } from "solid-js";
import { marqueeSelection } from "../lib/selection";
import type { TabModel } from "../state/tab";

/** Pixels the pointer must move before a press becomes a box drag (a plain click stays a click). */
const START_DISTANCE = 4;
const EDGE = 28;
const SCROLL_STEP = 18;
const TICK_MS = 30;

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * `positionsFor` turns a rectangle in content pixels (scroll offset included)
 * into the view positions it touches.
 */
export function createMarquee(opts: {
  scroller: () => HTMLElement;
  tab: () => TabModel;
  positionsFor: (x1: number, y1: number, x2: number, y2: number) => readonly number[];
}) {
  const [box, setBox] = createSignal<Box | null>(null);
  let stop: (() => void) | null = null;
  onCleanup(() => stop?.());

  const toContent = (clientX: number, clientY: number) => {
    const el = opts.scroller();
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left + el.scrollLeft, y: clientY - r.top + el.scrollTop };
  };

  /** Begins watching a press; the box appears once the pointer moves a little. Ctrl adds to the selection. */
  function start(e: MouseEvent) {
    if (e.button !== 0) return;
    stop?.();
    const origin = toContent(e.clientX, e.clientY);
    const startClient = { x: e.clientX, y: e.clientY };
    const base = e.ctrlKey ? opts.tab().selection() : new Set<number>();
    let last = startClient;
    let active = false;

    const update = () => {
      const p = toContent(last.x, last.y);
      setBox({ left: Math.min(origin.x, p.x), top: Math.min(origin.y, p.y), width: Math.abs(p.x - origin.x), height: Math.abs(p.y - origin.y) });
      const t = opts.tab();
      const positions = opts.positionsFor(origin.x, origin.y, p.x, p.y);
      t.setSelection(marqueeSelection(t.view(), base, positions));
      if (positions.length) t.setFocus(positions[positions.length - 1]);
    };
    const move = (m: MouseEvent) => {
      last = { x: m.clientX, y: m.clientY };
      if (!active && Math.hypot(m.clientX - startClient.x, m.clientY - startClient.y) < START_DISTANCE) return;
      active = true;
      update();
    };
    // Keep scrolling while the pointer is held past an edge.
    const timer = setInterval(() => {
      if (!active) return;
      const el = opts.scroller();
      const r = el.getBoundingClientRect();
      const delta = last.y < r.top + EDGE ? -SCROLL_STEP : last.y > r.bottom - EDGE ? SCROLL_STEP : 0;
      if (delta) {
        el.scrollTop += delta;
        update();
      }
    }, TICK_MS);
    const end = () => stop?.();
    stop = () => {
      clearInterval(timer);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", end);
      setBox(null);
      stop = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
  }

  return { box, start };
}
