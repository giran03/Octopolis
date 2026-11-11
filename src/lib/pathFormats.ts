// The ways a path can be copied as text ("Copy as" menu).
import { baseName } from "./paths";

export type PathFormat = "plain" | "quoted" | "forward" | "relative" | "url" | "wsl" | "name";

export const PATH_FORMATS: readonly { readonly id: PathFormat; readonly label: string; readonly example: string }[] = [
  { id: "quoted", label: "Path in quotes", example: '"C:\\Users\\me\\file.txt"' },
  { id: "forward", label: "Path with forward slashes", example: "C:/Users/me/file.txt" },
  { id: "relative", label: "Path relative to this folder", example: ".\\sub\\file.txt" },
  { id: "name", label: "Name only", example: "file.txt" },
  { id: "url", label: "File URL", example: "file:///C:/Users/me/file.txt" },
  { id: "wsl", label: "WSL path", example: "/mnt/c/Users/me/file.txt" },
];

const isUnc = (p: string) => p.startsWith("\\\\");

/** `C:\a b\c` → `file:///C:/a%20b/c`; `\\server\share\x` → `file://server/share/x`. */
export function toFileUrl(path: string): string {
  const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");
  if (isUnc(path)) return `file://${enc(path.slice(2).replace(/\\/g, "/"))}`;
  const [drive, ...rest] = path.replace(/\\/g, "/").split("/");
  return `file:///${drive}/${enc(rest.join("/"))}`;
}

/** `C:\Users\me` → `/mnt/c/Users/me`. Network paths have no WSL form and are returned with forward slashes. */
export function toWslPath(path: string): string {
  const m = /^([a-zA-Z]):(?:\\(.*))?$/.exec(path);
  if (!m) return path.replace(/\\/g, "/");
  const rest = (m[2] ?? "").replace(/\\/g, "/").replace(/\/$/, "");
  return `/mnt/${m[1].toLowerCase()}${rest ? `/${rest}` : ""}`;
}

/** `base\sub\x` relative to `base` → `.\sub\x`; outside it, the full path. */
export function toRelative(path: string, base: string): string {
  const b = base.replace(/\\+$/, "");
  if (path.toLowerCase() === b.toLowerCase()) return ".";
  return path.toLowerCase().startsWith(`${b.toLowerCase()}\\`) ? `.\\${path.slice(b.length + 1)}` : path;
}

/** Formats one path; `base` is the folder relative paths start from. */
export function formatPath(path: string, format: PathFormat, base: string): string {
  switch (format) {
    case "plain":
      return path;
    case "quoted":
      return `"${path}"`;
    case "forward":
      return path.replace(/\\/g, "/");
    case "relative":
      return toRelative(path, base);
    case "url":
      return toFileUrl(path);
    case "wsl":
      return toWslPath(path);
    case "name":
      return baseName(path);
  }
}

/** Several paths as clipboard text, one per line (quoted paths on one line, space-separated, ready for a command). */
export function formatPaths(paths: readonly string[], format: PathFormat, base: string): string {
  const parts = paths.map((p) => formatPath(p, format, base));
  return format === "quoted" ? parts.join(" ") : parts.join("\r\n");
}
