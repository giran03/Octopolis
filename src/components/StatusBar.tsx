import { Show } from "solid-js";
import { formatCount, formatSize } from "../lib/format";
import { isDir } from "../lib/listing";
import { ops } from "../state/ops";
import { settings } from "../state/settings";
import type { SearchState } from "../state/tab";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";
import { IconEye, IconSidebar, IconSplitCol, IconSplitRow } from "./Icons";

export function StatusBar() {
  const tab = () => workspace.activeTab();
  const selectedBytes = () => {
    const t = tab();
    if (!t) return 0;
    const l = t.listing();
    let sum = 0;
    for (const i of t.selection()) if (i < l.count && !isDir(l, i)) sum += l.sizes[i];
    return sum;
  };
  return (
    <footer class="statusbar">
      <Show when={tab()}>
        {(t) => (
          <>
            <Show when={t().search()} fallback={<span>{formatCount(t().view().length, "item")}</span>}>
              {(s) => <SearchStatus s={s()} shown={t().view().length} />}
            </Show>
            <Show when={t().selection().size > 0}>
              <span>
                {t().selection().size.toLocaleString()} selected
                <Show when={selectedBytes() > 0}> · {formatSize(selectedBytes())}</Show>
              </span>
            </Show>
            <Show when={t().status().elapsedMs !== null && !t().search()}>
              <span class="muted" title="Time the engine spent reading the folder">
                listed in {t().status().elapsedMs!.toFixed(1)} ms
              </span>
            </Show>
            <Show when={ops.clip()}>
              {(c) => (
                <span class="muted">
                  {c().paths.length.toLocaleString()} {c().mode === "cut" ? "cut" : "copied"} — Ctrl+V to paste
                </span>
              )}
            </Show>
          </>
        )}
      </Show>
      <Show when={tab()?.git()?.branch}>
        {(b) => <span class="git-branch" title="Git branch">⎇ {b()}</span>}
      </Show>
      <span class="spacer" />
      <button class="icon-btn" title="Settings (Ctrl+,)" onClick={() => ui.setSettingsOpen(true)}>⚙</button>
      <button class="icon-btn" classList={{ on: settings.showHidden() }} title="Show hidden items (Ctrl+H)" onClick={settings.toggleHidden}>
        <IconEye size={14} />
      </button>
      <button class="icon-btn" classList={{ on: settings.sidebarOpen() }} title="Sidebar (Ctrl+B)" onClick={settings.toggleSidebar}>
        <IconSidebar size={14} />
      </button>
      <button class="icon-btn" title="Split right (Ctrl+\)" onClick={() => workspace.split("row")}>
        <IconSplitRow size={14} />
      </button>
      <button class="icon-btn" title="Split down (Ctrl+Shift+\)" onClick={() => workspace.split("column")}>
        <IconSplitCol size={14} />
      </button>
    </footer>
  );
}

function SearchStatus(props: { s: SearchState; shown: number }) {
  const sum = () => props.s.summary;
  return (
    <Show
      when={props.s.indexing === null}
      fallback={<span class="accent-text">Indexing… {props.s.indexing!.toLocaleString()} items</span>}
    >
      <span>
        {props.s.query ? formatCount(props.shown, "match").replace("matchs", "matches") : `Flat view · ${formatCount(props.shown, "item")}`}
        <Show when={sum() && sum()!.matched > sum()!.shown}> (first {sum()!.shown.toLocaleString()} of {sum()!.matched.toLocaleString()})</Show>
      </span>
      <Show when={sum()}>
        {(m) => (
          <span class="muted" title={m().mode === "usn" ? "Indexed from the NTFS change journal" : "Indexed by scanning folders"}>
            {m().indexed.toLocaleString()} indexed{m().indexMs !== null ? ` in ${(m().indexMs! / 1000).toFixed(1)} s` : ""} · {m().elapsedMs.toFixed(0)} ms
          </span>
        )}
      </Show>
    </Show>
  );
}
