import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { isDir } from "../lib/listing";
import { hintsFor } from "../lib/hints";
import { formatKeys } from "../lib/keymap";
import { keybindings } from "../state/keybindings";
import { ops } from "../state/ops";
import { settings } from "../state/settings";
import { workspace } from "../state/workspace";

/** Marquee speed in pixels per second. */
const SPEED = 38;
/** Space between the end of the text and its repeat. */
const GAP = 48;

/** Shortcuts that fit what is selected, centered in the status bar. Long lists scroll right to left on a loop. */
export function StatusHints() {
  const tab = () => workspace.activeTab();

  const items = createMemo(() => {
    const t = tab();
    if (!t || !settings.showHints()) return [];
    const sel = t.selection();
    if (sel.size === 0) return [];
    const l = t.listing();
    let folders = 0;
    let files = 0;
    for (const i of sel) {
      if (i >= l.count) continue;
      if (isDir(l, i)) folders++;
      else files++;
    }
    const search = t.search();
    return hintsFor({ count: folders + files, folders, files, archive: !!t.archive(), search: !!search, canPaste: ops.canPaste(), git: !!t.git() })
      .map((hint) => ({ label: hint.label, keys: keybindings.keysForId(hint.id)[0] }))
      .filter((x): x is { label: string; keys: string } => !!x.keys)
      .map((x) => ({ label: x.label, keys: formatKeys(x.keys) }));
  });

  const plain = () => items().map((i) => `${i.keys} ${i.label}`).join("   ·   ");

  let clip: HTMLDivElement | undefined;
  let first: HTMLSpanElement | undefined;
  const [overflow, setOverflow] = createSignal(false);
  const [duration, setDuration] = createSignal(20);

  const measure = () => {
    if (!clip || !first) return setOverflow(false);
    const text = first.offsetWidth;
    setOverflow(text > clip.clientWidth);
    // One full loop moves by the text plus its gap, so the speed stays the same whatever the length.
    setDuration(Math.max(6, (text + GAP) / SPEED));
  };

  // The text element only exists while something is selected, so it is watched when it appears.
  const ro = new ResizeObserver(measure);
  onCleanup(() => ro.disconnect());
  const watchText = (el: HTMLSpanElement) => {
    first = el;
    ro.observe(el);
    queueMicrotask(measure);
  };
  onMount(() => {
    if (clip) ro.observe(clip);
  });
  // The text changes with the selection; measure again once it is in the page.
  createEffect(() => {
    items();
    queueMicrotask(measure);
  });

  return (
    <div class="status-hints" classList={{ empty: items().length === 0 }} ref={(el) => (clip = el)} title={plain()} aria-label={items().length ? `Shortcuts: ${plain()}` : undefined}>
      <Show when={items().length > 0}>
        <div class="hint-track" classList={{ scrolling: overflow() }} style={{ "--hint-duration": `${duration()}s`, "--hint-gap": `${GAP}px` }}>
          <HintRun ref={watchText} items={items()} />
          <Show when={overflow()}>
            <HintRun items={items()} hidden />
          </Show>
        </div>
      </Show>
    </div>
  );
}

function HintRun(props: { items: readonly { label: string; keys: string }[]; hidden?: boolean; ref?: (el: HTMLSpanElement) => void }) {
  return (
    <span class="hint-run" ref={props.ref} aria-hidden={props.hidden ? "true" : undefined}>
      <For each={props.items}>
        {(item, i) => (
          <>
            <Show when={i() > 0}>
              <span class="hint-dot" aria-hidden="true">·</span>
            </Show>
            <span class="hint">
              <kbd>{item.keys}</kbd> {item.label}
            </span>
          </>
        )}
      </For>
    </span>
  );
}
