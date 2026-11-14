import { Show } from "solid-js";
import { invertSelected } from "../actions";
import { formatCount, formatSize } from "../lib/format";
import { isDir } from "../lib/listing";
import { compactFooterTools } from "../lib/sidebar";
import { ops } from "../state/ops";
import { settings } from "../state/settings";
import { sidebar } from "../state/sidebar";
import type { SearchState } from "../state/tab";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";
import { FooterTools } from "./FooterTools";
import { StatusHints } from "./StatusHints";
import { IconBranch, IconEye, IconGitCommit, IconGitIgnore, IconSidebar, IconSidebarClose, IconSplitCol, IconSplitRow, MaterialIcon } from "./Icons";

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
      <Show when={compactFooterTools(settings.sidebarOpen(), sidebar.width())}>
        <div class="status-actions">
          <FooterTools size={14} />
          <span class="status-sep" aria-hidden="true" />
        </div>
      </Show>
      <Show when={tab()}>
        {(t) => (
          <>
            <Show when={t().search()} fallback={<span>{formatCount(t().view().length, "item")}</span>}>
              {(s) => <SearchStatus s={s()} shown={t().view().length} />}
            </Show>
            <Show when={t().selection().size > 0}>
              <span class="status-selection">
                <span>
                  {t().selection().size.toLocaleString()} selected
                  <Show when={selectedBytes() > 0}> · {formatSize(selectedBytes())}</Show>
                </span>
                <button
                  class="status-chip"
                  data-tooltip="Clear selection (Esc)"
                  onClick={() => t().setSelection(new Set<number>())}
                >
                  Clear
                </button>
                <button
                  class="status-chip"
                  data-tooltip="Invert selection (Ctrl+Shift+I)"
                  onClick={() => invertSelected(t())}
                >
                  Invert
                </button>
              </span>
            </Show>
            <Show when={t().status().elapsedMs !== null && !t().search()}>
              <span class="muted" data-tooltip="Time the engine spent reading the folder">
                listed in {t().status().elapsedMs!.toFixed(1)} ms
              </span>
            </Show>
            <Show when={ui.typeAhead()}>
              {(ta) => (
                <span class="status-typeahead" classList={{ miss: !ta().matched }}>
                  Jump: <strong>{ta().prefix}</strong>
                  <Show when={ta().total > 0}>
                    <span class="muted">
                      {ta().matched ? ` · ${ta().index}/${ta().total}` : " · no match"}
                    </span>
                  </Show>
                  <Show when={ta().total === 0 && !ta().matched}>
                    <span class="muted"> · no match</span>
                  </Show>
                </span>
              )}
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
        {(b) => <span class="git-branch" data-tooltip="Git branch"><IconBranch size={12} /> {b()}</span>}
      </Show>
      <StatusHints />
      <div class="status-actions">
      <Show when={tab()?.git()}>
        <button
          class="icon-btn"
          classList={{ on: settings.hideGitIgnored() }}
          aria-label="Hide files Git ignores"
          aria-pressed={settings.hideGitIgnored()}
          data-tooltip="Hide files Git ignores"
          onClick={() => settings.set({ hideGitIgnored: !settings.hideGitIgnored() })}
        >
          <IconGitIgnore size={14} />
        </button>
        <button
          class="icon-btn"
          classList={{ on: settings.showCommits() }}
          aria-label="Show last commit"
          aria-pressed={settings.showCommits()}
          data-tooltip="Show last commit"
          onClick={settings.toggleCommits}
        >
          <IconGitCommit size={14} />
        </button>
        <span class="status-sep" aria-hidden="true" />
      </Show>
      <button class="icon-btn" classList={{ on: settings.showHidden() }} data-tooltip="Show hidden items (Ctrl+H)" onClick={settings.toggleHidden}>
        <IconEye size={14} />
      </button>
      <button
        class="icon-btn"
        classList={{ on: settings.sidebarOpen() }}
        aria-label={settings.sidebarOpen() ? "Collapse sidebar" : "Expand sidebar"}
        aria-pressed={settings.sidebarOpen()}
        data-tooltip={settings.sidebarOpen() ? "Collapse sidebar (Ctrl+B)" : "Expand sidebar (Ctrl+B)"}
        onClick={settings.toggleSidebar}
      >
        <Show when={settings.sidebarOpen()} fallback={<IconSidebar size={14} />}>
          <IconSidebarClose size={14} />
        </Show>
      </button>
      <button class="icon-btn" data-tooltip="Split right (Ctrl+\)" onClick={() => workspace.split("row")}>
        <IconSplitRow size={14} />
      </button>
      <button class="icon-btn" data-tooltip="Split down (Ctrl+Shift+\)" onClick={() => workspace.split("column")}>
        <IconSplitCol size={14} />
      </button>
      <Show when={workspace.paneCount() > 1}>
        <button class="icon-btn" data-tooltip="Swap the two panes" aria-label="Swap panes" onClick={() => workspace.swapPanes()}>
          <MaterialIcon name="swap_horiz" size={14} />
        </button>
        <button
          class="icon-btn"
          classList={{ on: workspace.synced() }}
          data-tooltip={workspace.synced() ? "Synchronized browsing is on: going into a folder or up does the same in the other pane" : "Synchronized browsing: move both panes together"}
          aria-label="Synchronized browsing"
          aria-pressed={workspace.synced()}
          onClick={() => workspace.toggleSynced()}
        >
          <MaterialIcon name={workspace.synced() ? "link" : "link_off"} size={14} />
        </button>
      </Show>
      </div>
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
          <span class="muted" data-tooltip={m().mode === "usn" ? "Indexed from the NTFS change journal" : "Indexed by scanning folders"}>
            {m().indexed.toLocaleString()} indexed{m().indexMs !== null ? ` in ${(m().indexMs! / 1000).toFixed(1)} s` : ""} · {m().elapsedMs.toFixed(0)} ms
          </span>
        )}
      </Show>
    </Show>
  );
}
