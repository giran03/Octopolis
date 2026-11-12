// Inspector previews for fonts, tables (CSV, TSV, JSON Lines) and text file details.
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { editFiles } from "../actions";
import { errorText, installFont } from "../lib/ipc";
import { MAX_TABLE_ROWS, sortRows, toTable } from "../lib/table";
import { ui } from "../state/ui";

/** "UTF-8 · Windows (CRLF) · 120 lines" and an Open in editor button. */
export function TextDetails(props: { path: string; details: readonly [string, string][] }) {
  const get = (k: string) => props.details.find(([n]) => n === k)?.[1];
  const summary = () => [get("Type"), get("Encoding"), get("Line endings"), get("Lines") && `${get("Lines")} lines`].filter(Boolean).join(" · ");
  return (
    <div class="text-details small">
      <span class="muted">{summary()}</span>
      {/* Office documents show extracted text, so opening them as text in an editor makes no sense. */}
      <Show when={!get("Type")}>
        <button class="link-btn" title="Open in editor (Ctrl+Shift+O)" onClick={() => void editFiles([props.path])}>
          Open in editor
        </button>
      </Show>
    </div>
  );
}

const ROW_PX = 24;
const OVERSCAN = 8;

/** Sortable, virtualised table with a switch back to the raw text. */
export function TableView(props: { name: string; text: string; truncated: boolean }) {
  const table = createMemo(() => toTable(props.name, props.text));
  const [sort, setSort] = createSignal<{ col: number; desc: boolean } | null>(null);
  const [raw, setRaw] = createSignal(false);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(400);
  const rows = createMemo(() => {
    const s = sort();
    return s ? sortRows(table().rows, s.col, s.desc) : table().rows;
  });
  const first = () => Math.max(0, Math.floor(scrollTop() / ROW_PX) - OVERSCAN);
  const visible = () => rows().slice(first(), first() + Math.ceil(height() / ROW_PX) + OVERSCAN * 2);
  const clickHeader = (col: number) => setSort((s) => (s?.col !== col ? { col, desc: false } : s.desc ? null : { col, desc: true }));
  let scroller: HTMLDivElement | undefined;
  const ro = new ResizeObserver(() => scroller && setHeight(scroller.clientHeight));
  onCleanup(() => ro.disconnect());
  const cols = () => `repeat(${table().header.length}, minmax(80px, max-content))`;

  return (
    <div class="table-view">
      <div class="text-details small">
        <span class="muted">
          {table().rows.length.toLocaleString()} rows · {table().header.length} columns
          {props.truncated || table().truncated ? ` · first ${Math.min(table().rows.length, MAX_TABLE_ROWS).toLocaleString()} shown` : ""}
        </span>
        <button class="link-btn" aria-pressed={raw()} onClick={() => setRaw((v) => !v)}>
          {raw() ? "Show as table" : "Show raw text"}
        </button>
      </div>
      <Show when={!raw()} fallback={<pre class="plain">{props.text}</pre>}>
        <div
          class="table-scroll"
          role="grid"
          aria-rowcount={rows().length + 1}
          aria-colcount={table().header.length}
          ref={(el) => {
            scroller = el;
            ro.observe(el);
          }}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          <div class="table-row table-head" role="row" style={{ "grid-template-columns": cols() }}>
            <For each={table().header}>
              {(h, i) => (
                <button
                  class="table-cell"
                  role="columnheader"
                  aria-sort={sort()?.col === i() ? (sort()!.desc ? "descending" : "ascending") : "none"}
                  title={h}
                  onClick={() => clickHeader(i())}
                >
                  {h}
                  <Show when={sort()?.col === i()}>{sort()!.desc ? " ↓" : " ↑"}</Show>
                </button>
              )}
            </For>
          </div>
          <div style={{ height: `${rows().length * ROW_PX}px`, position: "relative" }}>
            <For each={visible()}>
              {(r, i) => (
                <div
                  class="table-row"
                  role="row"
                  aria-rowindex={first() + i() + 2}
                  style={{ "grid-template-columns": cols(), top: `${(first() + i()) * ROW_PX}px` }}
                >
                  <For each={table().header}>
                    {(_, c) => (
                      <span class="table-cell" role="gridcell" title={r[c()]}>
                        {r[c()] ?? ""}
                      </span>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

const SIZES = [12, 16, 20, 28, 40, 56, 72];
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789&@?!%$€£(){}[]<>/\\*#+-=.,:;'\"";
let fontSerial = 0;

/** Font specimen: sample text at several sizes, a glyph grid, and Install. */
export function FontView(props: { path: string; name: string; data: ArrayBuffer }) {
  const family = `octo-preview-${++fontSerial}`;
  const [sample, setSample] = createSignal("The quick brown fox jumps over the lazy dog");
  const [face] = createResource(async () => {
    const f = new FontFace(family, props.data);
    await f.load();
    document.fonts.add(f);
    return f;
  });
  onCleanup(() => {
    const f = face();
    if (f) document.fonts.delete(f);
  });
  const install = async () => {
    try {
      await installFont(props.path);
    } catch (e) {
      ui.toast(`Couldn't install this font: ${errorText(e)}`);
    }
  };
  return (
    <div class="font-view">
      <div class="text-details small">
        <input class="text-input font-sample" aria-label="Sample text" spellcheck={false} value={sample()} onInput={(e) => setSample(e.currentTarget.value)} />
        <button class="btn" onClick={() => void install()}>Install</button>
      </div>
      <Show when={!face.error} fallback={<p class="error-text">This font couldn't be read.</p>}>
        <Show when={face()} fallback={<p class="muted small">Loading font…</p>}>
          <div style={{ "font-family": `"${family}"` }}>
            <p class="font-hero">{props.name.replace(/\.[^.]+$/, "")}</p>
            <For each={SIZES}>
              {(px) => (
                <div class="font-line">
                  <span class="muted small num">{px}</span>
                  <span style={{ "font-size": `${px}px` }}>{sample() || " "}</span>
                </div>
              )}
            </For>
            <div class="glyph-grid" aria-label="Characters">
              <For each={[...GLYPHS]}>{(g) => <span>{g}</span>}</For>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
}
