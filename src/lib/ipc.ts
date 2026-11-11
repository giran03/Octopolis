// Typed wrappers around the Tauri commands in src-tauri.
import { Channel, invoke } from "@tauri-apps/api/core";

export interface ListSummary {
  count: number;
  elapsedMs: number;
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
  | { kind: "delete"; paths: string[]; permanent: boolean };

export type ConflictChoice = "keepBoth" | "overwrite" | "skip";

export type OpEvent =
  | { type: "progress"; totalBytes: number; doneBytes: number; totalItems: number; doneItems: number; current: string | null }
  | { type: "done"; errors: { path: string; message: string }[]; skipped: number; created: string[]; cancelled: boolean };

export function startOp(request: OpRequest, conflict: ConflictChoice, onEvent: (e: OpEvent) => void): Promise<number> {
  const channel = new Channel<OpEvent>();
  channel.onmessage = onEvent;
  return invoke<number>("start_op", { request, conflict, onEvent: channel });
}

export const cancelOp = (id: number) => invoke<void>("cancel_op", { id });
export const renameItem = (path: string, newName: string) => invoke<string>("rename_item", { path, newName });
export const createFolder = (parent: string, name: string) => invoke<string>("create_folder", { parent, name });
export const openPath = (path: string) => invoke<void>("open_path", { path });
export const revealInExplorer = (path: string) => invoke<void>("reveal_in_explorer", { path });

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

export function watchDir(id: string, path: string, onChange: () => void): Promise<void> {
  const channel = new Channel<number>();
  channel.onmessage = () => onChange();
  return invoke<void>("watch_dir", { id, path, onChange: channel });
}

export const unwatchDir = (id: string) => invoke<void>("unwatch_dir", { id });

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
