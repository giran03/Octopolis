import { keybindings } from "../../state/keybindings";
import { settings } from "../../state/settings";
import { ShortcutsPanel } from "../Shortcuts";
import { ActionButton, Section, SettingRow, Toggle } from "./controls";

export function ShortcutsTab() {
  return (
    <>
      <Section title="Keys">
        <SettingRow label="Vim keys" hint="h j k l movement, v for visual selection, and more, on top of the normal shortcuts">
          <Toggle label="Vim keys" checked={settings.vimMode()} onChange={(vimMode) => settings.set({ vimMode })} />
        </SettingRow>
        <SettingRow label="Restore default shortcuts" hint={keybindings.customCount() === 0 ? "You haven't changed any shortcuts" : `${keybindings.customCount()} shortcut${keybindings.customCount() === 1 ? " is" : "s are"} customized`}>
          <ActionButton label="Restore all" confirm="Press again to restore" disabled={keybindings.customCount() === 0} onClick={keybindings.resetAll} />
        </SettingRow>
      </Section>
      <section class="sset">
        <h3 class="sset-title">Shortcuts</h3>
        <p class="sset-note">Pick Change on a command, then press the keys. Chords like Ctrl+K Ctrl+S work too.</p>
        <ShortcutsPanel />
      </section>
    </>
  );
}
