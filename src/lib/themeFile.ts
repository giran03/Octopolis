// Sharing custom themes: copy as JSON, save as a file, read a file back.
import { themeToJson } from "./themeTools";
import type { Theme } from "./themes";

const MAX_FILE_BYTES = 256 * 1024;

export async function copyTheme(theme: Theme): Promise<void> {
  await navigator.clipboard.writeText(themeToJson(theme));
}

/** Downloads the theme as `<name>.octopolis-theme.json`. */
export function saveThemeFile(theme: Theme): void {
  const blob = new Blob([themeToJson(theme)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${theme.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "theme"}.octopolis-theme.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The text of a chosen theme file; refuses anything big, since a theme is a few hundred bytes. */
export async function readThemeFile(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) throw new Error("That file is too big to be a theme");
  return file.text();
}
