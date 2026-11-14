import { createSignal, For, onMount, Show } from "solid-js";
import { BUILT_IN_THEMES, DENSITIES, THEME_FAMILIES, type Density, type Theme } from "../../lib/themes";
import { copyTheme, readThemeFile } from "../../lib/themeFile";
import { fullTokens, parseThemes, themeChoices, themeVars, uniqueThemeName } from "../../lib/themeTools";
import { ICON_WEIGHT_MAX, ICON_WEIGHT_MIN, ROW_MAX, ROW_MIN, type IconStyle, type MotionPref, settings, type WindowControlsSide, type WindowControlsStyle } from "../../state/settings";
import { MaterialIcon } from "../Icons";
import { errorText, openFontsFolder, type WindowCorners } from "../../lib/ipc";
import { formatSize } from "../../lib/format";
import { fontState, GOOGLE_FONTS, isGoogleFont, loadGoogleFont, refreshSaved, removeGoogleFont, saveGoogleFont, savedFonts } from "../../lib/fonts";
import { sidebar } from "../../state/sidebar";
import { ui } from "../../state/ui";
import { Section, Segmented, Select, SettingRow, Slider, Toggle, type Option } from "./controls";

const MOTION: readonly Option<MotionPref>[] = [
  { value: "system", label: "Follow Windows" },
  { value: "reduce", label: "Reduced" },
  { value: "full", label: "Full" },
];

const ICON_STYLES: readonly Option<IconStyle>[] = [
  { value: "outlined", label: "Outlined" },
  { value: "rounded", label: "Rounded" },
  { value: "sharp", label: "Sharp" },
];

const ICON_PRESETS: readonly { label: string; values: { iconStyle: IconStyle; iconWeight: number; iconFill: boolean; iconScale: number } }[] = [
  { label: "Thin outlines", values: { iconStyle: "outlined", iconWeight: 100, iconFill: false, iconScale: 100 } },
  { label: "Default", values: { iconStyle: "outlined", iconWeight: 200, iconFill: false, iconScale: 100 } },
  { label: "Soft", values: { iconStyle: "rounded", iconWeight: 300, iconFill: false, iconScale: 110 } },
  { label: "Bold solid", values: { iconStyle: "rounded", iconWeight: 500, iconFill: true, iconScale: 110 } },
  { label: "Crisp", values: { iconStyle: "sharp", iconWeight: 400, iconFill: false, iconScale: 100 } },
];

const FONTS: readonly Option<string>[] = [
  { value: "", label: "Default (Segoe UI Variable)" },
  ...["Segoe UI", "Arial", "Calibri", "Verdana", "Tahoma", "Trebuchet MS", "Cambria", "Georgia", "Consolas"].map((f) => ({ value: f, label: f })),
];

const SCALE_PRESETS: readonly Option<number>[] = [85, 100, 115, 130].map((v) => ({ value: v, label: `${v}%` }));

const WINDOW_CORNER_OPTIONS: readonly Option<WindowCorners>[] = [
  { value: "system", label: "Default" },
  { value: "square", label: "Square" },
  { value: "small", label: "Small" },
  { value: "rounded", label: "Rounded" },
];

export function AppearanceTab() {
  const [json, setJson] = createSignal("");
  const themes = () => [...BUILT_IN_THEMES, ...settings.customThemes()];
  const themeOptions = (): Option<string>[] => themeChoices(settings.customThemes(), { system: true });
  /** Windows' light or dark mode: "Default" (the built-in look) plus every theme of that style. */
  const systemOptions = (scheme: "light" | "dark"): Option<string>[] => [{ value: "", label: "Default" }, ...themeChoices(settings.customThemes(), { scheme })];
  const densities = (): Option<Density>[] => (Object.keys(DENSITIES) as Density[]).map((d) => ({ value: d, label: d[0].toUpperCase() + d.slice(1) }));

  // Google fonts: the list gains the curated families, and the chosen one shows its download state.
  const fontOptions = (): Option<string>[] => [...FONTS, ...(settings.googleFonts() ? [...GOOGLE_FONTS].sort().map((f) => ({ value: f, label: `${f} · Google` })) : [])];
  const current = () => fontState(settings.uiFont());
  const [working, setWorking] = createSignal(false);
  const busy = () => working() || current().kind === "loading";
  const run = async (fn: () => Promise<void>) => {
    setWorking(true);
    try {
      await fn();
    } catch (e) {
      ui.toast(errorText(e));
    } finally {
      setWorking(false);
    }
  };
  const fontStatus = () => {
    const s = current();
    if (s.kind === "loading") return "Downloading from Google Fonts…";
    if (s.kind === "ready") return s.saved ? `Saved on this PC (${formatSize(s.bytes)}). It loads offline` : `Downloaded this session (${formatSize(s.bytes)}). It downloads again at each start unless you save it`;
    if (s.kind === "error") return `Couldn't load it: ${s.message}`;
    return "Not downloaded yet";
  };
  onMount(() => void refreshSaved());

  /** The preset the row height matches, or none (so no button is lit) when the slider is between presets. */
  const presetNow = (): Density => ((Object.keys(DENSITIES) as Density[]).find((d) => DENSITIES[d] === settings.rowPx()) ?? "custom") as Density;

  /** Adds imported themes under names not already used, and applies the first. */
  const addImported = (text: string) => {
    try {
      const taken: string[] = themes().map((t) => t.name);
      const added = parseThemes(text).map((t) => {
        const name = uniqueThemeName(t.name, taken);
        taken.push(name);
        return { ...t, name };
      });
      settings.setCustomThemes([...settings.customThemes(), ...added]);
      settings.setTheme(added[0].name);
      setJson("");
      ui.toast(added.length === 1 ? `Theme "${added[0].name}" added and applied` : `${added.length} themes added`);
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    }
  };
  const importTheme = () => addImported(json());
  const importFile = async (e: Event & { currentTarget: HTMLInputElement }) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (!file) return;
    try {
      addImported(await readThemeFile(file));
    } catch (err) {
      ui.toast(errorText(err));
    }
  };
  const duplicate = (t: Theme) => settings.setCustomThemes([...settings.customThemes(), { ...t, name: uniqueThemeName(`${t.name} copy`, themes().map((x) => x.name)) }]);
  const removeTheme = (t: Theme) =>
    ui.ask({
      title: `Delete "${t.name}"?`,
      body: "The theme is removed from this PC. Copy its JSON first if you may want it back.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => {
        settings.setCustomThemes(settings.customThemes().filter((x) => x !== t));
        if (settings.theme() === t.name) settings.setTheme("Midnight");
      },
    });

  const defaultAccent = () => {
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const chosen = settings.theme() === "System" ? (isDark ? settings.systemDark() : settings.systemLight()) : settings.theme();
    const theme = [...BUILT_IN_THEMES, ...settings.customThemes()].find((t) => t.name === chosen);
    if (theme?.tokens.accent) return theme.tokens.accent;
    return isDark ? "#6d8cff" : "#3d63f0";
  };

  return (
    <>
      <Section title="Theme">
        <SettingRow label="Theme" hint="Colors for the whole app">
          <Select label="Theme" value={settings.theme()} options={themeOptions()} onChange={settings.setTheme} />
        </SettingRow>
        <Show when={settings.theme() === "System"}>
          <SettingRow label="Windows light mode" hint="The theme to use when Windows is in light mode">
            <Select label="Theme for light mode" value={settings.systemLight()} options={systemOptions("light")} onChange={(systemLight) => settings.set({ systemLight })} />
          </SettingRow>
          <SettingRow label="Windows dark mode" hint="The theme to use when Windows is in dark mode">
            <Select label="Theme for dark mode" value={settings.systemDark()} options={systemOptions("dark")} onChange={(systemDark) => settings.set({ systemDark })} />
          </SettingRow>
        </Show>
        <SettingRow label="Accent color" hint="Selection, focus and highlights">
          <span class="inline">
            <input type="color" class="color" aria-label="Accent color" value={settings.accent() ?? defaultAccent()} onInput={(e) => settings.setAccent(e.currentTarget.value)} />
            <button class="btn small" disabled={settings.accent() === null} onClick={() => settings.setAccent(null)}>
              Theme default
            </button>
          </span>
        </SettingRow>
        <SettingRow label="Your themes" hint="Make your own, or bring one in" stacked>
          <Show when={settings.customThemes().length > 0} fallback={<p class="muted small te-empty">No custom themes yet.</p>}>
            <div class="theme-list">
              <For each={settings.customThemes()}>
                {(t) => (
                  <div class="theme-item" classList={{ on: settings.theme() === t.name }}>
                    <span class="theme-swatch" aria-hidden="true">
                      <For each={["bg", "surface", "text", "accent", "danger"] as const}>{(k) => <i style={{ background: fullTokens(t)[k] }} />}</For>
                    </span>
                    <button class="theme-item-name" title="Use this theme" onClick={() => settings.setTheme(t.name)}>
                      <span>{t.name}</span>
                      <span class="muted small">{settings.theme() === t.name ? "In use · " : ""}{t.scheme === "light" ? "Light" : "Dark"}</span>
                    </button>
                    <button class="btn small icon-btn" title="Edit" aria-label={`Edit ${t.name}`} onClick={() => ui.setThemeEditor(t.name)}><MaterialIcon name="edit" size={16} /></button>
                    <button class="btn small icon-btn" title="Duplicate" aria-label={`Duplicate ${t.name}`} onClick={() => duplicate(t)}><MaterialIcon name="content_copy" size={16} /></button>
                    <button class="btn small icon-btn" title="Copy as JSON" aria-label={`Copy ${t.name} as JSON`} onClick={() => void copyTheme(t).then(() => ui.toast("Theme copied as JSON"), (e) => ui.toast(errorText(e)))}><MaterialIcon name="data_object" size={16} /></button>
                    <button class="btn small icon-btn" title="Delete" aria-label={`Delete ${t.name}`} onClick={() => removeTheme(t)}><MaterialIcon name="delete" size={16} /></button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <div class="srow-actions">
            <button class="btn small primary" onClick={() => ui.setThemeEditor("")}><MaterialIcon name="palette" size={15} /> New theme…</button>
            <label class="btn small">
              <MaterialIcon name="upload_file" size={15} /> Import file…
              <input type="file" accept=".json,application/json" hidden onChange={(e) => void importFile(e)} />
            </label>
          </div>
        </SettingRow>
        <SettingRow label="Import from text" hint='Paste JSON with "name", "scheme" and "tokens" (a list of themes works too)' stacked>
          <textarea class="text-input mono" rows="3" spellcheck={false} placeholder="Theme JSON" value={json()} onInput={(e) => setJson(e.currentTarget.value)} />
          <div class="srow-actions">
            <button class="btn small" disabled={!json().trim()} onClick={importTheme}>
              Import theme
            </button>
          </div>
        </SettingRow>
      </Section>

      <Section title="Theme gallery">
        <div class="tg">
          <For each={THEME_FAMILIES}>
            {(family) => (
              <section class="tg-family">
                <h3>
                  {family.title} <span class="muted small">{family.hint}</span>
                </h3>
                <div class="tg-grid">
                  <For each={BUILT_IN_THEMES.filter((t) => t.family === family.id)}>
                    {(t) => (
                      <div class="tg-card" classList={{ on: settings.theme() === t.name }} style={themeVars(t)}>
                        <button class="tg-pick" aria-label={`Use ${t.name}`} aria-pressed={settings.theme() === t.name} onClick={() => settings.setTheme(t.name)}>
                          <span class="tg-prev" aria-hidden="true">
                            <span class="tg-side"><i /><i /><i /></span>
                            <span class="tg-rows">
                              <b class="tg-sel" />
                              <b />
                              <b class="tg-short" />
                              <span class="tg-chips"><i class="tg-accent" /><i class="tg-folder" /><i class="tg-danger" /><i class="tg-ok" /></span>
                            </span>
                          </span>
                          <span class="tg-name">{t.name}</span>
                        </button>
                        <button class="btn small icon-btn tg-copy" title="Customize a copy" aria-label={`Customize a copy of ${t.name}`} onClick={() => ui.setThemeEditor(`from:${t.name}`)}>
                          <MaterialIcon name="edit" size={14} />
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </section>
            )}
          </For>
        </div>
      </Section>

      <Section title="Size and density">
        <SettingRow label="Text size" hint="Scales the whole interface">
          <div class="slider-stack">
            <Slider label="Text size" min={85} max={130} step={5} value={settings.uiScale()} format={(v) => `${v}%`} onChange={settings.setUiScale} />
            <Segmented label="Text size presets" btnClass="seg-preset num" value={settings.uiScale()} options={SCALE_PRESETS} onChange={settings.setUiScale} />
          </div>
        </SettingRow>
        <SettingRow label="Interface font" hint="Used for names, menus and settings. Fonts that aren't installed fall back to the default">
          <Select label="Interface font" value={settings.uiFont()} options={fontOptions()} onChange={(uiFont) => settings.set({ uiFont })} />
        </SettingRow>
        <SettingRow label="Use Google Fonts" hint="Adds Google Fonts to the list. A font is downloaded from Google when you choose it, which tells Google your IP address. Nothing else is sent. Save a font on this PC to use it offline">
          <Toggle label="Use Google Fonts" checked={settings.googleFonts()} onChange={(googleFonts) => settings.set(googleFonts || !isGoogleFont(settings.uiFont()) ? { googleFonts } : { googleFonts, uiFont: "" })} />
        </SettingRow>
        <Show when={settings.googleFonts() && isGoogleFont(settings.uiFont())}>
          <SettingRow label={settings.uiFont()} hint={fontStatus()}>
            <span class="inline">
              <Show when={current().kind === "ready" && !(current() as { saved: boolean }).saved}>
                <button class="btn" disabled={busy()} onClick={() => void run(() => saveGoogleFont(settings.uiFont()))}>Save on this PC</button>
              </Show>
              <Show when={current().kind === "ready" && (current() as { saved: boolean }).saved}>
                <button class="btn" disabled={busy()} onClick={() => void run(() => removeGoogleFont(settings.uiFont()))}>Remove from this PC</button>
              </Show>
              <Show when={current().kind === "error" || current().kind === "idle"}>
                <button class="btn" disabled={busy()} onClick={() => void loadGoogleFont(settings.uiFont(), true)}>Download</button>
              </Show>
            </span>
          </SettingRow>
        </Show>
        <Show when={settings.googleFonts() && savedFonts().length > 0}>
          <SettingRow label="Fonts saved on this PC" hint="Kept in Octopolis's data folder. Uninstalling removes them with the app's data, and the uninstaller asks if you'd rather keep or remove them" stacked>
            <div class="saved-fonts">
              <For each={savedFonts()}>
                {(f) => (
                  <div class="saved-font">
                    <span class="saved-font-name" style={{ "font-family": `"${f.family}", var(--font)` }}>{f.family}</span>
                    <span class="muted small">{formatSize(f.bytes)}</span>
                    <button class="btn small" disabled={busy()} onClick={() => void run(() => removeGoogleFont(f.family))}>Remove</button>
                  </div>
                )}
              </For>
              <div class="srow-actions">
                <button class="btn small" onClick={() => void openFontsFolder().catch((e) => ui.toast(errorText(e)))}>Open fonts folder</button>
              </div>
            </div>
          </SettingRow>
        </Show>
        <SettingRow label="Density" hint="How tightly rows, sidebar, tabs and toolbars are packed">
          <div class="slider-stack">
            <Slider label="Row height" min={ROW_MIN} max={ROW_MAX} step={1} value={settings.rowPx()} format={(v) => `${v} px`} onChange={(densityRow) => settings.set({ densityRow })} />
            <Segmented label="Density" value={presetNow()} options={densities()} onChange={settings.setDensity} />
          </div>
        </SettingRow>
        <SettingRow label="Window corners" hint="Corner roundedness of the main application window">
          <Segmented<WindowCorners> label="Window corners" value={settings.windowCorners()} options={WINDOW_CORNER_OPTIONS} onChange={(windowCorners) => settings.set({ windowCorners })} />
        </SettingRow>
        <SettingRow label="Window buttons" hint="Switch between macOS traffic lights and Windows titlebar buttons">
          <Segmented<WindowControlsStyle>
            label="Window buttons"
            value={settings.windowControls()}
            options={[
              { value: "macos", label: "macOS" },
              { value: "windows", label: "Windows" },
            ]}
            onChange={(windowControls) => settings.set({ windowControls })}
          />
        </SettingRow>
        <Show when={settings.windowControls() === "macos"}>
          <SettingRow label="Traffic light position" hint="Place the macOS buttons on the left or right of the titlebar">
            <Segmented<WindowControlsSide>
              label="Traffic light position"
              value={settings.windowControlsSide()}
              options={[
                { value: "left", label: "Left" },
                { value: "right", label: "Right" },
              ]}
              onChange={(windowControlsSide) => settings.set({ windowControlsSide })}
            />
          </SettingRow>
        </Show>
      </Section>

      <Section title="Icons" note="Applies to button and menu icons. File, folder and drive icons keep their own colors.">
        <SettingRow label="Style" hint="Outlined has straight corners with open shapes, Rounded softens every end, Sharp uses square corners">
          <Segmented label="Icon style" value={settings.iconStyle()} options={ICON_STYLES} onChange={(iconStyle) => settings.set({ iconStyle })} />
        </SettingRow>
        <SettingRow label="Weight" hint="Line thickness, from hairline (100) to bold (700)">
          <Slider label="Icon weight" min={ICON_WEIGHT_MIN} max={ICON_WEIGHT_MAX} step={100} value={settings.iconWeight()} onChange={(iconWeight) => settings.set({ iconWeight })} />
        </SettingRow>
        <SettingRow label="Size" hint="Scales every button and menu icon">
          <Slider label="Icon size" min={80} max={140} step={10} value={settings.iconScale()} format={(v) => `${v}%`} onChange={(iconScale) => settings.set({ iconScale })} />
        </SettingRow>
        <SettingRow label="Presets" hint="One click to a complete look">
          <span class="inline">
            <For each={ICON_PRESETS}>
              {(p) => (
                <button class="btn small" onClick={() => settings.set(p.values)}>
                  {p.label}
                </button>
              )}
            </For>
          </span>
        </SettingRow>
        <SettingRow label="Filled icons" hint="Solid shapes instead of outlines, where an icon has a filled form">
          <Toggle label="Filled icons" checked={settings.iconFill()} onChange={(iconFill) => settings.set({ iconFill })} />
        </SettingRow>
        <SettingRow label="Preview" hint="How the current choices look">
          <span class="icon-preview" aria-hidden="true">
            <For each={["home", "search", "settings", "delete", "mop", "star", "push_pin", "cloud"]}>{(n) => <MaterialIcon name={n} size={22} />}</For>
          </span>
        </SettingRow>
        <SettingRow label="Reset icons" hint="Back to Outlined, weight 200, size 100%, not filled">
          <button class="btn" onClick={() => settings.set({ iconStyle: "outlined", iconWeight: 200, iconFill: false, iconScale: 100 })}>Reset</button>
        </SettingRow>
      </Section>

      <Section title="Motion and help">
        <SettingRow label="Animations" hint="Reduced keeps quick color changes and drops movement">
          <Segmented label="Animations" value={settings.motion()} options={MOTION} onChange={(motion) => settings.set({ motion })} />
        </SettingRow>
        <SettingRow label="Tooltips" hint="Small labels when you hover or focus a button">
          <Toggle label="Tooltips" checked={settings.tooltips()} onChange={(tooltips) => settings.set({ tooltips })} />
        </SettingRow>
        <Show when={settings.tooltips()}>
          <SettingRow label="Tooltip delay" hint="How long to hover or focus before a tooltip appears">
            <Slider
              label="Tooltip delay"
              min={0}
              max={5000}
              step={100}
              value={settings.tooltipDelayMs()}
              format={(v) => (v === 0 ? "Instant" : `${(v / 1000).toFixed(1)} s`)}
              onChange={(tooltipDelayMs) => settings.set({ tooltipDelayMs })}
            />
          </SettingRow>
        </Show>
        <SettingRow label="Shortcut hints in the status bar" hint="Show context-aware keyboard shortcuts at the bottom">
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

      <Section title="Bento layout">
        <SettingRow label="Hide file names" hint="Show only pictures in Bento view without file name labels at the bottom">
          <Toggle label="Hide file names" checked={settings.bentoHideNames()} onChange={(bentoHideNames) => settings.set({ bentoHideNames })} />
        </SettingRow>
        <SettingRow label="Show tags" hint="Show media format badges (such as JPG, PNG, MP4) on the top right of Bento cards">
          <Toggle label="Show tags" checked={settings.bentoShowTags()} onChange={(bentoShowTags) => settings.set({ bentoShowTags })} />
        </SettingRow>
      </Section>
    </>
  );
}
