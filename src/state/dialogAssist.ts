// Help in other apps' Open and Save dialogs: keeps the backend told about the
// setting and the folder in front, and holds the "pick a file here" request.
import { createEffect, createRoot, createSignal } from "solid-js";
import { DIALOG_PICK_EVENT, dialogAssistCancel, dialogAssistFolder, dialogAssistSend, dialogAssistSet, errorText, type DialogPick } from "../lib/ipc";
import { settings } from "./settings";
import { ui } from "./ui";
import { workspace } from "./workspace";

/** The folder a dialog can be sent to: a real folder only, not an archive or a shell place. */
export function sendableFolder(tab: { path: () => string; archive: () => string | null } | undefined): string {
  const p = tab?.path() ?? "";
  return !p || tab?.archive() || /^shell:/i.test(p) || p.startsWith("::") ? "" : p;
}

export const dialogAssist = createRoot(() => {
  const [pick, setPick] = createSignal<DialogPick | null>(null);
  let started = false;

  const finish = async (files: readonly string[], folder: string) => {
    setPick(null);
    try {
      await dialogAssistSend(files, folder);
    } catch (e) {
      ui.toast(`Couldn't send that to the dialog: ${errorText(e)}`);
    }
  };

  return {
    /** The dialog waiting for a pick, if any. */
    pick,
    /** Call once at startup. */
    start() {
      if (started) return;
      started = true;
      createEffect(() => void dialogAssistSet(settings.dialogAssist(), settings.dialogAssistExclude()).catch(() => undefined));
      createEffect(() => {
        if (settings.dialogAssist()) void dialogAssistFolder(sendableFolder(workspace.activeTab())).catch(() => undefined);
      });
      // Turning the setting off ends a pick in progress.
      createEffect(() => {
        if (!settings.dialogAssist() && pick()) setPick(null);
      });
      void import("@tauri-apps/api/event").then(({ listen }) => listen<DialogPick>(DIALOG_PICK_EVENT, (e) => setPick(e.payload))).catch(() => undefined);
    },
    /** Opens the selected files in the waiting dialog. */
    useSelection: () => finish(workspace.activeTab()?.selectedPaths() ?? [], ""),
    /** Sends the waiting dialog to the folder in front. */
    useFolder: () => finish([], sendableFolder(workspace.activeTab())),
    cancel() {
      setPick(null);
      void dialogAssistCancel().catch(() => undefined);
    },
  };
});
