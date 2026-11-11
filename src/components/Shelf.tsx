// The Portal Dropzone shelf: a staging basket for files from many folders. It opens by itself while a
// file drag is in flight so there is always a target close by, and tucks away again afterwards.
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { baseName, extensionOf, parentPath } from "../lib/paths";
import { settings } from "../state/settings";
import { shelf } from "../state/shelf";
import { workspace } from "../state/workspace";
import { Glyph, TypeIcon } from "./Icons";

const DRAG_MIME = "application/x-octopolis-paths";

/** Names without an extension are almost always folders; good enough for an icon. */
const isFolderLike = (path: string) => extensionOf(baseName(path)) === "";

export function Shelf() {
  const dest = () => workspace.activeTab()?.path() ?? "";
  const destName = () => baseName(dest()) || dest();
  const [over, setOver] = createSignal(false);
  const count = () => shelf.items().length;
  const expanded = () => shelf.open() || (shelf.dragging() && shelf.hot());

  onMount(() => {
    // Row drags set the payload on the source element, so by the time the event bubbles to the window
    // the types are known and unrelated drags (tabs, text) are ignored.
    const start = (e: DragEvent) => e.dataTransfer?.types.includes(DRAG_MIME) && settings.shelfAutoOpen() && shelf.setDragging(true);
    const end = () => {
      shelf.setDragging(false);
      setOver(false);
    };
    // A click anywhere outside the card (other than the footer toggle, which handles itself) closes it.
    const outside = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!shelf.open() || shelf.dragging() || t?.closest(".shelf, [data-shelf-toggle]")) return;
      shelf.setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    onCleanup(() => document.removeEventListener("pointerdown", outside, true));
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end, true);
    onCleanup(() => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end, true);
    });
  });

  return (
    <div
      class="shelf"
      ref={(el) => createEffect(() => (el.inert = !expanded()))}
      classList={{ open: expanded(), over: over(), drag: shelf.dragging() }}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes(DRAG_MIME)) {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
          setOver(true);
          shelf.setHot(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver(false);
        shelf.setHot(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const raw = e.dataTransfer?.getData(DRAG_MIME);
        if (!raw) return;
        e.preventDefault();
        e.stopPropagation();
        shelf.add(JSON.parse(raw) as string[]);
      }}
    >
      <button class="shelf-head" aria-label="Hide shelf" data-tooltip="Hide shelf · Ctrl+Shift+D adds the selection" disabled={shelf.dragging()} onClick={() => shelf.setOpen(false)}>
        <Glyph code="E7B8" size={15} />
        <span class="shelf-title">Shelf</span>
        <span class="shelf-count" classList={{ empty: count() === 0 }}>{count()}</span>
        <span class="shelf-chevron">
          <Glyph code="E70D" size={11} />
        </span>
      </button>

      <div class="shelf-collapse">
        <div class="shelf-body">
          <Show
            when={count() > 0}
            fallback={
              <div class="shelf-drop">
                <Glyph code="E7B8" size={24} />
                <span class="shelf-drop-title">{shelf.dragging() ? "Drop to add to the shelf" : "Nothing on the shelf"}</span>
                <span class="shelf-drop-sub">Drag files here from any folder, then drop them where you need them.</span>
              </div>
            }
          >
            <div class="shelf-list">
              <For each={shelf.items()}>
                {(p) => (
                  <div class="shelf-item" data-tooltip={p} data-tooltip-truncated=".shelf-file, .shelf-dir">
                    <TypeIcon path={p} name={baseName(p)} isDir={isFolderLike(p)} size={18} />
                    <span class="shelf-name">
                      <span class="shelf-file">{baseName(p)}</span>
                      <span class="shelf-dir"><bdi>{parentPath(p) ?? ""}</bdi></span>
                    </span>
                    <button class="icon-btn shelf-remove" aria-label={`Remove ${baseName(p)}`} onClick={() => shelf.remove(p)}>
                      <Glyph code="E711" size={10} />
                    </button>
                  </div>
                )}
              </For>
            </div>
            <Show when={shelf.dragging()}>
              <div class="shelf-more">Drop to add more</div>
            </Show>
          </Show>

          <div class="shelf-foot">
            <div class="shelf-dest" data-tooltip={dest()}>
              <span>Into</span>
              <strong>{destName()}</strong>
            </div>
            <div class="shelf-actions">
              <button class="btn small primary" disabled={!count()} onClick={() => shelf.deliver("copy", dest())}>
                <Glyph code="E8C8" size={13} /> Copy here
              </button>
              <button class="btn small" disabled={!count()} onClick={() => shelf.deliver("move", dest())}>
                <Glyph code="E72A" size={13} /> Move here
              </button>
              <button class="icon-btn shelf-clear" disabled={!count()} aria-label="Clear shelf" data-tooltip="Clear shelf" onClick={shelf.clear}>
                <Glyph code="E74D" size={15} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
