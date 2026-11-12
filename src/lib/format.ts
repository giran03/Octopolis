import { fileIconSpec } from "./fileicons";
import { baseName, extensionOf, isRoot } from "./paths";

const UNITS = ["KB", "MB", "GB", "TB", "PB"];

/** Explorer-style size: whole KB below 1 MB, then 3 significant digits. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes === 0 ? "0 KB" : "1 KB";
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${Math.ceil(value).toLocaleString()} KB`;
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

export function formatDate(ms: number): string {
  return ms > 0 ? dateFmt.format(ms) : "";
}

export function typeLabel(name: string, isDir: boolean): string {
  if (isDir) return "Folder";
  const ext = extensionOf(name);
  return ext ? `${ext.toUpperCase()} file` : "File";
}

export function formatCount(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}

/** Formats duration in seconds cleanly as `M:SS` or `H:MM:SS`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export type FileCategory = "folder" | "code" | "image" | "audio" | "video" | "archive" | "doc" | "exe" | "file";

const CATEGORIES: Record<string, FileCategory> = {};
const register = (cat: FileCategory, exts: string) => exts.split(" ").forEach((e) => (CATEGORIES[e] = cat));
register("code", "rs ts tsx js jsx mjs cjs json toml yaml yml py go c h cpp hpp cs java kt swift rb php lua sh ps1 bat cmd css scss html xml sql md");
register("image", "png jpg jpeg gif webp bmp ico svg tif tiff heic avif psd");
register("audio", "mp3 wav flac ogg m4a aac opus wma");
register("video", "mp4 mkv mov avi webm wmv m4v");
register("archive", "zip 7z rar tar gz bz2 xz zst iso cab");
register("doc", "pdf doc docx xls xlsx ppt pptx txt rtf odt csv epub");
register("exe", "exe msi dll appx msix lnk");

export function categoryOf(name: string, isDir: boolean): FileCategory {
  if (isDir) return "folder";
  return CATEGORIES[extensionOf(name)] ?? "file";
}

/** Infers whether a path string (e.g. from GoTo history) points to a directory rather than a known file type. */
export function inferPathIsDir(path: string, knownDirs?: ReadonlySet<string>): boolean {
  const norm = path.trim().replace(/\//g, "\\");
  if (!norm || norm.endsWith("\\") || isRoot(norm)) return true;
  if (knownDirs?.has(norm.toLowerCase())) return true;
  const name = baseName(norm);
  return fileIconSpec(name) === null && categoryOf(name, false) === "file";
}

/** A file name without its last extension (kept whole for folders, dotfiles and names with no extension). */
export function withoutExtension(name: string, isDir: boolean): string {
  if (isDir) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(0, dot) : name;
}
