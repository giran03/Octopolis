// Windows path helpers that work on plain strings (no IPC round-trips).

export interface Crumb {
  readonly label: string;
  readonly path: string;
}

function normalize(p: string): string {
  return p.replace(/\//g, "\\");
}

/** Splits a path into its root (`C:\` or `\\server\share\`) and the rest. */
export function splitRoot(path: string): { root: string; rest: string[] } {
  const p = normalize(path);
  const unc = /^\\\\[^\\]+\\[^\\]+\\?/.exec(p);
  const drive = /^[A-Za-z]:\\?/.exec(p);
  const match = unc?.[0] ?? drive?.[0] ?? "";
  const root = match && !match.endsWith("\\") ? `${match}\\` : match;
  const rest = p.slice(match.length).split("\\").filter(Boolean);
  return { root, rest };
}

export function isRoot(path: string): boolean {
  const { root, rest } = splitRoot(path);
  return root !== "" && rest.length === 0;
}

export function joinPath(dir: string, name: string): string {
  const d = normalize(dir);
  return d.endsWith("\\") ? `${d}${name}` : `${d}\\${name}`;
}

/** Parent folder, or null at a drive or share root. */
export function parentPath(path: string): string | null {
  const { root, rest } = splitRoot(path);
  if (rest.length === 0) return null;
  const parent = rest.slice(0, -1).join("\\");
  return root + parent;
}

export function baseName(path: string): string {
  const { root, rest } = splitRoot(path);
  if (rest.length === 0) return root.replace(/\\$/, "");
  return rest[rest.length - 1];
}

/** Virtual path for the "All drives" (Devices and drives) overview. */
export const ALL_DRIVES_PATH = "octopolis://drives";

export function isDrivesPath(path: string): boolean {
  return path.trim().toLowerCase() === ALL_DRIVES_PATH;
}

export function breadcrumbs(path: string): Crumb[] {
  if (isDrivesPath(path)) return [{ label: "All drives", path: ALL_DRIVES_PATH }];
  const { root, rest } = splitRoot(path);
  const crumbs: Crumb[] = root ? [{ label: root.replace(/\\$/, ""), path: root }] : [];
  let acc = root;
  for (const part of rest) {
    acc = acc.endsWith("\\") || acc === "" ? acc + part : `${acc}\\${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

export function sameVolume(a: string, b: string): boolean {
  return splitRoot(a).root.toLowerCase() === splitRoot(b).root.toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  const strip = (p: string) => normalize(p).replace(/\\+$/, "").toLowerCase();
  return strip(a) === strip(b);
}

/** Lower-cased extension without the dot; "" for none or dotfiles. */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/**
 * PowerShell command that changes folder. PowerShell treats the typographic
 * quotes as single quotes too, so all of them must be doubled.
 */
export function psCdCommand(path: string): string {
  return `Set-Location -LiteralPath '${path.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'\r`;
}

/** Length of the name without its extension, for selecting it on rename. */
export function stemLength(name: string, isDir: boolean): number {
  if (isDir) return name.length;
  const i = name.lastIndexOf(".");
  return i > 0 ? i : name.length;
}
