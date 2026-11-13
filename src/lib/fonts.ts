// Google Fonts for the interface. The app downloads a font (in Rust, so the page needs no network access),
// hands the bytes to the page as a FontFace, and can keep the files on this PC so they load offline.
import { createSignal } from "solid-js";
import { googleFontBytes, googleFontFaces, googleFontRemove, googleFontSave, googleFontsSaved, type SavedFont } from "./ipc";

/** A curated set of popular families that read well in an interface. */
export const GOOGLE_FONTS: readonly string[] = [
  "Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Nunito", "Nunito Sans", "Source Sans 3", "Noto Sans",
  "IBM Plex Sans", "Fira Sans", "Work Sans", "DM Sans", "Manrope", "Rubik", "Karla", "Mulish", "Outfit", "Lexend",
  "Plus Jakarta Sans", "Figtree", "Public Sans", "Barlow", "Cabin", "Hind", "Oxygen", "Quicksand", "Raleway", "Ubuntu",
  "Merriweather", "Lora", "Playfair Display", "Source Serif 4", "Crimson Text", "JetBrains Mono", "Fira Code", "IBM Plex Mono",
  "Source Code Pro", "Space Grotesk", "Space Mono", "Comfortaa", "Pacifico", "Atkinson Hyperlegible",
];

export const isGoogleFont = (family: string) => GOOGLE_FONTS.includes(family);

export type FontState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly saved: boolean; readonly bytes: number }
  | { readonly kind: "error"; readonly message: string };

const [states, setStates] = createSignal<ReadonlyMap<string, FontState>>(new Map());
/** How a Google font stands right now (not loaded, loading, ready, or failed). */
export const fontState = (family: string): FontState => states().get(family) ?? { kind: "idle" };
const setState = (family: string, s: FontState) => setStates((m) => new Map(m).set(family, s));

/** Fonts already added to the page this session. */
const added = new Set<string>();

/**
 * Makes a Google font available to the page. Saved fonts load from disk, others are downloaded from Google
 * (when `allowDownload`). Resolves true when the font is ready to use.
 */
export async function loadGoogleFont(family: string, allowDownload: boolean): Promise<boolean> {
  if (!isGoogleFont(family)) return false;
  if (added.has(family)) return true;
  setState(family, { kind: "loading" });
  try {
    const info = await googleFontFaces(family, allowDownload);
    for (const face of info.faces) {
      const bytes = await googleFontBytes(family, face.file);
      const ff = new FontFace(family, bytes, { weight: face.weight, style: face.style, unicodeRange: face.range || undefined, display: "swap" });
      await ff.load();
      document.fonts.add(ff);
    }
    added.add(family);
    setState(family, { kind: "ready", saved: info.saved, bytes: info.bytes });
    return true;
  } catch (e) {
    setState(family, { kind: "error", message: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/** Saves a downloaded font on this PC so it loads offline from now on. */
export async function saveGoogleFont(family: string) {
  const info = await googleFontSave(family);
  setState(family, { kind: "ready", saved: true, bytes: info.bytes });
  void refreshSaved();
}

/** Deletes a saved font. The copy already in the page stays until the app restarts. */
export async function removeGoogleFont(family: string) {
  await googleFontRemove(family);
  added.delete(family);
  setState(family, { kind: "idle" });
  void refreshSaved();
}

const [saved, setSaved] = createSignal<readonly SavedFont[]>([]);
/** Fonts saved on this PC, newest listing from `refreshSaved`. */
export const savedFonts = saved;
export async function refreshSaved() {
  setSaved(await googleFontsSaved().catch(() => []));
}
