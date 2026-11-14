import { Show } from "solid-js";
import { dialogAssist, sendableFolder } from "../state/dialogAssist";
import { workspace } from "../state/workspace";
import "./DialogPickBar.css";

/** Shown while another app's Open or Save dialog is waiting for a pick made here (Ctrl+Shift+G in the dialog). */
export function DialogPickBar() {
  const count = () => workspace.activeTab()?.selectedPaths().length ?? 0;
  const folder = () => sendableFolder(workspace.activeTab());
  return (
    <Show when={dialogAssist.pick()}>
      {(pick) => (
        <div class="dialog-pick-bar" role="region" aria-label="Choosing for another app">
          <span class="dialog-pick-text">
            Choosing for <strong>{pick().title || "a dialog"}</strong>
            <Show when={pick().app}>
              <span class="muted"> in {pick().app}</span>
            </Show>
          </span>
          <Show when={!pick().save}>
            <button class="btn primary" disabled={count() === 0} onClick={() => void dialogAssist.useSelection()}>
              {count() > 1 ? `Use ${count()} selected files` : "Use selected file"}
            </button>
          </Show>
          <button class="btn" classList={{ primary: pick().save }} disabled={!folder()} onClick={() => void dialogAssist.useFolder()}>
            Use this folder
          </button>
          <button class="btn" onClick={() => dialogAssist.cancel()}>
            Cancel
          </button>
        </div>
      )}
    </Show>
  );
}
