import { createResource, createSignal, Show } from "solid-js";
import { detectEditors, errorText, explorerMenuSet, explorerModeSet, explorerModeStatus, type SummonKey } from "../../lib/ipc";
import { ui } from "../../state/ui";
import { type StartFolder, settings, type TerminalShell } from "../../state/settings";
import { Section, Segmented, Select, SettingRow, Toggle, type Option } from "./controls";

const START: readonly Option<StartFolder>[] = [
  { value: "home", label: "Home" },
  { value: "last", label: "Where I left off" },
  { value: "custom", label: "A folder" },
];

const SUMMON: readonly Option<SummonKey>[] = [
  { value: "off", label: "Off" },
  { value: "ctrlE", label: "Ctrl+E on the desktop" },
  { value: "ctrlAltE", label: "Ctrl+Alt+E anywhere" },
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

/** "Use Octopolis instead of File Explorer", with an explanation before the first switch-on. */
function ExplorerModeSection() {
  const [status, { mutate }] = createResource(() => explorerModeStatus().catch(() => null));
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const on = () => !!status() && (status()!.folders || status()!.winE);
  const apply = async (next: boolean) => {
    setConfirming(false);
    setBusy(true);
    try {
      mutate(await explorerModeSet(next));
      ui.toast(next ? "Folders and Win+E now open in Octopolis" : "Folders open in File Explorer again");
    } catch (e) {
      ui.toast(`Couldn't change this: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const hint = () => {
    const s = status();
    if (!s) return "Opens folders from the desktop, Start, the Run box and other apps, and Win+E, in Octopolis";
    if (on() && !s.thisCopy && s.target) return `Currently set to another copy of Octopolis: ${s.target}`;
    if (s.folders && !s.winE) return "Folders open here. Win+E is kept by another app";
    return "Opens folders from the desktop, Start, the Run box and other apps, and Win+E, in Octopolis";
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
      <SettingRow label="Use Octopolis instead of File Explorer" hint={hint()}>
        <Toggle label="Use Octopolis instead of File Explorer" checked={on()} disabled={busy() || status.loading} onChange={(next) => (next ? setConfirming(true) : void apply(false))} />
      </SettingRow>
      <Show when={!on()}>
        <SettingRow label="Add Open in Octopolis to File Explorer" hint="Keeps File Explorer as the default and adds an entry to its folder right-click menu. You can also run octopolis with a folder path">
          <Toggle label="Add Open in Octopolis to File Explorer" checked={!!status()?.menu} disabled={busy() || status.loading} onChange={(next) => void setMenu(next)} />
        </SettingRow>
      </Show>
      <SettingRow label="Shortcut to bring Octopolis forward" hint="Ctrl+E only works while the desktop or taskbar is in front, so other apps keep their own Ctrl+E. Ctrl+Alt+E works anywhere and hides Octopolis again">
        <Select label="Shortcut to bring Octopolis forward" value={settings.summonKey()} options={SUMMON} onChange={(summonKey) => settings.set({ summonKey })} />
      </SettingRow>
      <Show when={confirming()}>
        <div class="setting-note" role="alertdialog" aria-label="Use Octopolis instead of File Explorer">
          <p>
            This changes settings for your Windows account only, and needs no administrator rights. Turn it off here at any time, or uninstall Octopolis, to give folders back to File Explorer. If Octopolis can't open,
            run <code>Octopolis.exe --restore-explorer</code>.
          </p>
          <p class="muted small">Open and Save dialogs in other apps stay the Windows ones, and Control Panel, Network and similar places still open in File Explorer.</p>
          <div class="dialog-actions">
            <button class="btn" onClick={() => setConfirming(false)}>Cancel</button>
            <button class="btn primary" onClick={() => void apply(true)}>Turn on</button>
          </div>
        </div>
      </Show>
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
      <SettingRow label="Editor" hint="Program used by Open in editor (Ctrl+Shift+O) and the Open in editor buttons. Installed editors are detected automatically">
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
        <SettingRow label="Keep running in the notification area" hint="Closing the window hides Octopolis next to the clock so it opens again instantly. Quit from its icon there, or with Ctrl+Q">
          <Toggle label="Keep running in the notification area" checked={settings.keepInTray()} onChange={(keepInTray) => settings.set({ keepInTray })} />
        </SettingRow>
      </Section>

      <ExplorerModeSection />

      <Section title="Files and folders">
        <SettingRow label="Show hidden files" hint="Items marked hidden or system. Also Ctrl+H">
          <Toggle label="Show hidden files" checked={settings.showHidden()} onChange={(showHidden) => settings.set({ showHidden })} />
        </SettingRow>
        <SettingRow label="Show file extensions" hint="Off hides the last extension (.txt, .png) in names. Renaming still shows the full name">
          <Toggle label="Show file extensions" checked={settings.showExtensions()} onChange={(showExtensions) => settings.set({ showExtensions })} />
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
