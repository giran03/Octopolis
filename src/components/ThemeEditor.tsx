// Create or edit a custom theme: pick every color, see a live mock-up, check readability, share the result.
import { createMemo, createSignal, For, Show } from "solid-js";
import { copyTheme, saveThemeFile } from "../lib/themeFile";
import { derivePalette, fullTokens, MIDNIGHT_TOKENS, randomPalette, themeSwatch, themeVars, themeWarnings, TOKEN_INFO, toHex, uniqueThemeName } from "../lib/themeTools";
import { BUILT_IN_THEMES, isColor, type Theme, type ThemeToken } from "../lib/themes";
import { errorText } from "../lib/ipc";
import { settings } from "../state/settings";
import { ui } from "../state/ui";
import { MaterialIcon } from "./Icons";
import { Select, type Option } from "./Select";
import { Segmented } from "./settings/controls";

type Tokens = Record<ThemeToken, string>;

export function ThemeEditor() {
  // "from:<name>" starts a new theme from an existing one; any other name edits that custom theme.
  const request = ui.themeEditor() ?? "";
  const seed = request.startsWith("from:") ? [...BUILT_IN_THEMES, ...settings.customThemes()].find((t) => t.name === request.slice(5)) : undefined;
  const editing = seed ? undefined : settings.customThemes().find((t) => t.name === request);
  const startFrom = editing ?? seed;
  const startTokens = (): Tokens => (startFrom ? fullTokens(startFrom) : { ...MIDNIGHT_TOKENS });
  const [name, setName] = createSignal(editing?.name ?? (seed ? `${seed.name} custom` : ""));
  const [scheme, setScheme] = createSignal<"dark" | "light">(startFrom?.scheme ?? "dark");
  const [tokens, setTokens] = createSignal<Tokens>(startTokens());
  // What each color was when this editor opened (or when a base was chosen): the target of the per-color reset.
  const [origin, setOrigin] = createSignal<Tokens>(startTokens());
  const [base, setBase] = createSignal("");

  const close = () => ui.setThemeEditor(null);
  const setToken = (t: ThemeToken, v: string) => setTokens({ ...tokens(), [t]: v });
  const warnings = createMemo(() => themeWarnings(tokens()));
  const others = () => settings.customThemes().filter((t) => t !== editing).map((t) => t.name);
  const taken = () => [...BUILT_IN_THEMES.map((t) => t.name), ...others()];
  const nameClash = () => !!name().trim() && taken().some((n) => n.toLowerCase() === name().trim().toLowerCase());

  const baseOptions = (): Option<string>[] => [
    { value: "", label: "Choose a theme…" },
    ...BUILT_IN_THEMES.map((t) => ({ value: `b:${t.name}`, label: t.name, swatch: themeSwatch(t), group: "Built-in" })),
    ...settings.customThemes().filter((t) => t !== editing).map((t) => ({ value: `c:${t.name}`, label: t.name, swatch: themeSwatch(t), group: "Your themes" })),
  ];
  const chooseBase = (v: string) => {
    setBase(v);
    const t = v.startsWith("b:") ? BUILT_IN_THEMES.find((x) => x.name === v.slice(2)) : settings.customThemes().find((x) => x.name === v.slice(2));
    if (!t) return;
    const full = fullTokens(t);
    setScheme(t.scheme);
    setTokens(full);
    setOrigin(full);
  };

  const shade = () => {
    const t = tokens();
    setTokens({ ...t, ...derivePalette(t.bg, t.text, t.accent), danger: t.danger, "g-folder": t["g-folder"] });
  };
  const surprise = () => {
    const r = randomPalette(scheme() === "dark");
    setTokens(r.tokens);
    setBase("");
  };

  const draft = (): Theme => ({ name: uniqueThemeName(name() || "My theme", taken()), scheme: scheme(), tokens: tokens() });

  const save = () => {
    const t = draft();
    const list = settings.customThemes();
    settings.setCustomThemes(editing ? list.map((x) => (x === editing ? t : x)) : [...list, t]);
    settings.setTheme(t.name);
    ui.toast(`Theme "${t.name}" saved and applied`);
    close();
  };

  const remove = () => {
    if (!editing) return;
    ui.ask({
      title: `Delete "${editing.name}"?`,
      body: "The theme is removed from this PC. Export it first if you may want it back.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => {
        settings.setCustomThemes(settings.customThemes().filter((x) => x !== editing));
        if (settings.theme() === editing.name) settings.setTheme("Midnight");
        close();
      },
    });
  };

  const share = async (how: "copy" | "file") => {
    try {
      if (how === "copy") {
        await copyTheme(draft());
        ui.toast("Theme copied as JSON");
      } else saveThemeFile(draft());
    } catch (e) {
      ui.toast(errorText(e));
    }
  };

  /** The mock-up carries its own copy of the colors, so a half-finished theme never makes this dialog unreadable. */
  const previewVars = () => themeVars({ tokens: tokens() });

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="dialog theme-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="theme-editor-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") close();
        }}
      >
        <h2 id="theme-editor-title">{editing ? `Edit "${editing.name}"` : "New theme"}</h2>
        <div class="te-body">
          <div class="te-controls">
            <div class="te-top">
              <label class="te-field">
                <span>Name</span>
                <input class="text-input" maxLength={40} placeholder="My theme" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
              </label>
              <div class="te-field">
                <span>Style</span>
                <Segmented<"dark" | "light"> label="Scheme" value={scheme()} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} onChange={setScheme} />
              </div>
            </div>
            <Show when={nameClash()}>
              <p class="muted small te-note">That name is taken, so it is saved as "{draft().name}".</p>
            </Show>
            <div class="te-quick">
              <span class="te-quick-label">Start from</span>
              <Select label="Start from" value={base()} options={baseOptions()} onChange={chooseBase} />
              <button class="btn small" title="Blend the surfaces, borders and muted text from the current Background, Text and Accent" onClick={shade}>
                <MaterialIcon name="auto_fix_high" size={15} /> Auto-shade
              </button>
              <button class="btn small" title="A random palette in the chosen style" onClick={surprise}>
                <MaterialIcon name="casino" size={15} /> Surprise me
              </button>
            </div>
            <div class="te-tokens">
              <For each={TOKEN_INFO}>
                {(group) => (
                  <section>
                    <h3>{group.group}</h3>
                    <For each={group.items}>
                      {(item) => {
                        const changed = () => tokens()[item.token].toLowerCase() !== origin()[item.token].toLowerCase();
                        return (
                          <div class="te-row">
                            <input type="color" class="color" aria-label={item.label} value={toHex(tokens()[item.token])} onInput={(e) => setToken(item.token, e.currentTarget.value)} />
                            <span class="te-name">
                              <span>{item.label}</span>
                              <span class="muted small">{item.hint}</span>
                            </span>
                            <input
                              class="text-input mono te-hex"
                              classList={{ invalid: !isColor(tokens()[item.token]) }}
                              aria-label={`${item.label} value`}
                              spellcheck={false}
                              value={tokens()[item.token]}
                              onInput={(e) => {
                                const v = e.currentTarget.value.trim();
                                e.currentTarget.classList.toggle("invalid", !isColor(v));
                                if (isColor(v)) setToken(item.token, v);
                              }}
                              onChange={(e) => {
                                e.currentTarget.value = tokens()[item.token];
                                e.currentTarget.classList.remove("invalid");
                              }}
                            />
                            <button class="btn small icon-btn te-reset" classList={{ hidden: !changed() }} tabIndex={changed() ? 0 : -1} title="Undo this color" aria-label={`Undo ${item.label}`} onClick={() => setToken(item.token, origin()[item.token])}>
                              <MaterialIcon name="restart_alt" size={16} />
                            </button>
                          </div>
                        );
                      }}
                    </For>
                  </section>
                )}
              </For>
            </div>
          </div>

          <div class="te-side">
            <div class="te-preview" style={previewVars()} aria-label="Preview">
              <div class="tp-bar">
                <span class="tp-dot" />
                <span class="tp-dot" />
                <span class="tp-dot" />
                <span class="tp-tab">Documents</span>
                <span class="tp-tab off">Downloads</span>
              </div>
              <div class="tp-main">
                <div class="tp-side">
                  <span class="tp-item on"><MaterialIcon name="home" size={14} /> Home</span>
                  <span class="tp-item"><MaterialIcon name="star" size={14} /> Pinned</span>
                  <span class="tp-item muted"><MaterialIcon name="schedule" size={14} /> Recent</span>
                </div>
                <div class="tp-list">
                  <span class="tp-row"><span class="tp-folder"><MaterialIcon name="folder" size={14} fill /></span>Projects<em>Today</em></span>
                  <span class="tp-row sel"><span class="tp-folder"><MaterialIcon name="folder" size={14} fill /></span>Invoices<em>Mon</em></span>
                  <span class="tp-row"><MaterialIcon name="draft" size={14} />notes.txt<em>12 KB</em></span>
                  <span class="tp-row faint"><MaterialIcon name="draft" size={14} />Placeholder text<em>—</em></span>
                  <div class="tp-actions">
                    <span class="tp-input">Search…</span>
                    <span class="tp-btn">Open</span>
                    <span class="tp-btn danger">Delete</span>
                  </div>
                </div>
              </div>
            </div>
            <div class="te-checks" role="status">
              <Show when={warnings().length} fallback={<p class="te-ok"><MaterialIcon name="check_circle" size={16} /> Colors are easy to read</p>}>
                <For each={warnings()}>
                  {(w) => (
                    <p class="te-warn">
                      <MaterialIcon name="warning" size={16} /> {w}
                    </p>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </div>

        <div class="dialog-actions te-actions">
          <span class="te-share">
            <button class="btn small" onClick={() => void share("copy")} title="Copy the theme as JSON to share it">
              <MaterialIcon name="content_copy" size={15} /> Copy JSON
            </button>
            <button class="btn small" onClick={() => void share("file")} title="Save the theme as a file">
              <MaterialIcon name="download" size={15} /> Save file
            </button>
            <Show when={editing}>
              <button class="btn small btn-danger-text" onClick={remove}>
                <MaterialIcon name="delete" size={15} /> Delete
              </button>
            </Show>
          </span>
          <button class="btn" onClick={close}>Cancel</button>
          <button class="btn primary" onClick={save}>{editing ? "Save and apply" : "Create and apply"}</button>
        </div>
      </div>
    </div>
  );
}
