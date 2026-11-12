// The Recycle Bin: what was deleted, from where and when; put items back or delete them for good.
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { categoryOf, formatDate, formatSize } from "../lib/format";
import { errorText, recycleBinEmpty, recycleBinList, recycleBinPurge, recycleBinRestore, type BinItem } from "../lib/ipc";
import { parentPath, samePath } from "../lib/paths";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";
import { FileGlyph } from "./Icons";

/** Rows rendered at most; the search narrows larger bins. */
const MAX_ROWS = 500;

export function RecycleBin() {
  const [items, { refetch }] = createResource(() => recycleBinList());
  const [query, setQuery] = createSignal("");
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = createSignal<null | "purge" | "empty">(null);
  const [busy, setBusy] = createSignal(false);

  const shown = createMemo(() => {
    const q = query().trim().toLowerCase();
    const all = items() ?? [];
    return q ? all.filter((i) => i.name.toLowerCase().includes(q) || i.originalPath.toLowerCase().includes(q)) : all;
  });
  const total = () => (items() ?? []).reduce((s, i) => s + (i.size ?? 0), 0);
  const close = () => ui.setRecycleBinOpen(false);

  const toggle = (id: string, e: MouseEvent) => {
    setPicked((s) => {
      if (!e.ctrlKey && !e.shiftKey) return new Set([id]);
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const refreshTabs = (restored: readonly BinItem[]) => {
    for (const t of workspace.allTabs()) if (restored.some((i) => samePath(parentPath(i.originalPath) ?? "", t.path()))) void t.refresh();
  };

  const act = async (what: "restore" | "purge" | "empty") => {
    setConfirm(null);
    setBusy(true);
    const ids = [...picked()];
    const restoring = (items() ?? []).filter((i) => picked().has(i.id));
    try {
      const n = what === "restore" ? await recycleBinRestore(ids) : what === "purge" ? await recycleBinPurge(ids) : await recycleBinEmpty();
      if (what === "restore") refreshTabs(restoring);
      ui.toast(what === "restore" ? `Restored ${n} item${n === 1 ? "" : "s"}` : `Deleted ${n} item${n === 1 ? "" : "s"} for good`);
      setPicked(new Set<string>());
      await refetch();
    } catch (e) {
      ui.toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="dialog bin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bin-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") return confirm() ? setConfirm(null) : close();
          if (e.key === "a" && e.ctrlKey) {
            e.preventDefault();
            setPicked(new Set(shown().map((i) => i.id)));
          }
        }}
      >
        <div class="bin-head">
          <h2 id="bin-title">Recycle Bin</h2>
          <span class="muted small">
            {(items() ?? []).length.toLocaleString()} items · {formatSize(total())}
          </span>
        </div>
        <input class="text-input" placeholder="Search by name or original folder" spellcheck={false} value={query()} onInput={(e) => setQuery(e.currentTarget.value)} ref={(el) => queueMicrotask(() => el.focus())} />
        <Show when={!items.loading} fallback={<p class="muted">Reading the Recycle Bin…</p>}>
          <Show when={!items.error} fallback={<p class="error-text">{errorText(items.error)}</p>}>
            <Show when={shown().length > 0} fallback={<p class="muted bin-empty">{query() ? "Nothing matches" : "The Recycle Bin is empty"}</p>}>
              <div class="bin-list" role="listbox" aria-multiselectable="true">
                <For each={shown().slice(0, MAX_ROWS)}>
                  {(i) => (
                    <div class="bin-row" role="option" aria-selected={picked().has(i.id)} classList={{ selected: picked().has(i.id) }} onMouseDown={(e) => toggle(i.id, e)} onDblClick={() => void act("restore")}>
                      <FileGlyph category={categoryOf(i.name, i.isDir)} size={18} />
                      <span class="bin-names">
                        <span class="bin-name">{i.name}</span>
                        <button
                          class="link-btn bin-from bin-folder"
                          title="Show the folder it was deleted from"
                          onMouseDown={(e) => e.stopPropagation()}
                          onDblClick={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            const dir = parentPath(i.originalPath);
                            if (!dir) return;
                            close();
                            void workspace.activeTab()?.navigate(dir);
                          }}
                        >
                          {parentPath(i.originalPath) ?? i.originalPath}
                        </button>
                      </span>
                      <span class="muted small bin-meta">{i.size === null ? "Folder" : formatSize(i.size)}</span>
                      <span class="muted small bin-meta">{formatDate(i.deletedMs)}</span>
                    </div>
                  )}
                </For>
                <Show when={shown().length > MAX_ROWS}>
                  <p class="muted small">{(shown().length - MAX_ROWS).toLocaleString()} more. Search to narrow the list.</p>
                </Show>
              </div>
            </Show>
          </Show>
        </Show>
        <Show when={confirm()}>
          {(c) => (
            <div class="setting-note" role="alertdialog">
              <p>{c() === "empty" ? `Delete all ${(items() ?? []).length} items in the Recycle Bin for good? This can't be undone.` : `Delete ${picked().size} item${picked().size === 1 ? "" : "s"} for good? This can't be undone.`}</p>
              <div class="dialog-actions">
                <button class="btn" onClick={() => setConfirm(null)}>Cancel</button>
                <button class="btn danger" onClick={() => void act(c())}>Delete for good</button>
              </div>
            </div>
          )}
        </Show>
        <div class="dialog-actions bin-actions">
          <button class="btn danger" disabled={busy() || !(items() ?? []).length} onClick={() => setConfirm("empty")}>
            Empty Recycle Bin
          </button>
          <span class="bin-spacer" />
          <button class="btn" disabled={busy() || picked().size === 0} onClick={() => setConfirm("purge")}>
            Delete for good
          </button>
          <button class="btn primary" disabled={busy() || picked().size === 0} onClick={() => void act("restore")}>
            Restore{picked().size > 1 ? ` ${picked().size} items` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
