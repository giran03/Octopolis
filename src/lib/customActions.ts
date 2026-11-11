// User-defined commands run on the selection, with placeholders for paths.
export type ActionMode = "hidden" | "console";

export interface CustomAction {
  readonly name: string;
  /** Command line; {path} {paths} {dir} {name} {stem} are filled in. */
  readonly command: string;
  /** Lower-case extensions it applies to (empty: every file and folder). */
  readonly extensions: readonly string[];
  readonly mode: ActionMode;
}

const quote = (s: string) => `"${s}"`;
const baseName = (p: string) => p.slice(p.lastIndexOf("\\") + 1);
const stemOf = (name: string) => (name.lastIndexOf(".") > 0 ? name.slice(0, name.lastIndexOf(".")) : name);

/**
 * Fills the placeholders. Paths are quoted ({path} is the first item, {paths}
 * all of them); {name} and {stem} are left bare so they can sit inside quotes.
 */
export function expandCommand(template: string, paths: readonly string[], dir: string): string {
  const first = paths[0] ?? dir;
  const values: Record<string, string> = {
    path: quote(first),
    paths: paths.length ? paths.map(quote).join(" ") : quote(dir),
    dir: quote(dir),
    name: baseName(first),
    stem: stemOf(baseName(first)),
  };
  return template.replace(/\{(path|paths|dir|name|stem)\}/g, (_, k: string) => values[k]);
}

/** Whether an action fits the selected names. */
export function actionApplies(a: CustomAction, names: readonly string[]): boolean {
  if (a.extensions.length === 0) return true;
  return names.length > 0 && names.every((n) => {
    const dot = n.lastIndexOf(".");
    return dot > 0 && a.extensions.includes(n.slice(dot + 1).toLowerCase());
  });
}

/** "mp4, .MOV;mkv" → ["mp4", "mov", "mkv"]. */
export function parseExtensions(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((e) => e.trim().replace(/^\./, "").toLowerCase()).filter(Boolean))];
}

export function parseActions(raw: unknown): CustomAction[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => a && typeof a.name === "string" && a.name.trim() && typeof a.command === "string" && a.command.trim())
    .map((a) => ({
      name: String(a.name).trim(),
      command: String(a.command),
      extensions: Array.isArray(a.extensions) ? a.extensions.filter((e: unknown): e is string => typeof e === "string") : [],
      mode: a.mode === "console" ? "console" : "hidden",
    }));
}
