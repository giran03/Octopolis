// Disk space treemap of the current folder. Folders navigate, files select.
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { formatSize } from "../lib/format";
import { isDir } from "../lib/listing";
import { squarify } from "../lib/treemap";
import type { TabModel } from "../state/tab";

interface Item {
  readonly entry: number;
  readonly name: string;
  readonly size: number;
  readonly dir: boolean;
}

export function Treemap(props: { tab: TabModel }) {
  let box!: HTMLDivElement;
  const [size, setSize] = createSignal({ w: 800, h: 500 });
  onMount(() => {
    const ro = new ResizeObserver(() => setSize({ w: box.clientWidth, h: box.clientHeight }));
    ro.observe(box);
    onCleanup(() => ro.disconnect());
  });

  const items = createMemo<Item[]>(() => {
    const l = props.tab.listing();
    const sizes = props.tab.dirSizes();
    const out: Item[] = [];
    for (let i = 0; i < l.count; i++) {
      const dir = isDir(l, i);
      const bytes = dir ? (sizes?.get(l.names[i].toLowerCase()) ?? 0) : l.sizes[i];
      if (bytes > 0) out.push({ entry: i, name: l.names[i], size: bytes, dir });
    }
    return out;
  });
  const tiles = createMemo(() => squarify(items(), (i) => i.size, { x: 0, y: 0, w: size().w, h: size().h }));
  const total = () => items().reduce((s, i) => s + i.size, 0);

  return (
    <div class="treemap-wrap">
      <div class="treemap-bar">
        <span>{formatSize(total())} in this folder</span>
        <span class="spacer" />
        <button class="btn small" onClick={() => props.tab.setTreemap(false)}>Back to list</button>
      </div>
      <div ref={box} class="treemap" role="img" aria-label="Disk usage map">
        <For each={tiles()}>
          {(t) => (
            <button
              class="tile"
              classList={{ dir: t.item.dir }}
              style={{ left: `${t.x}px`, top: `${t.y}px`, width: `${t.w}px`, height: `${t.h}px` }}
              title={`${t.item.name} — ${formatSize(t.item.size)}`}
              onClick={() => (t.item.dir ? void props.tab.navigate(props.tab.pathOf(t.item.entry)) : props.tab.selectNames([t.item.name]))}
            >
              <Show when={t.w > 64 && t.h > 28}>
                <span class="tile-name">{t.item.name}</span>
                <span class="tile-size">{formatSize(t.item.size)}</span>
              </Show>
            </button>
          )}
        </For>
        <Show when={tiles().length === 0}>
          <div class="list-state"><span>{props.tab.dirSizes() ? "Measuring…" : "Nothing to show"}</span></div>
        </Show>
      </div>
    </div>
  );
}
