// Auto view: pick how a folder is shown from what is in it (a folder of pictures as a bento, one of songs as rows...).
import { categoryOf } from "./format";
import type { ViewMode } from "./folderViews";
import { KIND_DIR } from "./listing";

/** What a folder holds, counted by kind. */
export interface FolderStats {
  readonly total: number;
  readonly files: number;
  readonly folders: number;
  readonly images: number;
  readonly videos: number;
  readonly audio: number;
  readonly docs: number;
  readonly code: number;
  readonly archives: number;
  /** The folder is a repository or inside one: it holds a .git, .hg or .svn, or (set by the caller) a folder above it does. */
  readonly repo: boolean;
}

/** The marker entries of a version-control repository. */
const REPO_MARKERS = new Set([".git", ".hg", ".svn"]);

/** Only this many entries are looked at: the mix of a huge folder shows in its first part. */
const SAMPLE_LIMIT = 20_000;

export function folderStats(names: readonly string[], kinds: readonly number[], count: number): FolderStats {
  let repo = false;
  let folders = 0, images = 0, videos = 0, audio = 0, docs = 0, code = 0, archives = 0, files = 0;
  const n = Math.min(count, SAMPLE_LIMIT);
  for (let i = 0; i < n; i++) {
    const name = names[i];
    if (REPO_MARKERS.has(name.toLowerCase())) repo = true;
    const slash = name.lastIndexOf("\\");
    const category = categoryOf(slash >= 0 ? name.slice(slash + 1) : name, kinds[i] === KIND_DIR);
    if (category === "folder") {
      folders++;
      continue;
    }
    files++;
    if (category === "image") images++;
    else if (category === "video") videos++;
    else if (category === "audio") audio++;
    else if (category === "doc") docs++;
    else if (category === "code") code++;
    else if (category === "archive") archives++;
  }
  return { total: n, files, folders, images, videos, audio, docs, code, archives, repo };
}

export interface AutoChoice {
  readonly mode: ViewMode;
  /** Icon size, when the choice is an icon view. */
  readonly size?: number;
  /** Why, in a few words, for the View menu. */
  readonly reason: string;
}

/** Above this many entries pictures are not laid out as a bento: the plain list stays fast. */
export const BENTO_LIMIT = 6000;
export const HUGE_FOLDER = 20_000;

/** The view that suits a folder's contents; null for an empty folder (nothing to go by). */
export function chooseView(s: FolderStats): AutoChoice | null {
  if (s.total === 0) return null;
  // A repository is source to read and compare, whatever else it holds (a docs folder full of screenshots included).
  if (s.repo) return { mode: "details", reason: "A repository, and everything in it, is easiest to read as a list" };
  if (s.total >= HUGE_FOLDER) return { mode: "details", reason: "A very large folder is easiest to scan as a list" };
  const media = s.images + s.videos;
  const mediaShare = s.files > 0 ? media / s.files : 0;
  const kind = s.videos > s.images ? "videos" : "pictures";
  if (s.files >= 12 && mediaShare >= 0.6) {
    if (s.total <= BENTO_LIMIT) return { mode: "bento", reason: `Mostly ${kind} (${media} of ${s.files} files)` };
    return { mode: "grid", size: 96, reason: `Mostly ${kind}, and too many for a bento` };
  }
  if (s.files >= 4 && mediaShare >= 0.75) return { mode: "grid", size: 160, reason: `A few ${kind}` };
  if (s.files >= 6 && s.audio / s.files >= 0.6) return { mode: "content", reason: `Mostly music (${s.audio} of ${s.files} files)` };
  if (s.total >= 4 && s.folders / s.total >= 0.7) return { mode: "tiles", reason: `Mostly folders (${s.folders} of ${s.total})` };
  return { mode: "details", reason: "A mix of files" };
}
