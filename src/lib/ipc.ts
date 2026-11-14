// Typed wrappers around the Tauri commands in src-tauri.
import { Channel, invoke } from "@tauri-apps/api/core";

export interface ListSummary {
  count: number;
  elapsedMs: number;
  /** The archive file, when the folder is inside one. */
  archive: string | null;
}

/**
 * Lists a folder. Batches arrive as raw ArrayBuffers on a channel; large ones
 * travel through a separate fetch, so the command can resolve before the
 * last batch is delivered. The promise therefore waits for both the command
 * result and the batch flagged as final.
 */
export function listDir(path: string, onBatch: (buf: ArrayBuffer) => boolean): Promise<ListSummary> {
  return new Promise((resolve, reject) => {
    let summary: ListSummary | null = null;
    let finalSeen = false;
    const settle = () => summary && finalSeen && resolve(summary);
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buf) => {
      try {
        if (onBatch(buf)) {
          finalSeen = true;
          settle();
        }
      } catch (e) {
        reject(e);
      }
    };
    invoke<ListSummary>("list_dir", { path, onBatch: channel }).then((s) => {
      summary = s;
      settle();
    }, reject);
  });
}

export interface SearchSummary {
  matched: number;
  shown: number;
  indexed: number;
  mode: "usn" | "walk";
  indexMs: number | null;
  elapsedMs: number;
}

/**
 * Searches `root` recursively. Results arrive as listing batches whose names
 * are paths relative to `root`; `onProgress` reports items scanned while the
 * index is being built. Waits for the final batch, like `listDir`.
 */
export function search(
  tabId: string,
  root: string,
  query: string,
  rebuild: boolean,
  onBatch: (buf: ArrayBuffer) => boolean,
  onProgress: (scanned: number) => void,
): Promise<SearchSummary> {
  return new Promise((resolve, reject) => {
    let summary: SearchSummary | null = null;
    let finalSeen = false;
    const settle = () => summary && finalSeen && resolve(summary);
    const batches = new Channel<ArrayBuffer>();
    batches.onmessage = (buf) => {
      try {
        if (onBatch(buf)) {
          finalSeen = true;
          settle();
        }
      } catch (e) {
        reject(e);
      }
    };
    const progress = new Channel<number>();
    progress.onmessage = onProgress;
    invoke<SearchSummary>("search", { tabId, root, query, rebuild, onBatch: batches, onProgress: progress }).then((s) => {
      summary = s;
      settle();
    }, reject);
  });
}

export const cancelSearch = (tabId: string) => invoke<void>("cancel_search", { tabId });

export interface Resolved {
  dir: string;
  select: string | null;
}

export const resolvePath = (input: string) => invoke<Resolved>("resolve_path", { input });

export type OpRequest =
  | { kind: "copy"; sources: string[]; dest: string }
  | { kind: "move"; sources: string[]; dest: string }
  | { kind: "delete"; paths: string[]; permanent: boolean }
  | { kind: "relocate"; pairs: [string, string][] }
  | { kind: "extract"; archive: string; items: string[]; dest: string }
  | { kind: "compress"; sources: string[]; dest: string; name: string; format: ArchiveFormat };

export type ArchiveFormat = "zip" | "sevenZ" | "tarGz";

export type ConflictChoice = "keepBoth" | "overwrite" | "skip";

/** Items a copy or move of `sources` into `dest` would collide with. */
export const transferConflicts = (sources: string[], dest: string) => invoke<import("./conflicts").NameConflict[]>("transfer_conflicts", { sources, dest });

export interface OpOptions {
  conflict: ConflictChoice;
  verify: boolean;
  limitBps: number | null;
}

export type OpEvent =
  | { type: "started" }
  | { type: "progress"; totalBytes: number; doneBytes: number; totalItems: number; doneItems: number; current: string | null }
  | { type: "done"; errors: { path: string; message: string }[]; skipped: number; created: string[]; pairs: [string, string][]; cancelled: boolean };

export function startOp(request: OpRequest, options: OpOptions, onEvent: (e: OpEvent) => void): Promise<number> {
  const channel = new Channel<OpEvent>();
  channel.onmessage = onEvent;
  return invoke<number>("start_op", { request, options, onEvent: channel });
}

export interface GitInfo {
  branch: string | null;
  children: Record<string, string>;
}
export const gitStatus = (dir: string) => invoke<GitInfo | null>("git_status", { dir });
export interface CommitInfo {
  timeMs: number;
  author: string;
}
export const gitLastCommits = (dir: string) => invoke<Record<string, CommitInfo>>("git_last_commits", { dir });
export const nativeMenu = (paths: string[]) => invoke<void>("native_menu", { paths });

export function termStart(cwd: string, cols: number, rows: number, onData: (buf: ArrayBuffer) => void, shell?: string): Promise<number> {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = onData;
  return invoke<number>("term_start", { cwd, cols, rows, onData: channel, shell });
}
export const termWrite = (id: number, data: string) => invoke<void>("term_write", { id, data });
export const termResize = (id: number, cols: number, rows: number) => invoke<void>("term_resize", { id, cols, rows });
export const termClose = (id: number) => invoke<void>("term_close", { id });

export const cancelOp = (id: number) => invoke<void>("cancel_op", { id });
export const pauseOp = (id: number, paused: boolean) => invoke<void>("pause_op", { id, paused });
export const batchRename = (items: [string, string][]) => invoke<[string, string][]>("batch_rename", { items });
export const restoreRecycled = (paths: string[]) => invoke<number>("restore_recycled", { paths });
export const removeEmptyDir = (path: string) => invoke<void>("remove_empty_dir", { path });

export interface Preview {
  kind: "code" | "markdown" | "text" | "image" | "svg" | "pdf" | "audio" | "video" | "model" | "archive" | "binary" | "font" | "table";
  lang: string | null;
  size: number;
  text: string | null;
  lines: string[] | null;
  html: string | null;
  hex: string | null;
  truncated: boolean;
  entries: number | null;
  tags: Record<string, string>;
  details: [string, string][];
}

export const previewFile = (path: string) => invoke<Preview>("preview_file", { path });
/** Opens a file in `editor`, or the file type's editor (Notepad if it has none). Never runs the file. */
export const openInEditor = (path: string, editor: string | null) => invoke<void>("open_in_editor", { path, editor });
/** Opens a terminal window (Windows Terminal when installed) in a folder. */
export const openTerminalHere = (path: string) => invoke<void>("open_terminal_here", { path });
/** For each path, whether it is a folder. */
export const pathsAreDirs = (paths: string[]) => invoke<boolean[]>("paths_are_dirs", { paths });
/** The Windows folder picker; null when cancelled. */
export const pickFolderDialog = (initial?: string) => invoke<string | null>("pick_folder_dialog", { initial: initial ?? null });
export interface DetectedEditor {
  name: string;
  path: string;
}
let editorsCache: Promise<DetectedEditor[]> | null = null;
/** Editors installed on this PC. The search takes a moment, so it runs once per session; pass `refresh` to search again. */
export const detectEditors = (refresh = false): Promise<DetectedEditor[]> => {
  if (!editorsCache || refresh) {
    const run = invoke<DetectedEditor[]>("detect_editors");
    editorsCache = run;
    // A failed search shouldn't stick: the next call tries again.
    run.catch(() => {
      if (editorsCache === run) editorsCache = null;
    });
  }
  return editorsCache;
};
/** Adds a line to the local diagnostics log (paths are removed before writing). */
export const diagLog = (level: "info" | "warn" | "error", message: string) => invoke<void>("diag_log", { level, message });
/** Logs how long after process start a startup stage was reached; returns those ms. */
export const startupMark = (stage: string) => invoke<number>("startup_mark", { stage, pageMs: performance.now() });
export const openLogFolder = () => invoke<void>("open_log_folder");
/** Keeps Windows from sleeping while transfers run. */
export const setKeepAwake = (on: boolean) => invoke<void>("set_keep_awake", { on });
/** Shows a Windows notification. */
export const notify = (title: string, body: string) => invoke<void>("notify", { title, body });
/** Opens Windows' font installer for a font file. */
export const installFont = (path: string) => invoke<void>("install_font", { path });
export const runPath = (path: string) => invoke<void>("run_path", { path });
export const readBytes = (path: string) => invoke<ArrayBuffer>("read_bytes", { path });
export const thumbnail = (path: string, size: number, iconOnly: boolean) => invoke<ArrayBuffer>("thumbnail", { path, size, iconOnly });
/** Starts a Windows drag of real files out of the window; resolves true when they were dropped somewhere. */
export const startNativeDrag = (paths: string[]) => invoke<boolean>("start_native_drag", { paths });
/** Saves a dropped file's bytes in a folder under an unused name; returns the new path. */
export const saveDroppedFile = (dir: string, name: string, data: Uint8Array) =>
  invoke<string>("save_dropped_file", data, { headers: { "x-dir": encodeURIComponent(dir), "x-name": encodeURIComponent(name) } });
/** Downloads a picture, video or audio file from a link into a folder; returns the new path. */
export const downloadDroppedUrl = (url: string, dir: string) => invoke<string>("download_dropped_url", { url, dir });
export const extractAndOpen = (path: string) => invoke<void>("extract_and_open", { path });

export interface Locker {
  pid: number;
  name: string;
  kind: string;
}
export const whoLocks = (paths: string[]) => invoke<Locker[]>("who_locks", { paths });
export const killProcess = (pid: number, paths: string[]) => invoke<void>("kill_process", { pid, paths });
export const fileTags = (paths: string[]) => invoke<Record<string, string>[]>("file_tags", { paths });

export interface FolderSizeInfo {
  name: string;
  bytes: number;
  files: number;
  /** A remembered number that is being checked again. */
  stale: boolean;
}

export interface SpaceNode {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
  readonly files: number;
  readonly cached: boolean;
  readonly children: readonly SpaceNode[];
}

export interface SpaceTree {
  readonly root: SpaceNode;
  readonly scanning: boolean;
  readonly scanned: number;
  readonly total: number;
}

export const cachedFolderSizes = (dir: string) => invoke<FolderSizeInfo[]>("cached_folder_sizes", { dir });
export const diskSpaceTree = (root: string) => invoke<SpaceTree>("disk_space_tree", { root });
export const cancelDiskSpace = () => invoke<void>("cancel_disk_space");
export function scanDiskSpace(root: string, onUpdate: (tree: SpaceTree) => void): Promise<void> {
  const channel = new Channel<SpaceTree>();
  channel.onmessage = onUpdate;
  return invoke<void>("scan_disk_space", { root, onUpdate: channel });
}

export function folderSizes(tabId: string, dir: string, onSize: (s: FolderSizeInfo) => void): Promise<void> {
  const channel = new Channel<FolderSizeInfo>();
  channel.onmessage = onSize;
  return invoke<void>("folder_sizes", { tabId, dir, onSize: channel });
}
export const renameItem = (path: string, newName: string) => invoke<string>("rename_item", { path, newName });
export const createFolder = (parent: string, name: string) => invoke<string>("create_folder", { parent, name });
/** Creates a file, numbering the name if taken; `template` names a file in the templates folder. */
export const createFile = (parent: string, name: string, template?: string) => invoke<string>("create_file", { parent, name, template: template ?? null });
export interface BinItem {
  readonly id: string;
  readonly name: string;
  readonly originalPath: string;
  readonly deletedMs: number;
  readonly size: number | null;
  readonly isDir: boolean;
}
export const recycleBinList = () => invoke<BinItem[]>("recycle_bin_list");
export const recycleBinRestore = (ids: string[]) => invoke<number>("recycle_bin_restore", { ids });
export const recycleBinPurge = (ids: string[]) => invoke<number>("recycle_bin_purge", { ids });
export const recycleBinEmpty = () => invoke<number>("recycle_bin_empty");
export type LinkKind = "symbolic" | "junction" | "hard";
/** Creates links to `targets` in `dest`; resolves with the links made and the errors. */
export const createLinks = (kind: LinkKind, targets: string[], dest: string) => invoke<[string[], string[]]>("create_links", { kind, targets, dest });
/** File names in the user's templates folder. */
export const listTemplates = () => invoke<string[]>("list_templates");
/** The templates folder's path (created if missing). */
export const templatesFolder = () => invoke<string>("templates_folder");
import type { RuleQuery } from "./rules";
import type { LatestRelease } from "./update";

/** Writes the offline guide next to its theme file (`theme` is the JSON from guideTheme) and opens it in the default browser. */
export const openGuide = (theme: string) => invoke<void>("open_guide", { theme });
/** Refreshes the theme the guide follows. */
export const updateGuideTheme = (theme: string) => invoke<void>("update_guide_theme", { theme });

/** Opens an https: or mailto: link in the user's default app. */
export const openExternal = (url: string) => invoke<void>("open_path", { path: url });

export const updateCheck = (repo: string) => invoke<LatestRelease>("update_check", { repo });
export const updateDownload = (url: string, name: string, sha256: string) => invoke<string>("update_download", { url, name, sha256 });
export const updateInstall = (path: string, sha256: string) => invoke<void>("update_install", { path, sha256 });
export const openDataFolder = () => invoke<void>("open_data_folder");
export const debugInfo = () => invoke<string>("debug_info");

export interface CacheItem {
  readonly id: "sizes" | "updates" | "search";
  readonly label: string;
  readonly detail: string;
  readonly bytes: number;
  readonly count: number;
  readonly kind: "disk" | "memory";
}

export interface CacheInfo {
  readonly dir: string;
  readonly defaultDir: string;
  readonly isCustom: boolean;
  readonly totalDiskBytes: number;
  readonly items: readonly CacheItem[];
}

export const cacheInfo = () => invoke<CacheInfo>("cache_info");
export const openCacheFolder = () => invoke<void>("open_cache_folder");
export const pickCacheFolder = () => invoke<string | null>("pick_cache_folder");
export const setCacheDir = (path: string | null) => invoke<CacheInfo>("set_cache_dir", { path });
export const clearCache = (scope: "sizes" | "updates" | "search" | "all") => invoke<CacheInfo>("clear_cache", { scope });

export const openPath = (path: string) => invoke<void>("open_path", { path });
/** Opens many files with their own apps in one call; resolves with a message for each that failed. */
export const openPaths = (paths: string[]) => invoke<string[]>("open_paths", { paths });
/** Opens many files in one launch of the chosen editor (or each file type's editor). */
export const openInEditorMany = (paths: string[], editor: string | null) => invoke<void>("open_in_editor_many", { paths, editor });
export const revealInExplorer = (path: string) => invoke<void>("reveal_in_explorer", { path });
/** Windows' "Open with" dialog for a file. */
export const openWith = (path: string) => invoke<void>("open_with", { path });
/** Starts a program or script with administrator rights; Windows asks the user first. */
export const runAsAdmin = (path: string) => invoke<void>("run_as_admin", { path });
export interface ClipFiles {
  readonly paths: string[];
  readonly cut: boolean;
  /** Windows' clipboard sequence number when read. */
  readonly sequence: number;
}
/** Puts files on the Windows clipboard (Explorer can paste them); resolves with the new sequence number. */
export const clipboardWriteFiles = (paths: string[], cut: boolean) => invoke<number>("clipboard_write_files", { paths, cut });
/** Files on the Windows clipboard, from any app; empty `paths` when there are none. */
export const clipboardReadFiles = () => invoke<ClipFiles>("clipboard_read_files");
export const clipboardClear = () => invoke<void>("clipboard_clear");
/** Saves a clipboard picture (PNG) or text as a new file in `dest`; null when there is neither. */
export const pasteClipboardAsFile = (dest: string) => invoke<string | null>("paste_clipboard_as_file", { dest });
/** Safely ejects a removable drive such as `E:\`. */
export const ejectDrive = (root: string) => invoke<void>("eject_drive", { root });

export interface Drive {
  root: string;
  label: string;
  fileSystem: string;
  kind: "fixed" | "removable" | "network" | "optical" | "ram" | "unknown";
  totalBytes: number;
  freeBytes: number;
}
export const listDrives = () => invoke<Drive[]>("list_drives");

export interface KnownFolder {
  id: string;
  label: string;
  path: string;
}
export const knownFolders = () => invoke<KnownFolder[]>("known_folders");
export interface IconCatalog {
  /** System icon files and how many icons each holds. */
  resources: { dll: string; count: number }[];
  /** Apps in the Start menu, by name and Windows' id for them. */
  apps: { id: string; label: string }[];
}
/** Every other icon Windows offers to borrow: the Start menu's apps and the icons inside its icon files. Takes a moment. */
export const systemIconCatalog = () => invoke<IconCatalog>("system_icon_catalog");
/** Whether a folder is a repository, or inside one (a .git, .hg or .svn in it or above it). */
export const insideRepository = (path: string) => invoke<boolean>("inside_repository", { path });
/** The folders whose Windows icons other folders can borrow, limited to the ones this PC has. */
export const folderIconStyles = () => invoke<KnownFolder[]>("folder_icon_styles");

export interface FileAttributes {
  readOnly: boolean;
  hidden: boolean;
  system: boolean;
  archive: boolean;
}
export interface FileProperties {
  readonly isDir: boolean;
  readonly size: number;
  readonly sizeOnDisk: number | null;
  readonly createdMs: number;
  readonly modifiedMs: number;
  readonly accessedMs: number;
  readonly attributes: FileAttributes;
  readonly hardLinks: number;
  /** Alternate data streams: [name, size]. */
  readonly streams: [string, number][];
  readonly linkTarget: string | null;
}
export type ChecksumKind = "blake3" | "sha256" | "md5";
export const fileProperties = (path: string) => invoke<FileProperties>("file_properties", { path });
/** Properties of many paths in one call; null for one that can't be read. */
export const filePropertiesMany = (paths: string[]) => invoke<(FileProperties | null)[]>("file_properties_many", { paths });
export const setFileAttributes = (paths: string[], attributes: FileAttributes) => invoke<void>("set_file_attributes", { paths, attributes });
export const setFileTimes = (path: string, times: { createdMs?: number; modifiedMs?: number; accessedMs?: number }) =>
  invoke<void>("set_file_times", { path, createdMs: times.createdMs ?? null, modifiedMs: times.modifiedMs ?? null, accessedMs: times.accessedMs ?? null });
export const fileChecksum = (path: string, kind: ChecksumKind) => invoke<string>("file_checksum", { path, kind });
export interface DupeGroup {
  readonly size: number;
  /** [path, modified ms], newest first. */
  readonly files: [string, number][];
}
/** Duplicate files under `root`; `onProgress(read, total)` bytes. Rejects with "cancelled" if stopped. */
export function findDuplicates(id: string, root: string, minSize: number, onProgress: (read: number, total: number) => void): Promise<DupeGroup[]> {
  const channel = new Channel<[number, number]>();
  channel.onmessage = ([read, total]) => onProgress(read, total);
  return invoke<DupeGroup[]>("find_duplicates", { id, root, minSize, onProgress: channel });
}
export const cancelScan = (id: string) => invoke<void>("cancel_scan", { id });
/** [path, size, modified ms]. */
export type CleanupItem = [string, number, number];
export interface CleanupReport {
  readonly totalBytes: number;
  readonly largest: CleanupItem[];
  readonly oldLarge: CleanupItem[];
  readonly emptyDirs: CleanupItem[];
  readonly junkDirs: CleanupItem[];
  readonly tempFiles: CleanupItem[];
}
export const scanCleanup = (id: string, root: string) => invoke<CleanupReport>("scan_cleanup", { id, root });
/** Tags of the items in a folder: [lower-case name, tags]. */
export const tagsInDir = (dir: string) => invoke<[string, string[]][]>("tags_in_dir", { dir });
export const setTag = (paths: string[], tag: string, on: boolean) => invoke<void>("set_tag", { paths, tag, on });
/** Every tag with how many items carry it. */
export const allTags = () => invoke<[string, number][]>("all_tags");
/** Items carrying `tag` (items that no longer exist are dropped). */
export const taggedPaths = (tag: string) => invoke<string[]>("tagged_paths", { tag });
export type GitChange = "stage" | "unstage" | "discard";
/** Stages, unstages, or discards uncommitted changes (uses the installed git). */
export const gitChange = (paths: string[], action: GitChange) => invoke<void>("git_change", { paths, action });
/** Unified diff of a file against the last commit. */
export const gitDiff = (path: string) => invoke<string>("git_diff", { path });
/** Lines in a file containing `text`: [line number, line]. */
export const contentMatches = (path: string, text: string) => invoke<[number, string][]>("content_matches", { path, text });
/** OneDrive: `keep` = always keep on this device; otherwise free up space. */
export const setCloudPin = (paths: string[], keep: boolean) => invoke<void>("set_cloud_pin", { paths, keep });

/** Paths Octopolis was started with (empty after the first call). */
export const startupPaths = () => invoke<string[]>("startup_paths");
/** Closing the window hides it to the notification area while on. */
export const setKeepInTray = (on: boolean) => invoke<void>("set_keep_in_tray", { on });
export const quitApp = () => invoke<void>("quit_app");
export type SummonKey = "off" | "ctrlE" | "ctrlAltE";
/** Sets the system-wide shortcut that brings Octopolis forward. */
export const setSummon = (mode: SummonKey) => invoke<void>("set_summon", { mode });
export type WindowCorners = "system" | "square" | "small" | "rounded";
/** Sets the main window's corner rounding preference on Windows 11. */
export const setWindowCorners = (mode: WindowCorners) => invoke<void>("set_window_corners", { mode });
/** Runs a filled-in custom action command from `cwd`, hidden or in a new console. */
/** Runs a custom action's finished command line. Hidden runs that are waited for return the exit code. */
export const runCustomAction = (command: string, cwd: string, console: boolean, shell: string, elevate: boolean, wait: boolean) => invoke<number | null>("run_custom_action", { command, cwd, console, shell, elevate, wait });
/** Saves paths, one per line, in a temp file and returns its path. */
export const writeTempList = (paths: string[]) => invoke<string>("write_temp_list", { paths });
/** Whether a program is on the PATH or exists at that path. */
export const programExists = (name: string) => invoke<boolean>("program_exists", { name });
/** Windows' Map Network Drive dialog. */
export const mapNetworkDrive = () => invoke<void>("map_network_drive");
export const disconnectNetworkDrive = (root: string, force = false) => invoke<void>("disconnect_network_drive", { root, force });
/** Roots of installed WSL distros (under wsl.localhost); empty without WSL. */
export const wslDistros = () => invoke<string[]>("wsl_distros");
/** Opens a Windows shell location (Control Panel, `shell:` names) in File Explorer. */
export const openInExplorer = (target: string) => invoke<void>("open_in_explorer", { target });
export interface ExplorerMode {
  /** Folder opens go to Octopolis. */
  readonly folders: boolean;
  readonly winE: boolean;
  /** The entries point at this copy of Octopolis. */
  readonly thisCopy: boolean;
  readonly target: string | null;
  /** The opt-in "Open in Octopolis" entry is in File Explorer's folder menu. */
  readonly menu: boolean;
}
export const explorerModeStatus = () => invoke<ExplorerMode>("explorer_mode_status");
/** Turns "Use Octopolis instead of File Explorer" on or off for this Windows account. */
export const explorerModeSet = (on: boolean) => invoke<ExplorerMode>("explorer_mode_set", { on });
/** Adds or removes "Open in Octopolis" in File Explorer's folder right-click menu. */
export const explorerMenuSet = (on: boolean) => invoke<ExplorerMode>("explorer_menu_set", { on });
/** True once after Octopolis failed to start twice and gave folders back to File Explorer. */
export const explorerFailsafeTripped = () => invoke<boolean>("explorer_failsafe_tripped");
/** Files another app asked to be shown ("Show in folder"), all in one folder a tab is showing. */
export interface ShowItems {
  readonly folder: string;
  /** Full paths. */
  readonly items: readonly string[];
}
/** Event sent when another app asks for files to be shown in a folder that is open here. */
export const SHOW_ITEMS_EVENT = "octopolis://show-items";
/** Tells Windows which folders the tabs are showing, so "Show in folder" in other apps can land here. */
export const shellWindowsSync = (paths: readonly string[]) => invoke<void>("shell_windows_sync", { paths });
/** Another app's Open or Save dialog waiting for a file picked here. */
export interface DialogPick {
  readonly title: string;
  /** Program showing the dialog, e.g. "notepad.exe"; empty if unknown. */
  readonly app: string;
  /** A Save dialog: only a folder can be sent. */
  readonly save: boolean;
}
/** Event sent when Ctrl+Shift+G is pressed in another app's Open or Save dialog. */
export const DIALOG_PICK_EVENT = "octopolis://dialog-pick";
/** Turns the Open/Save dialog shortcuts on or off; `exclude` lists programs to leave alone. */
export const dialogAssistSet = (enabled: boolean, exclude: string) => invoke<void>("dialog_assist_set", { enabled, exclude });
/** Reports the folder of the tab in front, which Ctrl+G sends a dialog to. */
export const dialogAssistFolder = (path: string) => invoke<void>("dialog_assist_folder", { path });
/** Finishes a pick: opens `files` in the waiting dialog, or sends it to `folder` when `files` is empty. */
export const dialogAssistSend = (files: readonly string[], folder: string) => invoke<void>("dialog_assist_send", { files, folder });
/** Abandons a pick and returns to the dialog. */
export const dialogAssistCancel = () => invoke<void>("dialog_assist_cancel");
/** Event sent when another launch asks this window to open paths. */
export const OPEN_PATHS_EVENT = "octopolis://open-paths";

export function watchDir(id: string, path: string, onChange: () => void): Promise<void> {
  const channel = new Channel<number>();
  channel.onmessage = () => onChange();
  return invoke<void>("watch_dir", { id, path, onChange: channel });
}

export const unwatchDir = (id: string) => invoke<void>("unwatch_dir", { id });

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Sets the window (taskbar) and tray icon from raw RGBA pixels, and remembers it for the next launch. */
export const setAppIcon = (rgba: Uint8ClampedArray | Uint8Array, width: number, height: number) =>
  invoke<void>("set_app_icon", new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), {
    headers: { width: String(width), height: String(height) },
  });

export interface SystemCleanupCategory {
  id: string;
  label: string;
  note: string;
  group: "safe" | "recycle" | "browsers" | "developer" | "windows";
  admin: boolean;
  reportOnly: boolean;
  bytes: number;
  files: number;
  folders: string[];
  /** An action whose size can't be known in advance. */
  action: boolean;
}
export interface SystemCleanupResult {
  freedBytes: number;
  freedFiles: number;
  skippedFiles: number;
  errors: string[];
}
/** Sizes the caches and leftovers that can be cleaned. Nothing is deleted. */
export const systemCleanupScan = () => invoke<SystemCleanupCategory[]>("system_cleanup_scan");
export const systemCleanupCancel = () => invoke<void>("system_cleanup_cancel");
/** Cleans the categories with these ids. Windows items ask for administrator rights. */
export const systemCleanupRun = (ids: string[]) => invoke<SystemCleanupResult>("system_cleanup_run", { ids });
export interface RuleMatch {
  path: string;
  size: number;
  modifiedMs: number;
}
/** Files a folder rule matches right now (see `ruleQuery`). Nothing is changed. */
export const ruleMatches = (folder: string, query: RuleQuery) => invoke<RuleMatch[]>("rule_matches", { folder, query });

/** Pictures under `root` that look alike (distance 0-16: lower is stricter). `onProgress(read, found)` counts pictures. */
export function findSimilarImages(id: string, root: string, maxDistance: number, onProgress: (read: number, total: number) => void): Promise<DupeGroup[]> {
  const channel = new Channel<[number, number]>();
  channel.onmessage = ([read, total]) => onProgress(read, total);
  return invoke<DupeGroup[]>("find_similar_images", { id, root, maxDistance, onProgress: channel });
}
export interface ConvertImagesResult {
  created: string[];
  errors: string[];
}
/** Writes resized and/or converted copies of pictures (originals are untouched). `format` is "same", "jpeg", "png" or "webp". */
export const convertImages = (paths: string[], maxEdge: number | null, format: string, quality: number, outDir: string | null) =>
  invoke<ConvertImagesResult>("convert_images", { paths, maxEdge, format, quality, outDir });

export interface GoogleFontFace {
  file: string;
  weight: string;
  style: string;
  subset: string;
  range: string;
  size: number;
}
export interface GoogleFontInfo {
  faces: GoogleFontFace[];
  /** True when the files are saved on this PC (they load offline). */
  saved: boolean;
  bytes: number;
}
export interface SavedFont {
  family: string;
  bytes: number;
}
/** The files of a Google font: the saved copy, this session's download, or (when `allowDownload`) a fresh download. */
export const googleFontFaces = (family: string, allowDownload: boolean) => invoke<GoogleFontInfo>("google_font_faces", { family, allowDownload });
export const googleFontBytes = (family: string, file: string) => invoke<ArrayBuffer>("google_font_bytes", { family, file });
export const googleFontSave = (family: string) => invoke<GoogleFontInfo>("google_font_save", { family });
export const googleFontRemove = (family: string) => invoke<void>("google_font_remove", { family });
export const googleFontsSaved = () => invoke<SavedFont[]>("google_fonts_saved");
export const openFontsFolder = () => invoke<void>("open_fonts_folder");
