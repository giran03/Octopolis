// Bounded LRU cache and low-priority background prefetcher for video thumbnails.
import { createEffect, onCleanup } from "solid-js";
import { categoryOf } from "../lib/format";
import { thumbnail } from "../lib/ipc";
import { baseOf, cloudState, isDir } from "../lib/listing";
import { settings } from "./settings";
import { workspace } from "./workspace";

export const VIDEO_THUMB_PX = 384;
const MAX_CACHED = 160;
const MAX_PREFETCH_PER_DIR = 48;
const SETTLE_MS = 250;
const YIELD_MS = 45;

const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

export function thumbCacheKey(path: string, modified: number, size = VIDEO_THUMB_PX): string {
  return `${path.toLowerCase()}|${modified}|${size}`;
}

/** Reads a cached object URL (or `null` if extraction previously failed), refreshing LRU order. */
export function peekThumb(key: string): string | null | undefined {
  if (!cache.has(key)) return undefined;
  const val = cache.get(key)!;
  cache.delete(key);
  cache.set(key, val);
  return val;
}

function storeThumb(key: string, url: string | null) {
  if (cache.has(key)) cache.delete(key);
  while (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const oldUrl = cache.get(oldest);
    cache.delete(oldest);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
  }
  cache.set(key, url);
}

/** Loads and caches a thumbnail, deduplicating concurrent requests for the same key. */
export function loadCachedThumb(path: string, modified: number, size = VIDEO_THUMB_PX): Promise<string | null> {
  const key = thumbCacheKey(path, modified, size);
  const hit = peekThumb(key);
  if (hit !== undefined) return Promise.resolve(hit);

  const existing = pending.get(key);
  if (existing) return existing;

  const job = thumbnail(path, size, false)
    .then(
      (buf) => {
        const url = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
        storeThumb(key, url);
        return url;
      },
      () => {
        storeThumb(key, null);
        return null;
      },
    )
    .finally(() => pending.delete(key));

  pending.set(key, job);
  return job;
}

/** Number of cached video thumbnails currently held in memory. */
export const thumbCacheCount = () => cache.size;

/** Clears cached video thumbnails (mainly for tests or cache management). */
export function clearThumbCache() {
  for (const url of cache.values()) {
    if (url) URL.revokeObjectURL(url);
  }
  cache.clear();
  pending.clear();
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(() => {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => resolve(), { timeout: 120 });
      } else {
        resolve();
      }
    }, ms);
  });

/**
 * Gently warms video thumbnails for the active directory one at a time,
 * yielding between items and cancelling immediately on navigation or hide.
 */
export function startVideoThumbPrefetch(): () => void {
  let gen = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    gen++;
    clearTimeout(settleTimer);
  };

  const runQueue = async (targets: readonly { path: string; modified: number }[], mine: number) => {
    for (const item of targets) {
      if (mine !== gen || document.hidden || !settings.showThumbnails()) return;
      const key = thumbCacheKey(item.path, item.modified, VIDEO_THUMB_PX);
      if (peekThumb(key) !== undefined) continue;
      await loadCachedThumb(item.path, item.modified, VIDEO_THUMB_PX);
      if (mine !== gen) return;
      await pause(YIELD_MS);
    }
  };

  createEffect(() => {
    stop();
    if (!settings.showThumbnails()) return;
    const tab = workspace.activeTab();
    if (!tab || tab.archive() || tab.status().loading) return;
    const l = tab.listing();
    const view = tab.view();
    if (l.count === 0 || view.length === 0) return;

    const videos: { path: string; modified: number }[] = [];
    for (let i = 0; i < view.length && videos.length < MAX_PREFETCH_PER_DIR; i++) {
      const entry = view[i];
      if (entry >= l.count || isDir(l, entry)) continue;
      if (cloudState(l.attrs[entry]) === "online") continue;
      const name = baseOf(l.names[entry]);
      if (categoryOf(name, false) !== "video") continue;
      const path = tab.pathOf(entry);
      const modified = l.mtimes[entry];
      if (peekThumb(thumbCacheKey(path, modified, VIDEO_THUMB_PX)) === undefined) {
        videos.push({ path, modified });
      }
    }
    if (videos.length === 0) return;

    const mine = ++gen;
    settleTimer = setTimeout(() => {
      if (mine === gen) void runQueue(videos, mine);
    }, SETTLE_MS);
  });

  onCleanup(stop);
  return stop;
}
