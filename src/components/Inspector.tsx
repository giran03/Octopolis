// Side panel previewing the focused item: code, Markdown, images, SVG, PDF,
// audio with a waveform, video, 3D models, hex dumps and archive summaries.
import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import * as A from "../actions";
import { formatCount, formatDate, formatDuration, formatSize, type FileCategory } from "../lib/format";
import { formatAspectRatio } from "../lib/imageView";
import { contentTerm } from "../lib/launch";
import { summarize } from "../lib/summary";
import type { TabModel } from "../state/tab";
import { contentMatches, errorText, fileChecksum, gitDiff, previewFile, readBytes, thumbnail, type Preview } from "../lib/ipc";
import { baseOf, cloudState, isDir } from "../lib/listing";
import { boundsOf, parseObj, parseStl, type Mesh } from "../lib/model3d";
import { DEFAULT_INSPECTOR_WIDTH } from "../lib/inspector";
import { extensionOf } from "../lib/paths";
import { inspector } from "../state/inspector";
import { settings } from "../state/settings";
import { loadCachedThumb, peekThumb, thumbCacheKey, VIDEO_THUMB_PX } from "../state/thumbs";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";
import { IconClose, IconCopy, IconInfo, MaterialIcon } from "./Icons";
import { FontView, TableView, TextDetails } from "./Previews";
import { ImageViewer } from "./ImageViewer";
import { Segmented, type Option } from "./settings/controls";

type VideoMode = "thumb" | "play";
const VIDEO_MODES: readonly Option<VideoMode>[] = [
  { value: "thumb", label: "Thumbnail" },
  { value: "play", label: "Playback" },
];

const DEBOUNCE_MS = 110;
/** Rendering more lines than this at once makes the panel sluggish. */
const MAX_CODE_LINES = 4000;
const MAX_DRAWN_TRIANGLES = 40_000;

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
  svg: "image/svg+xml", pdf: "application/pdf", mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", opus: "audio/ogg",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4", mkv: "video/x-matroska",
};

interface Target {
  readonly path: string;
  readonly name: string;
  readonly dir: boolean;
  readonly modified: number;
  readonly size: number | undefined;
  /** OneDrive online-only: reading it would download it. */
  readonly online: boolean;
}

function currentTarget(): Target | null {
  const tab = workspace.activeTab();
  if (!tab) return null;
  const l = tab.listing();
  const sel = [...tab.selection()];
  const entry = sel.length === 1 ? sel[0] : tab.view()[tab.focus()];
  if (entry === undefined || entry >= l.count) return null;
  const dir = isDir(l, entry);
  return {
    path: tab.pathOf(entry),
    name: baseOf(l.names[entry]),
    dir,
    modified: l.mtimes[entry],
    size: dir ? tab.dirSizes()?.get(l.names[entry].toLowerCase()) : l.sizes[entry],
    online: cloudState(l.attrs[entry]) === "online",
  };
}

export function Inspector() {
  const [target, setTarget] = createSignal<Target | null>(null);
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [blobUrl, setBlobUrl] = createSignal<string | null>(null);
  const [bytes, setBytes] = createSignal<ArrayBuffer | null>(null);
  const [videoMode, setVideoMode] = createSignal<VideoMode>("thumb");
  const [videoLoading, setVideoLoading] = createSignal(false);
  const [videoMeta, setVideoMeta] = createSignal<{ w: number; h: number; duration: number }>({ w: 0, h: 0, duration: 0 });
  const [showMediaInfo, setShowMediaInfo] = createSignal(false);
  const [hashing, setHashing] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let token = 0;

  const release = () => {
    const u = blobUrl();
    if (u) URL.revokeObjectURL(u);
    setBlobUrl(null);
    setBytes(null);
    setVideoLoading(false);
  };
  onCleanup(() => {
    clearTimeout(timer);
    release();
  });

  async function loadMediaBytes(t: Target, mine: number) {
    setVideoLoading(true);
    try {
      const buf = await readBytes(t.path);
      if (mine !== token) return;
      setBytes(buf);
      const type = MIME[extensionOf(t.name)] ?? "application/octet-stream";
      setBlobUrl(URL.createObjectURL(new Blob([buf], { type })));
    } catch (e) {
      if (mine === token) setError(errorText(e));
    } finally {
      if (mine === token) setVideoLoading(false);
    }
  }

  async function load(t: Target) {
    const mine = ++token;
    release();
    setError(null);
    setPreview(null);
    setVideoMode("thumb");
    setVideoMeta({ w: 0, h: 0, duration: 0 });
    if (t.dir) return;
    if (t.online) return setError("This file is online only. Open it, or choose Always keep on this device, to preview it.");
    try {
      const p = await previewFile(t.path);
      if (mine !== token) return;
      setPreview(p);
      // Videos default to thumbnail only; bytes are loaded on demand if switched to Playback.
      if (["image", "svg", "pdf", "audio", "model", "font"].includes(p.kind)) {
        await loadMediaBytes(t, mine);
      }
    } catch (e) {
      if (mine === token) setError(errorText(e));
    }
  }

  const switchVideoMode = (mode: VideoMode) => {
    setVideoMode(mode);
    const t = target();
    if (mode === "play" && t && preview()?.kind === "video" && !blobUrl() && !videoLoading()) {
      void loadMediaBytes(t, token);
    }
  };

  // Follow the list focus, debounced so holding an arrow key stays smooth.
  createEffect(() => {
    const pinned = inspector.pinned();
    const t = currentTarget();
    if (pinned && target()) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (inspector.pinned() && target()) return;
      if (t?.path !== target()?.path) {
        setTarget(t);
        if (t) void load(t);
      } else setTarget(t);
    }, DEBOUNCE_MS);
  });

  const copyPath = async () => {
    const t = target();
    if (!t) return;
    await A.writeClipboardText(t.path);
    ui.toast("Copied path");
  };

  const copyContent = async () => {
    const text = preview()?.text;
    if (text == null) return;
    await A.writeClipboardText(text);
    ui.toast(preview()?.truncated ? "Copied previewed content" : "Copied content");
  };

  const copyHash = async () => {
    const t = target();
    if (!t || t.dir || t.online || hashing()) return;
    setHashing(true);
    try {
      const digest = await fileChecksum(t.path, "sha256");
      await A.writeClipboardText(digest);
      ui.toast("Copied SHA-256");
    } catch (e) {
      ui.toast(`Couldn't hash file: ${errorText(e)}`);
    } finally {
      setHashing(false);
    }
  };

  const openDefaultEditor = () => {
    const t = target();
    if (!t || t.dir) return;
    void A.editFiles([t.path]);
  };

  // Quick look: the preview fills the window; arrows step through files, Delete recycles.
  const quick = inspector.quickLook;
  const step = (d: 1 | -1) => {
    const tab = workspace.activeTab();
    if (!tab) return;
    const l = tab.listing();
    const v = tab.view();
    let pos = tab.focus();
    do pos += d;
    while (pos >= 0 && pos < v.length && isDir(l, v[pos]));
    if (pos < 0 || pos >= v.length) return;
    tab.setFocus(pos);
    tab.setSelection(new Set([v[pos]]));
  };
  createEffect(() => {
    if (!quick()) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (typing && e.key !== "Escape") return;
      const tab = workspace.activeTab();
      if (e.key === "Escape" || e.key === " ") inspector.setQuickLook(false);
      else if (e.key === "ArrowRight" || e.key === "ArrowDown") step(1);
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") step(-1);
      else if (e.key === "Delete" && tab) A.deleteSelection(tab, e.shiftKey);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });
  const close = () => (quick() ? inspector.setQuickLook(false) : settings.toggleInspector());

  const onLinkClick = (e: MouseEvent) => {
    // Links in a previewed document must not navigate the app away.
    if ((e.target as HTMLElement).closest("a")) e.preventDefault();
  };

  const isMediaViewer = () => preview()?.kind === "image" || preview()?.kind === "svg" || preview()?.kind === "video";

  const videoMetadataRows = (t: Target, p: Preview): [string, string][] => {
    const rows: [string, string][] = [];
    const vm = videoMeta();
    const detailMap = new Map(p.details ?? []);
    let w = vm.w;
    let h = vm.h;
    const headerRes = detailMap.get("Resolution");
    if ((!w || !h) && headerRes) {
      const m = /(\d+)\s*×\s*(\d+)/.exec(headerRes);
      if (m) {
        w = Number(m[1]);
        h = Number(m[2]);
      }
    }
    if (w > 0 && h > 0) {
      rows.push(["Resolution", `${w.toLocaleString()} × ${h.toLocaleString()} px`]);
      rows.push(["Aspect ratio", formatAspectRatio(w, h)]);
    } else if (headerRes) {
      rows.push(["Resolution", headerRes]);
    }
    const dur = formatDuration(vm.duration) || detailMap.get("Duration") || "";
    if (dur) rows.push(["Duration", dur]);
    const ext = extensionOf(t.name).toUpperCase();
    if (ext) rows.push(["Format", ext]);
    rows.push(["File size", formatSize(t.size ?? p.size)]);
    rows.push(["Modified", formatDate(t.modified)]);
    for (const [k, v] of p.details ?? []) {
      if (k !== "Resolution" && k !== "Duration") rows.push([k, v]);
    }
    rows.push(["Path", t.path]);
    return rows;
  };

  return (
    <div
      class="inspector-wrap"
      classList={{ quicklook: quick() }}
      style={{ "--inspector-w": `${inspector.width()}px` }}
      onMouseDown={(e) => quick() && e.target === e.currentTarget && inspector.setQuickLook(false)}
    >
      <Show when={!quick()}>
        <InspectorResizer />
      </Show>
      <Show when={quick() || (inspector.pinned() && target()) || !multiTab()} fallback={<MultiInspector tab={multiTab()!} />}>
      <aside class="inspector" classList={{ pinned: inspector.pinned() && !!target() }} aria-label={quick() ? "Quick look" : "Inspector"} aria-modal={quick() || undefined} role={quick() ? "dialog" : undefined}>
      <header class="inspector-head">
        <span class="inspector-title" title={target()?.path}>{target()?.name ?? "Nothing selected"}</span>
        <Show when={quick()}>
          <span class="muted small quicklook-hint">← → next file · Delete recycles · Esc closes</span>
        </Show>
        <Show when={target()}>
          {(t) => (
            <div class="inspector-actions">
              <button
                class="icon-btn inspector-pin"
                classList={{ on: inspector.pinned() }}
                aria-pressed={inspector.pinned()}
                aria-label={inspector.pinned() ? "Unpin inspector" : "Pin inspector"}
                data-tooltip={inspector.pinned() ? "Unpin inspector (follow selection)" : "Pin inspector to current file"}
                onClick={() => inspector.togglePinned()}
              >
                <MaterialIcon name="push_pin" fill={inspector.pinned()} size={13} />
              </button>
              <button class="icon-btn" aria-label="Copy path" data-tooltip="Copy file path" onClick={() => void copyPath()}>
                <IconCopy size={13} />
              </button>
              <Show when={!t().dir && preview()?.text != null}>
                <button
                  class="icon-btn"
                  aria-label="Copy content"
                  data-tooltip={preview()?.truncated ? "Copy previewed content" : "Copy file content"}
                  onClick={() => void copyContent()}
                >
                  <MaterialIcon name="draft" size={13} />
                </button>
              </Show>
              <Show when={!t().dir && preview()?.text == null && !t().online}>
                <button
                  class="icon-btn"
                  disabled={hashing()}
                  aria-label="Copy SHA-256 hash"
                  data-tooltip={hashing() ? "Computing SHA-256…" : "Copy SHA-256 hash"}
                  onClick={() => void copyHash()}
                >
                  <MaterialIcon name="bolt" size={13} />
                </button>
              </Show>
              <Show when={!t().dir}>
                <button class="icon-btn" aria-label="Open in default editor" data-tooltip="Open in default editor" onClick={openDefaultEditor}>
                  <MaterialIcon name="edit" size={13} />
                </button>
              </Show>
            </div>
          )}
        </Show>
        <button class="icon-btn" aria-label={quick() ? "Close quick look" : "Close inspector"} title={quick() ? "Close (Esc)" : "Close (Ctrl+I)"} onClick={close}>
          <IconClose size={13} />
        </button>
      </header>
      <Show when={target()}>
        {(t) => (
          <div class="inspector-meta">
            <span>{t().size !== undefined ? formatSize(t().size!) : t().dir ? "Folder" : formatSize(preview()?.size ?? 0)}</span>
            <span>{formatDate(t().modified)}</span>
          </div>
        )}
      </Show>
      <div class="inspector-body" classList={{ "inspector-body-flush": isMediaViewer() }} onClick={onLinkClick}>
        <Show when={target() && !target()!.dir && contentTerm(workspace.activeTab()?.search()?.query ?? "")}>
          {(term) => <ContentMatches path={target()!.path} term={term()} />}
        </Show>
        <Show when={target() && !target()!.dir && gitChanged(target()!.name)}>
          <GitDiff path={target()!.path} />
        </Show>
        <Show when={error()}>{(e) => <p class="error-text">{e()}</p>}</Show>
        <Show when={target()?.dir && target()} keyed>
          {(t) => <ThumbImage path={t.path} />}
        </Show>
        <Show when={target() && ["text", "code", "markdown", "table"].includes(preview()?.kind ?? "") && (preview()?.details.length ?? 0) > 0}>
          <TextDetails path={target()!.path} details={preview()!.details} />
        </Show>
        <Show when={preview()} keyed>
          {(p) => (
            <Switch>
              <Match when={p.kind === "code" && p.lines}>{(lines) => <CodeView lines={lines()} />}</Match>
              <Match when={p.kind === "markdown" && p.html}>{(html) => <article class="md" innerHTML={html()} />}</Match>
              <Match when={p.kind === "table" && p.text !== null && target()}>
                <TableView name={target()!.name} text={p.text!} truncated={p.truncated} />
              </Match>
              <Match when={p.kind === "font" && bytes() && target()}>
                <FontView path={target()!.path} name={target()!.name} data={bytes()!} />
              </Match>
              <Match when={(p.kind === "text" || p.kind === "code") && p.text !== null}>
                <pre class="plain">{p.text}</pre>
              </Match>
              <Match when={p.kind === "binary" && p.hex}>{(hex) => <pre class="plain hex">{hex()}</pre>}</Match>
              <Match when={(p.kind === "image" || p.kind === "svg") && blobUrl() && target()}>
                <ImageViewer
                  url={blobUrl()!}
                  target={{
                    path: target()!.path,
                    name: target()!.name,
                    modified: target()!.modified,
                    size: target()!.size ?? p.size ?? 0,
                  }}
                  isSvg={p.kind === "svg"}
                  details={p.details ?? []}
                  showInfo={showMediaInfo()}
                  onToggleInfo={() => setShowMediaInfo((v) => !v)}
                />
              </Match>
              <Match when={p.kind === "pdf" && blobUrl()}>{(u) => <iframe class="preview-pdf" src={u()} title="PDF preview" />}</Match>
              <Match when={p.kind === "video"}>
                <div class="video-viewer">
                  <div class="inspector-media-bar">
                    <Segmented label="Video preview mode" btnClass="seg-preset" value={videoMode()} options={VIDEO_MODES} onChange={switchVideoMode} />
                    <div class="media-btn-group" role="group" aria-label="Video info controls">
                      <button
                        class="media-ctrl-btn media-ctrl-text"
                        classList={{ on: showMediaInfo() }}
                        aria-pressed={showMediaInfo()}
                        data-tooltip="Video details & metadata (I)"
                        onClick={() => setShowMediaInfo((v) => !v)}
                      >
                        <IconInfo size={13} />
                        <span>Info</span>
                      </button>
                    </div>
                  </div>
                  <div
                    class="preview-media preview-media-padded"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "i" || e.key === "I") {
                        e.preventDefault();
                        e.stopPropagation();
                        setShowMediaInfo((v) => !v);
                      }
                    }}
                  >
                    <Show
                      when={videoMode() === "play"}
                      fallback={target() ? <ThumbImage path={target()!.path} modified={target()!.modified} size={VIDEO_THUMB_PX} class="preview-video-thumb" fallback="No thumbnail available" /> : null}
                    >
                      <Show when={blobUrl()} fallback={<p class="muted small">{videoLoading() ? "Loading video…" : "Video unavailable"}</p>}>
                        {(u) => (
                          <video
                            class="preview-img preview-video"
                            src={u()}
                            controls
                            onLoadedMetadata={(e) => {
                              const v = e.currentTarget;
                              setVideoMeta({
                                w: v.videoWidth,
                                h: v.videoHeight,
                                duration: Number.isFinite(v.duration) ? v.duration : 0,
                              });
                            }}
                          />
                        )}
                      </Show>
                    </Show>
                  </div>
                  <Show when={showMediaInfo() && target()}>
                    {(t) => (
                      <div class="img-details-panel" role="region" aria-label="Video details">
                        <dl class="tags img-details-grid">
                          <For each={videoMetadataRows(t(), p)}>
                            {([k, v]) => (
                              <>
                                <dt>{k}</dt>
                                <dd>{v}</dd>
                              </>
                            )}
                          </For>
                        </dl>
                      </div>
                    )}
                  </Show>
                </div>
              </Match>
              <Match when={p.kind === "audio" && blobUrl()}>{(u) => <AudioView url={u()} data={bytes()} />}</Match>
              <Match when={p.kind === "model" && bytes()}>{(b) => <ModelView data={b()} name={target()?.name ?? ""} />}</Match>
              <Match when={p.kind === "archive"}>
                <p class="muted">Archive with {(p.entries ?? 0).toLocaleString()} items. Open it to browse inside.</p>
              </Match>
            </Switch>
          )}
        </Show>
        <Show when={preview()?.truncated}>
          <p class="muted small">Showing the start of this file.</p>
        </Show>
        <Show when={!isMediaViewer() && Object.keys(preview()?.tags ?? {}).length > 0}>
          <dl class="tags">
            <For each={Object.entries(preview()!.tags)}>
              {([k, v]) => (
                <>
                  <dt>{k.split(":")[1]}</dt>
                  <dd>{v}</dd>
                </>
              )}
            </For>
          </dl>
        </Show>
      </div>
    </aside>
    </Show>
    </div>
  );
}

/** Drag the inspector's left edge to resize; double-click or Home resets it. Arrow keys nudge. */
function InspectorResizer() {
  const scale = () => settings.uiScale() / 100;
  const maxAvailable = (el: HTMLElement | null) => {
    const ws = el?.closest(".workspace") as HTMLElement | null;
    return ws ? ws.clientWidth - 220 : undefined;
  };
  const onDown = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    const startX = e.clientX;
    const startWidth = inspector.width();
    const maxW = maxAvailable(el);
    const move = (m: PointerEvent) => inspector.setWidth(startWidth + (startX - m.clientX) / scale(), maxW);
    const up = () => {
      el.classList.remove("dragging");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const onKey = (e: KeyboardEvent) => {
    const maxW = maxAvailable(e.currentTarget as HTMLElement);
    if (e.key === "ArrowLeft") inspector.setWidth(inspector.width() + 12, maxW);
    else if (e.key === "ArrowRight") inspector.setWidth(inspector.width() - 12, maxW);
    else if (e.key === "Home") inspector.setWidth(DEFAULT_INSPECTOR_WIDTH, maxW);
    else return;
    e.preventDefault();
  };
  return (
    <div
      class="inspector-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize inspector"
      aria-valuenow={inspector.width()}
      tabIndex={0}
      onPointerDown={onDown}
      onDblClick={(e) => inspector.setWidth(DEFAULT_INSPECTOR_WIDTH, maxAvailable(e.currentTarget as HTMLElement))}
      onKeyDown={onKey}
    />
  );
}

/** The active tab while two or more items are selected in it. */
const multiTab = (): TabModel | null => {
  const tab = workspace.activeTab();
  return tab && tab.selection().size > 1 ? tab : null;
};

const KIND_LABELS: Record<FileCategory, string> = {
  folder: "Folders", code: "Code", image: "Images", audio: "Audio", video: "Videos", archive: "Archives", doc: "Documents", exe: "Programs", file: "Other files",
};

/** Totals and batch actions for a multi-item selection. */
function MultiInspector(props: { tab: TabModel }) {
  const summary = createMemo(() => {
    const t = props.tab;
    const l = t.listing();
    const sizes = t.dirSizes();
    return summarize(
      [...t.selection()]
        .filter((e) => e < l.count)
        .map((e) => {
          const dir = isDir(l, e);
          return { name: baseOf(l.names[e]), dir, size: dir ? sizes?.get(l.names[e].toLowerCase()) : l.sizes[e], modified: l.mtimes[e] };
        }),
    );
  });
  const range = () => {
    const s = summary();
    if (!s.newest) return "";
    return s.oldest === s.newest ? formatDate(s.newest) : `${formatDate(s.oldest)} – ${formatDate(s.newest)}`;
  };
  const archive = () => !!props.tab.archive();

  return (
    <aside class="inspector" aria-label="Inspector">
      <header class="inspector-head">
        <span class="inspector-title">{formatCount(summary().count, "item")} selected</span>
        <button class="icon-btn" aria-label="Close inspector" title="Close (Ctrl+I)" onClick={settings.toggleInspector}>
          <IconClose size={13} />
        </button>
      </header>
      <div class="inspector-body">
        <div class="multi-total">
          <span class="multi-size">{formatSize(summary().bytes)}</span>
          <Show when={summary().unsized > 0}>
            <span class="muted small">
              + {formatCount(summary().unsized, "folder")} not measured.{" "}
              <button class="link-btn" onClick={() => props.tab.computeSizes()}>Calculate</button>
            </span>
          </Show>
        </div>
        <dl class="tags multi-facts">
          <dt>Files</dt>
          <dd>{summary().files.toLocaleString()}</dd>
          <dt>Folders</dt>
          <dd>{summary().folders.toLocaleString()}</dd>
          <Show when={range()}>
            <dt>Modified</dt>
            <dd>{range()}</dd>
          </Show>
        </dl>
        <ul class="multi-kinds">
          <For each={summary().kinds}>
            {([kind, n]) => (
              <li>
                <span class="multi-bar" style={{ width: `${(n / summary().count) * 100}%` }} />
                <span>{KIND_LABELS[kind]}</span>
                <span class="muted num">{n.toLocaleString()}</span>
              </li>
            )}
          </For>
        </ul>
        <div class="multi-actions">
          <button class="btn" disabled={archive()} onClick={() => A.openBatchRename(props.tab)}>Batch rename…</button>
          <button class="btn" onClick={() => A.addToShelf(props.tab)}>Add to shelf</button>
          <button class="btn" disabled={archive()} onClick={() => A.compressSelection(props.tab, "zip")}>Compress</button>
          <button class="btn" onClick={() => void A.copyPaths(props.tab)}>Copy paths</button>
        </div>
      </div>
    </aside>
  );
}

/** Whether the focused file has uncommitted Git changes worth diffing. */
function gitChanged(name: string): boolean {
  const s = workspace.activeTab()?.git()?.children[name.toLowerCase()];
  return s === "M" || s === "S" || s === "C";
}

const MAX_DIFF_LINES = 2000;

/** The file's changes since the last commit, colored. */
function GitDiff(props: { path: string }) {
  const [diff] = createResource(() => props.path, (p) => gitDiff(p).catch((e) => `!${errorText(e)}`));
  const lines = () => {
    const d = diff() ?? "";
    // Skip the header (diff --git, index, ---/+++) and keep hunks.
    const all = d.split(/\r?\n/);
    const start = all.findIndex((l) => l.startsWith("@@"));
    return start < 0 ? [] : all.slice(start, start + MAX_DIFF_LINES);
  };
  return (
    <Show when={diff()}>
      <section class="git-diff" aria-label="Changes since the last commit">
        <h3 class="small muted">Changes since the last commit</h3>
        <Show when={!diff()!.startsWith("!")} fallback={<p class="muted small">{diff()!.slice(1)}</p>}>
          <div class="code">
            <For each={lines()}>
              {(l) => <div class="code-line" classList={{ "diff-add": l.startsWith("+"), "diff-del": l.startsWith("-"), "diff-hunk": l.startsWith("@@") }}>{l || " "}</div>}
            </For>
          </div>
        </Show>
      </section>
    </Show>
  );
}

/** Why a `content:` search matched: the lines containing the term, highlighted. */
function ContentMatches(props: { path: string; term: string }) {
  const [lines] = createResource(() => [props.path, props.term] as const, ([path, term]) => contentMatches(path, term).catch(() => [] as [number, string][]));
  const parts = (line: string) => {
    const lower = line.toLowerCase();
    const t = props.term.toLowerCase();
    const out: { text: string; hit: boolean }[] = [];
    let at = 0;
    for (let i = lower.indexOf(t); i >= 0 && t; i = lower.indexOf(t, i + t.length)) {
      out.push({ text: line.slice(at, i), hit: false }, { text: line.slice(i, i + t.length), hit: true });
      at = i + t.length;
    }
    out.push({ text: line.slice(at), hit: false });
    return out;
  };
  return (
    <Show when={(lines() ?? []).length > 0}>
      <section class="content-hits" aria-label="Matching lines">
        <h3 class="small muted">Matching lines</h3>
        <For each={lines()}>
          {([n, text]) => (
            <div class="content-hit">
              <span class="content-line muted">{n}</span>
              <code>
                <For each={parts(text)}>{(p) => (p.hit ? <mark>{p.text}</mark> : p.text)}</For>
              </code>
            </div>
          )}
        </For>
      </section>
    </Show>
  );
}

function CodeView(props: { lines: string[] }) {
  const shown = () => props.lines.slice(0, MAX_CODE_LINES);

  return (
    <div class="code">
      <For each={shown()}>{(html) => <div class="code-line" innerHTML={html || " "} />}</For>
      <Show when={props.lines.length > MAX_CODE_LINES}>
        <div class="muted small">{(props.lines.length - MAX_CODE_LINES).toLocaleString()} more lines not shown</div>
      </Show>
    </div>
  );
}

function ThumbImage(props: { path: string; modified?: number; size?: number; class?: string; fallback?: string }) {
  const size = props.size ?? 256;
  const cached = props.modified !== undefined ? peekThumb(thumbCacheKey(props.path, props.modified, size)) : undefined;
  const [url, setUrl] = createSignal<string | null>(cached ?? null);
  const [done, setDone] = createSignal(cached !== undefined);
  let alive = true;
  let ownedUrl: string | null = null;

  if (cached === undefined) {
    if (props.modified !== undefined) {
      void loadCachedThumb(props.path, props.modified, size).then((u) => {
        if (!alive) return;
        setUrl(u);
        setDone(true);
      });
    } else {
      thumbnail(props.path, size, false).then(
        (b) => {
          if (!alive) return;
          ownedUrl = URL.createObjectURL(new Blob([b], { type: "image/png" }));
          setUrl(ownedUrl);
          setDone(true);
        },
        () => alive && setDone(true),
      );
    }
  }
  onCleanup(() => {
    alive = false;
    if (ownedUrl) URL.revokeObjectURL(ownedUrl);
  });

  return (
    <Show when={url()} fallback={done() && props.fallback ? <p class="muted small">{props.fallback}</p> : null}>
      {(u) => <img class={props.class ?? "preview-thumb"} src={u()} alt="" />}
    </Show>
  );
}

function AudioView(props: { url: string; data: ArrayBuffer | null }) {
  let canvas!: HTMLCanvasElement;
  onMount(async () => {
    if (!props.data) return;
    const ctx = new AudioContext();
    try {
      const audio = await ctx.decodeAudioData(props.data.slice(0));
      const samples = audio.getChannelData(0);
      const g = canvas.getContext("2d")!;
      const { width, height } = canvas;
      g.fillStyle = getComputedStyle(canvas).color;
      const step = Math.max(1, Math.floor(samples.length / width));
      for (let x = 0; x < width; x++) {
        let peak = 0;
        for (let i = x * step; i < (x + 1) * step && i < samples.length; i += Math.max(1, step >> 4)) peak = Math.max(peak, Math.abs(samples[i]));
        const h = Math.max(1, peak * height);
        g.fillRect(x, (height - h) / 2, 1, h);
      }
    } catch {
      // Formats the browser can't decode still play or show nothing.
    } finally {
      void ctx.close();
    }
  });

  return (
    <div class="audio">
      <canvas ref={canvas} class="wave" width="700" height="120" />
      <audio src={props.url} controls />
    </div>
  );
}

/** Software flat-shaded preview: drag to rotate, wheel to zoom. */
function ModelView(props: { data: ArrayBuffer; name: string }) {
  let canvas!: HTMLCanvasElement;
  const [info, setInfo] = createSignal("");
  let mesh: Mesh | null = null;
  let yaw = 0.6;
  let pitch = -0.4;
  let zoom = 1;

  function draw() {
    if (!mesh) return;
    const g = canvas.getContext("2d")!;
    const { width: W, height: H } = canvas;
    g.clearRect(0, 0, W, H);
    const { center, radius } = boundsOf(mesh);
    const scale = (Math.min(W, H) * 0.45 * zoom) / radius;
    const [cy, sy, cp, sp] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch)];
    const p = mesh.positions;
    const stride = Math.max(1, Math.ceil(mesh.triangles / MAX_DRAWN_TRIANGLES));
    const tris: { z: number; pts: number[]; shade: number }[] = [];
    for (let t = 0; t < mesh.triangles; t += stride) {
      const v: number[][] = [];
      for (let k = 0; k < 3; k++) {
        const i = t * 9 + k * 3;
        const x0 = p[i] - center[0], y0 = p[i + 1] - center[1], z0 = p[i + 2] - center[2];
        const x1 = cy * x0 + sy * z0, z1 = -sy * x0 + cy * z0;
        const y2 = cp * y0 - sp * z1, z2 = sp * y0 + cp * z1;
        v.push([x1, y2, z2]);
      }
      const a = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
      const b = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
      const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      tris.push({
        z: (v[0][2] + v[1][2] + v[2][2]) / 3,
        pts: v.flatMap(([x, y]) => [W / 2 + x * scale, H / 2 - y * scale]),
        shade: 0.3 + 0.7 * Math.abs(n[2] / len),
      });
    }
    tris.sort((m, q) => m.z - q.z);
    for (const t of tris) {
      const c = Math.round(120 * t.shade + 60);
      g.fillStyle = g.strokeStyle = `rgb(${c - 30} ${c} ${Math.min(255, c + 60)})`;
      g.beginPath();
      g.moveTo(t.pts[0], t.pts[1]);
      g.lineTo(t.pts[2], t.pts[3]);
      g.lineTo(t.pts[4], t.pts[5]);
      g.closePath();
      g.fill();
      g.stroke();
    }
  }

  onMount(() => {
    try {
      mesh = extensionOf(props.name) === "stl" ? parseStl(props.data) : parseObj(new TextDecoder().decode(props.data));
      setInfo(`${mesh.triangles.toLocaleString()} triangles`);
      draw();
    } catch (e) {
      setInfo(errorText(e));
    }
  });

  return (
    <div class="model">
      <canvas
        ref={canvas}
        width="700"
        height="500"
        onPointerDown={(e) => {
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          let [lx, ly] = [e.clientX, e.clientY];
          const move = (m: PointerEvent) => {
            yaw += (m.clientX - lx) * 0.01;
            pitch += (m.clientY - ly) * 0.01;
            [lx, ly] = [m.clientX, m.clientY];
            draw();
          };
          const up = () => {
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", up);
          };
          el.addEventListener("pointermove", move);
          el.addEventListener("pointerup", up);
        }}
        onWheel={(e) => {
          e.preventDefault();
          zoom = Math.min(8, Math.max(0.2, zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
          draw();
        }}
      />
      <p class="muted small">{info()} · drag to rotate, scroll to zoom</p>
    </div>
  );
}
