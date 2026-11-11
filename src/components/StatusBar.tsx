import { Show } from "solid-js";
import { formatCount, formatSize } from "../lib/format";
import { isDir } from "../lib/listing";
import { ops } from "../state/ops";
import { settings } from "../state/settings";
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
            <span>{formatCount(t().view().length, "item")}</span>
            <Show when={t().selection().size > 0}>
              <span>
                {t().selection().size.toLocaleString()} selected
                <Show when={selectedBytes() > 0}> · {formatSize(selectedBytes())}</Show>
              </span>
            </Show>
            <Show when={t().status().elapsedMs !== null}>
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
      <span class="spacer" />
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
