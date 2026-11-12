import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { formatSize } from "../../lib/format";
import { cacheInfo, clearCache, openCacheFolder, openDataFolder, openLogFolder, pickCacheFolder, setCacheDir, type CacheInfo } from "../../lib/ipc";
import { clearGridThumbs, gridThumbBytes, gridThumbCount } from "../Extras";
import { folderIcons } from "../../state/folderIcons";
import { history } from "../../state/history";
import { clearIconCache, iconCacheCount } from "../../state/icons";
import { sanitizeSettings, settings } from "../../state/settings";
import { shelf } from "../../state/shelf";
import { clearSessionSizes, sessionSizeCount } from "../../state/tab";
import { clearThumbCache, thumbCacheBytes, thumbCacheCount } from "../../state/thumbs";
import { ui } from "../../state/ui";
import { ActionButton, Section, SettingRow } from "./controls";

const failed = (what: string) => (e: unknown) => ui.toast(`Couldn't ${what}: ${typeof e === "string" ? e : e instanceof Error ? e.message : "unknown error"}`);

export function AdvancedTab() {
  const [json, setJson] = createSignal("");
  const [cache, { mutate: setCache, refetch: refetchCache }] = createResource<CacheInfo | null>(() => cacheInfo().catch(() => null));
  const [cachePathInput, setCachePathInput] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [memTick, setMemTick] = createSignal(0);

  createEffect(() => {
    const info = cache();
    if (info) setCachePathInput(info.dir);
  });

  const thumbCount = () => {
    void memTick();
    return thumbCacheCount() + gridThumbCount();
  };
  const thumbBytes = () => {
    void memTick();
    return thumbCacheBytes() + gridThumbBytes();
  };
  const iconCount = () => {
    void memTick();
    return iconCacheCount();
  };
  const sessionCount = () => {
    void memTick();
    return sessionSizeCount();
  };

  const applyCacheDir = async (next: string | null) => {
    setBusy(true);
    try {
      const updated = await setCacheDir(next);
      setCache(updated);
      setCachePathInput(updated.dir);
      ui.toast(next ? `Cache moved to ${updated.dir}` : "Cache folder reset to default");
    } catch (e) {
      failed("move the cache folder")(e);
    } finally {
      setBusy(false);
    }
  };

  const browseCacheDir = async () => {
    try {
      const picked = await pickCacheFolder();
      if (picked) await applyCacheDir(picked);
    } catch (e) {
      failed("choose a folder")(e);
    }
  };

  const clearFrontend = (what: "thumbs" | "icons" | "session" | "all") => {
    if (what === "thumbs" || what === "all") {
      clearThumbCache();
      clearGridThumbs();
    }
    if (what === "icons" || what === "all") clearIconCache();
    if (what === "session" || what === "all") clearSessionSizes();
    setMemTick((n) => n + 1);
  };

  const clearBackend = async (scope: "sizes" | "updates" | "search" | "all", label: string) => {
    setBusy(true);
    try {
      const updated = await clearCache(scope);
      setCache(updated);
      if (scope === "sizes" || scope === "all") clearFrontend(scope === "all" ? "all" : "session");
      ui.toast(label);
    } catch (e) {
      failed("clear cache")(e);
    } finally {
      setBusy(false);
    }
  };

  const copySettings = () => {
    navigator.clipboard.writeText(JSON.stringify(settings.snapshot(), null, 2)).then(
      () => ui.toast("Settings copied to the clipboard"),
      failed("copy settings"),
    );
  };

  const importSettings = () => {
    try {
      const clean = sanitizeSettings(JSON.parse(json()));
      const count = Object.keys(clean).length;
      if (count === 0) return ui.toast("No settings found in that text");
      settings.set(clean);
      setJson("");
      ui.toast(`Imported ${count} setting${count === 1 ? "" : "s"}`);
    } catch {
      ui.toast("That is not valid JSON");
    }
  };

  return (
    <>
      <Section title="Your data" note="Everything Octopolis remembers stays on this PC. There are no accounts and no tracking.">
        <SettingRow label="Settings folder" hint="Where Octopolis keeps its preferences and app data">
          <button class="btn small" onClick={() => void openDataFolder().catch(failed("open the folder"))}>
            Open folder
          </button>
        </SettingRow>
        <SettingRow label="Diagnostics log" hint="Startup times and errors, to attach to a bug report. File and folder names are left out, and it never leaves this PC">
          <button class="btn small" onClick={() => void openLogFolder().catch(failed("open the log folder"))}>
            Open log folder
          </button>
        </SettingRow>
        <SettingRow label="Back up settings" hint="Copies every setting as JSON you can keep or move to another PC">
          <button class="btn small" onClick={copySettings}>
            Copy settings
          </button>
        </SettingRow>
        <SettingRow label="Restore settings" hint="Paste JSON you copied earlier. Unknown or invalid values are ignored" stacked>
          <textarea class="text-input mono" rows="3" spellcheck={false} placeholder="Settings JSON" value={json()} onInput={(e) => setJson(e.currentTarget.value)} />
          <div class="srow-actions">
            <button class="btn small" disabled={!json().trim()} onClick={importSettings}>
              Import settings
            </button>
          </div>
        </SettingRow>
      </Section>

      <Section title="Cache management" note="Inspect, relocate or clear cached folder sizes, update downloads and in-memory previews.">
        <SettingRow
          label="Cache folder"
          hint={
            cache()
              ? `${cache()!.isCustom ? "Custom location" : "Default location"} · ${formatSize(cache()!.totalDiskBytes)} on disk`
              : "Reading cache location…"
          }
          stacked
        >
          <input
            class="text-input wide"
            spellcheck={false}
            placeholder="Cache folder path"
            disabled={busy() || !cache()}
            value={cachePathInput()}
            onInput={(e) => setCachePathInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && cachePathInput().trim() && cachePathInput().trim() !== cache()?.dir) {
                void applyCacheDir(cachePathInput().trim());
              }
            }}
          />
          <div class="cache-actions">
            <button class="btn small" disabled={busy()} onClick={() => void openCacheFolder().catch(failed("open the cache folder"))}>
              Open cache folder
            </button>
            <button class="btn small" disabled={busy()} onClick={() => void browseCacheDir()}>
              Re-route…
            </button>
            <Show when={cachePathInput().trim() && cachePathInput().trim() !== cache()?.dir}>
              <button class="btn small primary" disabled={busy()} onClick={() => void applyCacheDir(cachePathInput().trim())}>
                Move cache
              </button>
            </Show>
            <Show when={cache()?.isCustom}>
              <button class="btn small" disabled={busy()} onClick={() => void applyCacheDir(null)}>
                Reset default
              </button>
            </Show>
            <span class="spacer" />
            <button class="btn small" disabled={busy()} onClick={() => { setMemTick((n) => n + 1); void refetchCache(); }}>
              Refresh
            </button>
          </div>
        </SettingRow>

        <Show when={cache()}>
          {(info) => (
            <div class="srow stacked">
              <div class="srow-text">
                <div class="srow-label">What's cached</div>
                <div class="srow-hint">Disk files live in your cache folder; memory caches are size-limited, freed when idle and empty on close. Thumbnails aren't saved to disk: Windows already keeps its own thumbnail cache</div>
              </div>
              <div class="cache-list">
                <For each={info().items}>
                  {(item) => (
                    <div class="cache-item">
                      <div class="cache-item-info">
                        <span class="cache-item-name">{item.label}</span>
                        <span class="cache-item-detail">{item.detail}</span>
                      </div>
                      <span class="cache-item-size num">
                        {item.kind === "disk" ? formatSize(item.bytes) : item.bytes > 0 ? `${formatSize(item.bytes)} in memory` : "In memory"}
                      </span>
                      <button
                        class="btn small"
                        disabled={busy() || (item.bytes === 0 && item.count === 0)}
                        onClick={() => void clearBackend(item.id, `${item.label} cleared`)}
                      >
                        Clear
                      </button>
                    </div>
                  )}
                </For>

                <div class="cache-item">
                  <div class="cache-item-info">
                    <span class="cache-item-name">Video & grid thumbnails</span>
                    <span class="cache-item-detail">
                      {thumbCount() === 0 ? "No thumbnails cached" : `${thumbCount().toLocaleString()} thumbnail${thumbCount() === 1 ? "" : "s"} in memory`}
                    </span>
                  </div>
                  <span class="cache-item-size num">{thumbBytes() > 0 ? `${formatSize(thumbBytes())} in memory` : "In memory"}</span>
                  <button
                    class="btn small"
                    disabled={busy() || thumbCount() === 0}
                    onClick={() => (clearFrontend("thumbs"), ui.toast("Thumbnail cache cleared"))}
                  >
                    Clear
                  </button>
                </div>

                <div class="cache-item">
                  <div class="cache-item-info">
                    <span class="cache-item-name">Shell file icons</span>
                    <span class="cache-item-detail">
                      {iconCount() === 0 ? "No icons cached" : `${iconCount().toLocaleString()} icon type${iconCount() === 1 ? "" : "s"} in memory`}
                    </span>
                  </div>
                  <span class="cache-item-size num">In memory</span>
                  <button
                    class="btn small"
                    disabled={busy() || iconCount() === 0}
                    onClick={() => (clearFrontend("icons"), ui.toast("Icon cache cleared"))}
                  >
                    Clear
                  </button>
                </div>

                <div class="cache-item">
                  <div class="cache-item-info">
                    <span class="cache-item-name">Session folder sizes</span>
                    <span class="cache-item-detail">
                      {sessionCount() === 0 ? "No folders cached this session" : `${sessionCount().toLocaleString()} folder${sessionCount() === 1 ? "" : "s"} in memory`}
                    </span>
                  </div>
                  <span class="cache-item-size num">In memory</span>
                  <button
                    class="btn small"
                    disabled={busy() || sessionCount() === 0}
                    onClick={() => (clearFrontend("session"), ui.toast("Session folder sizes cleared"))}
                  >
                    Clear
                  </button>
                </div>
              </div>
            </div>
          )}
        </Show>

        <SettingRow label="Clear all caches" hint="Deletes cached folder sizes, downloaded update installers, search index and thumbnail caches">
          <ActionButton
            danger
            label="Clear all"
            confirm="Press again to clear"
            disabled={busy()}
            onClick={() => void clearBackend("all", "All caches cleared")}
          />
        </SettingRow>
      </Section>

      <Section title="Clean up">
        <SettingRow label="Folder rules" hint="Move or delete old files that match name patterns, like PDFs untouched for 30 days in Downloads. You preview every run">
          <button class="btn" onClick={() => (ui.closeSettings(), ui.setRulesOpen(true))}>Open…</button>
        </SettingRow>
        <SettingRow label="Free up space" hint="Find caches, Windows Update leftovers, browser caches and the Recycle Bin that are safe to delete. Nothing is removed until you confirm">
          <button class="btn" onClick={() => (ui.closeSettings(), ui.setSystemCleanupOpen(true))}>Open…</button>
        </SettingRow>
        <SettingRow label="Recent folders" hint="Clears the Recent list and what Ctrl+P learned about the folders you visit">
          <ActionButton label="Clear" confirm="Press again to clear" onClick={() => (history.clear(), ui.toast("Recent folders cleared"))} />
        </SettingRow>
        <SettingRow label="Folder icons" hint={folderIcons.count() === 0 ? "No folders have a custom emoji icon. Right-click a folder and choose Change icon" : `${folderIcons.count()} folder${folderIcons.count() === 1 ? "" : "s"} with a custom emoji icon`}>
          <ActionButton label="Reset all" confirm="Press again to reset" disabled={folderIcons.count() === 0} onClick={() => (folderIcons.clear(), ui.toast("Folder icons reset"))} />
        </SettingRow>
        <SettingRow label="Shelf" hint={shelf.items().length === 0 ? "The shelf is empty" : `${shelf.items().length} item${shelf.items().length === 1 ? "" : "s"} waiting on the shelf`}>
          <ActionButton label="Empty shelf" confirm="Press again to empty" disabled={shelf.items().length === 0} onClick={shelf.clear} />
        </SettingRow>
      </Section>

      <Section title="Reset">
        <SettingRow label="Reset all settings" hint="Puts every setting back to a fresh install's. Pinned folders, the shelf and your shortcuts stay">
          <ActionButton danger label="Reset" confirm="Press again to reset" onClick={() => (settings.reset(), ui.toast("All settings were reset"))} />
        </SettingRow>
      </Section>
    </>
  );
}
