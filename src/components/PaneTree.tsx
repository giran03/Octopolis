// Renders the split layout tree with draggable dividers.
import { For, Match, Show, Switch } from "solid-js";
import type { LayoutNode } from "../lib/layout";
import { workspace } from "../state/workspace";
import { Pane } from "./Pane";

export function PaneTree(props: { node: LayoutNode; path?: readonly number[] }) {
  const path = () => props.path ?? [];
  return (
    <Switch>
      <Match when={props.node.kind === "leaf" && props.node} keyed>
        {(n) => <Pane pane={workspace.paneModel(n.paneId)} />}
      </Match>
      <Match when={props.node.kind === "split" && props.node} keyed>
        {(n) => {
          let box!: HTMLDivElement;
          const startDrag = (e: PointerEvent, index: number) => {
            e.preventDefault();
            const el = e.currentTarget as HTMLElement;
            el.setPointerCapture(e.pointerId);
            const horizontal = n.dir === "row";
            const total = horizontal ? box.clientWidth : box.clientHeight;
            let last = horizontal ? e.clientX : e.clientY;
            const move = (ev: PointerEvent) => {
              const now = horizontal ? ev.clientX : ev.clientY;
              workspace.resize(path(), index, (now - last) / total);
              last = now;
            };
            const up = () => {
              el.removeEventListener("pointermove", move);
              el.removeEventListener("pointerup", up);
            };
            el.addEventListener("pointermove", move);
            el.addEventListener("pointerup", up);
          };
          return (
            <div ref={box} class="split" classList={{ "split-h": n.dir === "row", "split-v": n.dir === "column" }}>
              <For each={n.children}>
                {(child, i) => (
                  <>
                    <Show when={i() > 0}>
                      <div class="divider" role="separator" onPointerDown={(e) => startDrag(e, i() - 1)} />
                    </Show>
                    <div class="split-cell" style={{ "flex-grow": n.sizes[i()] }}>
                      <PaneTree node={child} path={[...path(), i()]} />
                    </div>
                  </>
                )}
              </For>
            </div>
          );
        }}
      </Match>
    </Switch>
  );
}
