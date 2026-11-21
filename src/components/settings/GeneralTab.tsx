import { createResource, createSignal, For, Show } from "solid-js";
import { explorerChangeText, explorerHint, explorerProblems, otherCopy, PROBLEMS_TITLE, staleTarget, useThisCopyQuestion, WIN_E_SWITCH } from "../../lib/explorerMode";
import { detectEditors, errorText, explorerMenuSet, explorerModeRepair, explorerModeSet, explorerModeStatus, explorerUseThisCopy, type SummonKey } from "../../lib/ipc";
import { ui } from "../../state/ui";
import { type StartFolder, settings, type TerminalShell } from "../../state/settings";
import { Section, Segmented, Select, SettingRow, Toggle, type Option } from "./controls";
import { keybindings } from "../../state/keybindings";

const START: readonly Option<StartFolder>[] = [
  { value: "home", label: "Home" },
  { value: "last", label: "Where I left off" },
  { value: "custom", label: "A folder" },
];

const SUMMON: readonly Option<SummonKey>[] = [
  { value: "off", label: "Off" },
  { value: "ctrlE", label: "Ctrl+E on the desktop" },
  { value: "ctrlShiftAltE", label: "Ctrl+Shift+Alt+E anywhere" },
];

const SHELLS: readonly Option<TerminalShell>[] = [
  { value: "powershell", label: "PowerShell" },
  { value: "pwsh", label: "PowerShell 7" },
  { value: "cmd", label: "Command Prompt" },
];

const MB = 1_048_576;
const SPEEDS: readonly Option<number>[] = [
  { value: 0, label: "Unlimited" },
  ...[10, 50, 100, 500].map((mb) => ({ value: mb * MB, label: `${mb} MB/s` })),
];

const EXPLORER_MODE_NOTE =
  "This changes settings for your Windows account only, and needs no administrator rights. Turn it off here at any time, or uninstall Octopolis, to give folders back to File Explorer. If Octopolis can't open, run Octopolis.exe --restore-explorer, or follow RESTORE-FILE-EXPLORER.txt in %LOCALAPPDATA%\\app.octopolis.explorer. Settings another app already owns are left alone, and turning this off puts back what was there before. " +
  "Show in folder in other apps selects the file here when a tab already has that folder open; otherwise Windows opens File Explorer (Also catch File Explorer windows covers that). Open and Save dialogs in other apps stay the Windows ones (Help in Open and Save dialogs below adds shortcuts to them), and Control Panel, Network and similar places still open in File Explorer. Win+E may not be caught while a window running as administrator is in front.";

/** Explains the switch in a modal before it is turned on. */
const askExplorerMode = (onConfirm: () => void) =>
  ui.ask({ title: "Use Octopolis instead of File Explorer", body: EXPLORER_MODE_NOTE, confirmLabel: "Turn on", onConfirm });

/** "Use Octopolis instead of File Explorer", with an explanation before the first switch-on. */
function ExplorerModeSection() {
  const [status, { mutate }] = createResource(() => explorerModeStatus().catch(() => null));
  const [busy, setBusy] = createSignal(false);
  const on = () => !!status()?.on;
  const problems = () => {
    const s = status();
    return s ? explorerProblems(s) : [];
  };
  const apply = async (next: boolean) => {
    setBusy(true);
    try {
      const s = await explorerModeSet(next);
      mutate(s);
      ui.toast(explorerChangeText(next, s));
    } catch (e) {
      ui.toast(`Couldn't change this: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const repair = async (takeOver = false) => {
    setBusy(true);
    try {
      const s = await explorerModeRepair(takeOver);
      mutate(s);
      const left = explorerProblems(s);
      ui.toast(left.length ? `Set up again, but: ${left[0]}` : "Win+E and folders were set up again. Try Win+E now");
    } catch (e) {
      ui.toast(`Couldn't fix this: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  /** Repair. Entries that point at a missing Octopolis are only taken over once the user says yes. */
  const askRepair = () => {
    const s = status();
    const path = s ? staleTarget(s) : null;
    if (!path) return void repair();
    ui.ask({ title: "Repair", body: `Take over the entry that points at ${path}?`, confirmLabel: "Take over", onConfirm: () => void repair(true) });
  };
  /** "Use this copy instead" (WE-15): asks first, then points the entries at this copy. */
  const askUseThisCopy = () => {
    const s = status();
    if (!s || !otherCopy(s)) return;
    ui.ask({
      title: "Use this copy instead",
      body: useThisCopyQuestion(s),
      confirmLabel: "Use this copy",
      onConfirm: async () => {
        setBusy(true);
        try {
          mutate(await explorerUseThisCopy());
          ui.toast("Folders and Win+E now open this copy of Octopolis");
        } catch (e) {
          ui.toast(`Couldn't change this: ${errorText(e)}`);
        } finally {
          setBusy(false);
        }
      },
    });
  };
  const setMenu = async (next: boolean) => {
    setBusy(true);
    try {
      mutate(await explorerMenuSet(next));
      ui.toast(next ? "Right-click a folder in File Explorer to open it here" : "Removed from File Explorer's menu");
    } catch (e) {
      ui.toast(`Couldn't change this: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="File Explorer">
      <SettingRow label="Use Octopolis instead of File Explorer" hint={explorerHint(status())}>
        <Show when={otherCopy(status())}>
          <button class="btn small" disabled={busy()} onClick={askUseThisCopy}>
            Use this copy instead
          </button>
        </Show>
        <Toggle label="Use Octopolis instead of File Explorer" checked={on()} disabled={busy() || status.loading} onChange={(next) => (next ? askExplorerMode(() => void apply(true)) : void apply(false))} />
      </SettingRow>
      {/* One row for every problem, with one Repair button (WE-14). */}
      <Show when={problems().length > 0}>
        <div class="srow">
          <div class="srow-text">
            <div class="srow-label">{PROBLEMS_TITLE}</div>
            <For each={problems()}>{(line) => <div class="srow-hint">{line}</div>}</For>
          </div>
          <div class="srow-control">
            <button class="btn small" disabled={busy()} onClick={askRepair}>
              Repair
            </button>
          </div>
        </div>
      </Show>
      <Show when={on()}>
        <SettingRow label={WIN_E_SWITCH.label} hint={WIN_E_SWITCH.hint}>
          <Toggle label={WIN_E_SWITCH.label} checked={settings.catchWinE()} onChange={(catchWinE) => settings.set({ catchWinE })} />
        </SettingRow>
        <SettingRow
          label="Also catch File Explorer windows other apps open"
          hint="Show in folder for a folder that isn't open here, and apps that start File Explorer themselves, still open a File Explorer window. With this on, Octopolis closes that window and opens the folder here; the window may flash briefly. Control Panel, This PC and similar places stay in File Explorer"
        >
          <Toggle label="Also catch File Explorer windows other apps open" checked={settings.catchExplorer()} onChange={(catchExplorer) => settings.set({ catchExplorer })} />
        </SettingRow>
      </Show>
      <Show when={!on()}>
        <SettingRow label="Add Open in Octopolis to File Explorer" hint="Keeps File Explorer as the default and adds an entry to its folder right-click menu. You can also run octopolis with a folder path">
          <Toggle label="Add Open in Octopolis to File Explorer" checked={!!status()?.menu} disabled={busy() || status.loading} onChange={(next) => void setMenu(next)} />
        </SettingRow>
      </Show>
      <SettingRow
        label="Help in Open and Save dialogs"
        hint="While another app's Open or Save dialog is in front: Ctrl+G sends it to the folder Octopolis is showing, and Ctrl+Shift+G lets you pick the file here. The Windows dialog stays; Octopolis has to be running"
      >
        <Toggle label="Help in Open and Save dialogs" checked={settings.dialogAssist()} onChange={(dialogAssist) => settings.set({ dialogAssist })} />
      </SettingRow>
      <Show when={settings.dialogAssist()}>
        <SettingRow label="Leave these apps alone" hint="Program names separated by commas, for example game.exe, launcher.exe. Their dialogs keep Ctrl+G for themselves. Apps running as administrator are always left alone">
          <input
            class="text-input wide"
            spellcheck={false}
            placeholder="game.exe, launcher.exe"
            aria-label="Leave these apps alone"
            value={settings.dialogAssistExclude()}
            onChange={(e) => settings.set({ dialogAssistExclude: e.currentTarget.value.trim() })}
          />
        </SettingRow>
      </Show>
      <SettingRow label="Shortcut to bring Octopolis forward" hint="Ctrl+E only works while the desktop or taskbar is in front, so other apps keep their own Ctrl+E. Ctrl+Shift+Alt+E works anywhere and hides Octopolis again">
        <Select label="Shortcut to bring Octopolis forward" value={settings.summonKey()} options={SUMMON} onChange={(summonKey) => settings.set({ summonKey })} />
      </SettingRow>
    </Section>
  );
}

const EDITOR_DEFAULT = "";
const EDITOR_CUSTOM = "\u0000custom";

/** Editor preference: each file type's editor, an installed editor found on this PC, or any program. */
function EditorRows() {
  const [found] = createResource(() => detectEditors().catch(() => []));
  const [custom, setCustom] = createSignal(false);
  const path = () => settings.editorPath();
  const isDetected = () => (found() ?? []).some((e) => e.path.toLowerCase() === path().toLowerCase());
  const showCustom = () => custom() || (!!path() && !isDetected() && !found.loading);
  const options = (): Option<string>[] => [
    { value: EDITOR_DEFAULT, label: "Each file type's editor" },
    ...(found() ?? []).map((e) => ({ value: e.path, label: e.name })),
    { value: EDITOR_CUSTOM, label: "Custom program…" },
  ];
  const selected = () => (showCustom() ? EDITOR_CUSTOM : path());
  const choose = (value: string) => {
    if (value === EDITOR_CUSTOM) {
      setCustom(true);
      return;
    }
    setCustom(false);
    settings.set({ editorPath: value });
  };
  return (
    <>
      <SettingRow label="Editor" hint={`Program used by Open in editor${keybindings.keyParen("file.edit")} and the Open in editor buttons. Installed editors are detected automatically`}>
        <Select label="Editor" value={selected()} options={options()} onChange={choose} />
      </SettingRow>
      <Show when={path()}>
        <SettingRow label="Double-click on text and code files" hint="What opens .txt, .md, .json, source code and similar files. Other files always use their Windows default app">
          <Select
            label="Double-click on text and code files"
            value={settings.editorOpensText() ? "editor" : "windows"}
            options={[
              { value: "windows", label: "Windows default" },
              { value: "editor", label: "The editor above" },
            ]}
            onChange={(v) => settings.set({ editorOpensText: v === "editor" })}
          />
        </SettingRow>
      </Show>
      <Show when={showCustom()}>
        <SettingRow label="Editor program" hint="Full path to the program, for example C:\Program Files\Microsoft VS Code\Code.exe" stacked>
          <input class="text-input wide" spellcheck={false} placeholder="Path to an .exe" value={path()} onChange={(e) => settings.set({ editorPath: e.currentTarget.value.trim().replace(/^"|"$/g, "") })} />
        </SettingRow>
      </Show>
    </>
  );
}

export function GeneralTab() {
  return (
    <>
      <Section title="Startup">
        <SettingRow label="Open Octopolis in" hint="Where I left off brings back every pane and tab from last time">
          <Segmented label="Start folder" value={settings.startFolder()} options={START} onChange={(startFolder) => settings.set({ startFolder })} />
        </SettingRow>
        <Show when={settings.startFolder() === "custom"}>
          <SettingRow label="Start folder" hint="Full path, for example a projects or downloads folder" stacked>
            <input class="text-input wide" spellcheck={false} placeholder="Folder path" value={settings.startPath()} onChange={(e) => settings.set({ startPath: e.currentTarget.value.trim() })} />
          </SettingRow>
        </Show>
        <SettingRow label="Keep running in the notification area" hint={`Closing the window hides Octopolis next to the clock so it opens again instantly. Quit from its icon there${keybindings.keyOf("app.quit") ? `, or with ${keybindings.keyOf("app.quit")}` : ""}`}>
          <Toggle label="Keep running in the notification area" checked={settings.keepInTray()} onChange={(keepInTray) => settings.set({ keepInTray })} />
        </SettingRow>
      </Section>

      <ExplorerModeSection />

      <Section title="Files and folders">
        <SettingRow label="Show hidden files" hint={`Items marked hidden or system.${keybindings.keyOf("view.hidden") ? ` Also ${keybindings.keyOf("view.hidden")}` : ""}`}>
          <Toggle label="Show hidden files" checked={settings.showHidden()} onChange={(showHidden) => settings.set({ showHidden })} />
        </SettingRow>
        <SettingRow label="Show file extensions" hint="Off hides the last extension (.txt, .png) in names. Renaming still shows the full name">
          <Toggle label="Show file extensions" checked={settings.showExtensions()} onChange={(showExtensions) => settings.set({ showExtensions })} />
        </SettingRow>
        <SettingRow label="Pick each folder's view automatically" hint="Opens folders of pictures as a bento, music as rows, and so on. A folder you give a view by hand keeps it">
          <Toggle label="Pick each folder's view automatically" checked={settings.autoView()} onChange={(autoView) => settings.set({ autoView })} />
        </SettingRow>
        <SettingRow label="Calculate folder sizes automatically" hint="Fills in the Size column for folders as soon as you open one. Slower on big drives">
          <Toggle label="Calculate folder sizes automatically" checked={settings.autoFolderSizes()} onChange={(autoFolderSizes) => settings.set({ autoFolderSizes })} />
        </SettingRow>
        <SettingRow label="Windows file icons" hint="Octopolis draws its own icons for the file types it supports. This uses the icon Windows shows for folders and everything else">
          <Toggle label="Windows file icons" checked={settings.shellIcons()} onChange={(shellIcons) => settings.set({ shellIcons })} />
        </SettingRow>
        <SettingRow label="Image thumbnails" hint="Show previews instead of icons in grid view">
          <Toggle label="Image thumbnails" checked={settings.showThumbnails()} onChange={(showThumbnails) => settings.set({ showThumbnails })} />
        </SettingRow>
        <SettingRow label="Confirm before deleting" hint="Ask before moving items to the Recycle Bin. Permanent deletes always ask">
          <Toggle label="Confirm before deleting" checked={settings.confirmRecycle()} onChange={(confirmRecycle) => settings.set({ confirmRecycle })} />
        </SettingRow>
      </Section>

      <Section title="Copying and moving">
        <SettingRow label="Confirm before moving folders" hint="Ask first when a folder is moved into another folder, by dragging, Cut and Paste or Move to…">
          <Toggle label="Confirm before moving folders" checked={settings.confirmMoveFolders()} onChange={(confirmMoveFolders) => settings.set({ confirmMoveFolders })} />
        </SettingRow>
        <SettingRow label="Verify copies with checksums" hint="Reads each copy back to make sure it matches. Slower, safer">
          <Toggle label="Verify copies with checksums" checked={settings.verifyCopies()} onChange={(verifyCopies) => settings.set({ verifyCopies })} />
        </SettingRow>
        <SettingRow label="Transfer speed limit" hint="Keeps big copies from saturating a disk or network">
          <Select label="Transfer speed limit" value={settings.speedLimit() ?? 0} options={SPEEDS} onChange={(v) => settings.set({ speedLimit: v === 0 ? null : v })} />
        </SettingRow>
        <SettingRow label="Notify when transfers finish" hint="A Windows notification when a copy or move that took over 10 seconds ends while Octopolis is in the background">
          <Toggle label="Notify when transfers finish" checked={settings.notifyDone()} onChange={(notifyDone) => settings.set({ notifyDone })} />
        </SettingRow>
        <SettingRow label="Keep the PC awake during transfers" hint="Windows won't go to sleep while files are being copied or moved. The screen can still turn off">
          <Toggle label="Keep the PC awake during transfers" checked={settings.keepAwake()} onChange={(keepAwake) => settings.set({ keepAwake })} />
        </SettingRow>
      </Section>

      <Section title="Terminal, editor and Git">
        <SettingRow label="Shell" hint="Used by the built-in terminal. Applies to terminals you open next">
          <Select label="Shell" value={settings.terminalShell()} options={SHELLS} onChange={(terminalShell) => settings.set({ terminalShell })} />
        </SettingRow>
        <SettingRow label="Follow the current folder" hint="The terminal changes directory when you browse">
          <Toggle label="Follow the current folder" checked={settings.terminalSync()} onChange={(terminalSync) => settings.set({ terminalSync })} />
        </SettingRow>
        <EditorRows />
        <SettingRow label="Hide files Git ignores" hint="In Git folders, leave out build output, dependencies and other ignored files">
          <Toggle label="Hide files Git ignores" checked={settings.hideGitIgnored()} onChange={(hideGitIgnored) => settings.set({ hideGitIgnored })} />
        </SettingRow>
        <SettingRow label="Show last commit" hint="Adds a column with each file's latest commit in Git folders">
          <Toggle label="Show last commit" checked={settings.showCommits()} onChange={(showCommits) => settings.set({ showCommits })} />
        </SettingRow>
      </Section>
    </>
  );
}
