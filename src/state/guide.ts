// The offline guide: opens it in the browser at the right section, and keeps the theme it follows up to date.
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { VERSION } from "../lib/app";
import { guidePayload, guideSectionFor, type GuideThemeInput } from "../lib/guideTheme";
import { errorText, openGuide, updateGuideTheme } from "../lib/ipc";
import { settings } from "./settings";
import { ui } from "./ui";

const SYNC_DELAY_MS = 400;

export const guide = createRoot(() => {
  const dark = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  const [systemIsDark, setSystemIsDark] = createSignal(dark?.matches ?? true);
  dark?.addEventListener("change", () => setSystemIsDark(dark.matches));

  /** When and where the guide was last opened from this session; null until it has been. */
  let opened: { at: number; section: string | null; search: string | null } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const themeInput = (): GuideThemeInput => ({
    theme: settings.theme(),
    systemLight: settings.systemLight(),
    systemDark: settings.systemDark(),
    systemIsDark: systemIsDark(),
    customThemes: settings.customThemes(),
    accent: settings.accent(),
    uiFont: settings.uiFont(),
    googleFonts: settings.googleFonts(),
    motion: settings.motion(),
  });
  const payload = (at: number, section: string | null, search: string | null = null) => JSON.stringify(guidePayload(themeInput(), { section, openedAt: at, version: VERSION, search }));

  /** The guide section that explains what the user has open right now (null: the top of the guide). */
  const currentSection = () =>
    guideSectionFor({
      palette: ui.palette() !== null,
      settingsTab: ui.settingsTab(),
      themeEditor: ui.themeEditor() !== null,
      actionsEditor: ui.actionsEditorOpen(),
      recycleBin: ui.recycleBinOpen(),
      duplicates: ui.duplicatesRoot() !== null,
      rules: ui.rulesOpen(),
      cleanup: ui.cleanupRoot() !== null || ui.systemCleanupOpen() || ui.diskSpaceRoot() !== null,
      tags: ui.tagPaths() !== null || ui.taggedView() !== null,
      batchRename: ui.batchRenameOpen(),
      properties: ui.propertiesPaths() !== null,
      imageTools: ui.imageToolsPaths() !== null,
      emoji: ui.emojiTarget() !== null,
    });

  // After the guide has been opened, a changed theme, accent, font or motion setting reaches it too: it reads the file when its tab regains focus.
  createEffect(
    on(
      () => payload(0, null),
      () => {
        if (!opened) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (opened) void updateGuideTheme(payload(opened.at, opened.section, opened.search)).catch(() => undefined);
        }, SYNC_DELAY_MS);
      },
      { defer: true },
    ),
  );

  return {
    /** Opens the guide in the default browser, on `section` or on the one that matches what is open, with its search box filled in when `search` is given. */
    open: async (section?: string | null, search: string | null = null) => {
      const at = Date.now();
      const sec = section === undefined ? currentSection() : section;
      try {
        await openGuide(payload(at, sec, search));
        opened = { at, section: sec, search };
      } catch (e) {
        ui.toast(`Couldn't open the guide: ${errorText(e)}`);
      }
    },
  };
});
