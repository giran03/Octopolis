// Recent activity: the file operations finished this session, with what went wrong and an Undo for the last change.
import { For, Show } from "solid-js";
import { formatDate } from "../lib/format";
import { ops } from "../state/ops";
import { ui } from "../state/ui";
import { MaterialIcon } from "./Icons";

export function OpsHistory() {
  const close = () => ui.setOpsHistoryOpen(false);
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="dialog bin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ops-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") close();
        }}
      >
        <div class="bin-head">
          <h2 id="ops-title">Recent activity</h2>
          <span class="muted small">{ops.activity().length} this session</span>
        </div>
        <div class="bin-list ops-log">
          <For each={ops.activity()} fallback={<p class="muted bin-empty">Copies, moves, deletes and other file operations will show up here</p>}>
            {(a) => (
              <div class="ops-entry" classList={{ bad: a.errors.length > 0 && !a.cancelled }}>
                <MaterialIcon name={a.cancelled ? "block" : a.errors.length ? "error" : "check_circle"} size={18} class="ops-state" />
                <span class="bin-names">
                  <span class="bin-name">{a.label}</span>
                  <Show when={a.cancelled || a.errors.length > 0}>
                    <span class="small ops-detail" title={a.errors.join("\n")}>
                      {a.cancelled ? "Cancelled" : `${a.errors.length} problem${a.errors.length === 1 ? "" : "s"}: ${a.errors[0]}`}
                    </span>
                  </Show>
                </span>
                <span class="muted small bin-meta">{formatDate(a.at)}</span>
              </div>
            )}
          </For>
        </div>
        <div class="dialog-actions bin-actions">
          <button class="btn" disabled={ops.activity().length === 0} onClick={() => ops.clearActivity()}>Clear list</button>
          <span class="bin-spacer" />
          <button class="btn" onClick={() => void ops.undo()}>Undo last change</button>
          <button class="btn primary" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
