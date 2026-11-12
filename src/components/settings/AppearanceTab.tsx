import { createSignal } from "solid-js";
import { BUILT_IN_THEMES, DENSITIES, parseTheme, type Density } from "../../lib/themes";
import { type MotionPref, settings } from "../../state/settings";
import { sidebar } from "../../state/sidebar";
import { ui } from "../../state/ui";
import { Section, Segmented, Select, SettingRow, Slider, Toggle, type Option } from "./controls";

const MOTION: readonly Option<MotionPref>[] = [
  { value: "system", label: "Follow Windows" },
  { value: "reduce", label: "Reduced" },
  { value: "full", label: "Full" },
];

const SCALE_PRESETS: readonly Option<number>[] = [85, 100, 115, 130].map((v) => ({ value: v, label: `${v}%` }));

export function AppearanceTab() {
  const [json, setJson] = createSignal("");
  const themes = () => [...BUILT_IN_THEMES, ...(settings.customTheme() ? [settings.customTheme()!] : [])];
  const themeOptions = (): Option<string>[] => [{ value: "System", label: "Follow Windows" }, ...themes().map((t) => ({ value: t.name, label: t.name }))];
  const densities = (): Option<Density>[] => (Object.keys(DENSITIES) as Density[]).map((d) => ({ value: d, label: d[0].toUpperCase() + d.slice(1) }));

  const importTheme = () => {
    try {
      const t = parseTheme(json());
      settings.setCustomTheme(t);
      settings.setTheme(t.name);
      setJson("");
      ui.toast(`Theme "${t.name}" applied`);
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <Section title="Theme">
        <SettingRow label="Theme" hint="Colors for the whole app">
          <Select label="Theme" value={settings.theme()} options={themeOptions()} onChange={settings.setTheme} />
        </SettingRow>
        <SettingRow label="Accent color" hint="Selection, focus and highlights">
          <span class="inline">
            <input type="color" class="color" aria-label="Accent color" value={settings.accent() ?? "#6d8cff"} onInput={(e) => settings.setAccent(e.currentTarget.value)} />
            <button class="btn small" disabled={settings.accent() === null} onClick={() => settings.setAccent(null)}>
              Theme default
            </button>
          </span>
        </SettingRow>
        <SettingRow label="Import a theme" hint='Paste JSON with "name", "scheme" and "tokens"' stacked>
          <textarea class="text-input mono" rows="3" spellcheck={false} placeholder="Theme JSON" value={json()} onInput={(e) => setJson(e.currentTarget.value)} />
          <div class="srow-actions">
            <button class="btn small" disabled={!json().trim()} onClick={importTheme}>
              Import theme
            </button>
          </div>
        </SettingRow>
      </Section>

      <Section title="Size and density">
        <SettingRow label="Text size" hint="Scales the whole interface">
          <div class="slider-stack">
            <Slider label="Text size" min={85} max={130} step={5} value={settings.uiScale()} format={(v) => `${v}%`} onChange={settings.setUiScale} />
            <Segmented label="Text size presets" btnClass="seg-preset num" value={settings.uiScale()} options={SCALE_PRESETS} onChange={settings.setUiScale} />
          </div>
        </SettingRow>
        <SettingRow label="Density" hint="How tightly rows, sidebar, tabs and toolbars are packed">
          <Segmented label="Density" value={settings.density()} options={densities()} onChange={settings.setDensity} />
        </SettingRow>
      </Section>

      <Section title="Motion and help">
        <SettingRow label="Animations" hint="Reduced keeps quick color changes and drops movement">
          <Segmented label="Animations" value={settings.motion()} options={MOTION} onChange={(motion) => settings.set({ motion })} />
        </SettingRow>
        <SettingRow label="Tooltips" hint="Small labels when you hover or focus a button">
          <Toggle label="Tooltips" checked={settings.tooltips()} onChange={(tooltips) => settings.set({ tooltips })} />
          <Toggle label="Shortcut hints in the status bar" checked={settings.showHints()} onChange={(showHints) => settings.set({ showHints })} />
        </SettingRow>
      </Section>

      <Section title="Sidebar and shelf">
        <SettingRow label="Show sidebar" hint="Also Ctrl+B">
          <Toggle label="Show sidebar" checked={settings.sidebarOpen()} onChange={(sidebarOpen) => settings.set({ sidebarOpen })} />
        </SettingRow>
        <SettingRow label="Pinned section" hint="Your bookmarked folders">
          <Toggle label="Pinned section" checked={settings.showPinned()} onChange={(showPinned) => settings.set({ showPinned })} />
        </SettingRow>
        <SettingRow label="Recent section" hint="Folders you opened lately">
          <Toggle label="Recent section" checked={settings.showRecent()} onChange={(showRecent) => settings.set({ showRecent })} />
        </SettingRow>
        <SettingRow label="Sidebar names only" hint="Hide parent paths on recent folders and drive space bars (always on in Compact density)">
          <Toggle label="Sidebar names only" checked={settings.sidebarNamesOnly()} onChange={(sidebarNamesOnly) => settings.set({ sidebarNamesOnly })} />
        </SettingRow>
        <SettingRow label="Sidebar width" hint="Drag the sidebar's edge to resize it">
          <button class="btn small" onClick={() => sidebar.setWidth(240)}>
            Reset width
          </button>
        </SettingRow>
        <SettingRow label="Open the shelf while dragging" hint="The shelf slides open when you start dragging files, so it is ready to catch them">
          <Toggle label="Open the shelf while dragging" checked={settings.shelfAutoOpen()} onChange={(shelfAutoOpen) => settings.set({ shelfAutoOpen })} />
        </SettingRow>
      </Section>
    </>
  );
}
