// Duplicate finder: groups of identical files under a folder; recycle the extra copies.
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { formatDate, formatSize } from "../lib/format";
import { cancelScan, errorText, findDuplicates, findSimilarImages, type DupeGroup } from "../lib/ipc";
import { baseName, parentPath } from "../lib/paths";
import { extrasToRemove } from "../lib/summary";
import { ops } from "../state/ops";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";

const SCAN_ID = "duplicates";
const MIN_SIZES: readonly { bytes: number; label: string }[] = [
  { bytes: 1, label: "Any size" },
  { bytes: 1024 * 1024, label: "1 MB or more" },
  { bytes: 10 * 1024 * 1024, label: "10 MB or more" },
  { bytes: 100 * 1024 * 1024, label: "100 MB or more" },
];
/** Groups shown at most; the biggest waste comes first. */
const MAX_GROUPS = 300;

const SIMILARITY: readonly { distance: number; label: string }[] = [
  { distance: 4, label: "Very similar" },
  { distance: 8, label: "Similar" },
  { distance: 12, label: "Loosely similar" },
];

export function Duplicates(props: { root: string }) {
  const [mode, setMode] = createSignal<"identical" | "pictures">("identical");
  const [distance, setDistance] = createSignal(8);
  const [minSize, setMinSize] = createSignal(1024 * 1024);
  const [groups, setGroups] = createSignal<readonly DupeGroup[] | null>(null);
  const [progress, setProgress] = createSignal<[number, number] | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set());
  const scanning = () => progress() !== null;
  onCleanup(() => void cancelScan(SCAN_ID).catch(() => undefined));

  const scan = async () => {
    setError(null);
    setGroups(null);
    setPicked(new Set<string>());
    setProgress([0, 0]);
    try {
      const onProgress = (read: number, total: number) => setProgress([read, total]);
      setGroups(mode() === "pictures" ? await findSimilarImages(SCAN_ID, props.root, distance(), onProgress) : await findDuplicates(SCAN_ID, props.root, minSize(), onProgress));
    } catch (e) {
      if (errorText(e) !== "cancelled") setError(errorText(e));
    } finally {
      setProgress(null);
    }
  };

  const wasted = createMemo(() => (groups() ?? []).reduce((s, g) => s + g.size * (g.files.length - 1), 0));
  const pickedBytes = createMemo(() => (groups() ?? []).reduce((s, g) => s + g.files.filter(([p]) => picked().has(p)).length * g.size, 0));
  const toggle = (path: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  /** True when a group would lose every copy. */
  const wipesGroup = () => (groups() ?? []).some((g) => g.files.every(([p]) => picked().has(p)));

  const recycle = () => {
    const paths = [...picked()];
    if (!paths.length) return;
    ops.remove(paths, false);
    setGroups((gs) => (gs ?? []).map((g) => ({ ...g, files: g.files.filter(([p]) => !picked().has(p)) })).filter((g) => g.files.length > 1));
    setPicked(new Set<string>());
  };
  const reveal = (path: string) => {
    const dir = parentPath(path);
    if (!dir) return;
    ui.setDuplicatesRoot(null);
    void workspace.activeTab()?.navigate(dir, [baseName(path)]);
  };
  const close = () => ui.setDuplicatesRoot(null);

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="dialog bin-dialog dupes-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dupes-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") close();
        }}
      >
        <div class="bin-head">
          <h2 id="dupes-title">Duplicate files</h2>
          <span class="muted small" title={props.root}>in {baseName(props.root) || props.root} and its subfolders</span>
        </div>
        <div class="dupes-bar">
          <select class="conflict-choice" aria-label="What to look for" value={mode()} disabled={scanning()} onChange={(e) => { setMode(e.currentTarget.value as "identical" | "pictures"); setGroups(null); setPicked(new Set<string>()); }}>
            <option value="identical">Identical files</option>
            <option value="pictures">Similar pictures</option>
          </select>
          <Show
            when={mode() === "pictures"}
            fallback={
              <select class="conflict-choice" aria-label="Smallest file to compare" value={minSize()} disabled={scanning()} onChange={(e) => setMinSize(Number(e.currentTarget.value))}>
                <For each={MIN_SIZES}>{(m) => <option value={m.bytes}>{m.label}</option>}</For>
              </select>
            }
          >
            <select class="conflict-choice" aria-label="How alike" value={distance()} disabled={scanning()} onChange={(e) => setDistance(Number(e.currentTarget.value))}>
              <For each={SIMILARITY}>{(s) => <option value={s.distance}>{s.label}</option>}</For>
            </select>
          </Show>
          <Show when={!scanning()} fallback={<button class="btn" onClick={() => void cancelScan(SCAN_ID)}>Stop</button>}>
            <button class="btn primary" onClick={() => void scan()}>{groups() ? "Scan again" : "Find duplicates"}</button>
          </Show>
          <Show when={progress()}>
            {(p) => (
              <span class="dupes-progress">
                <span class="usage"><span style={{ width: `${p()[1] ? (p()[0] / p()[1]) * 100 : 0}%` }} /></span>
                <span class="muted small">{p()[1] ? (mode() === "pictures" ? `Looking at picture ${p()[0].toLocaleString()} of ${p()[1].toLocaleString()}` : `Comparing ${formatSize(p()[0])} of ${formatSize(p()[1])}`) : "Listing files…"}</span>
              </span>
            )}
          </Show>
        </div>
        <Show when={error()}>{(e) => <p class="error-text">{e()}</p>}</Show>
        <Show when={groups()}>
          {(gs) => (
            <Show when={gs().length > 0} fallback={<p class="muted bin-empty">No duplicates found</p>}>
              <div class="dupes-summary small">
                <span>
                  {gs().length.toLocaleString()} groups · {formatSize(wasted())} could be freed
                </span>
                <span class="dupes-picks">
                  Select extra copies, keeping the
                  <button class="link-btn" onClick={() => setPicked(extrasToRemove(gs(), "newest"))}>newest</button>
                  or
                  <button class="link-btn" onClick={() => setPicked(extrasToRemove(gs(), "oldest"))}>oldest</button>
                </span>
              </div>
              <div class="bin-list">
                <For each={gs().slice(0, MAX_GROUPS)}>
                  {(g) => (
                    <div class="dupe-group">
                      <div class="dupe-head muted small">
                        {mode() === "pictures" ? `${g.files.length} similar pictures · up to ${formatSize(g.size)}` : `${g.files.length} copies · ${formatSize(g.size)} each`}
                      </div>
                      <For each={g.files}>
                        {([path, modified]) => (
                          <label class="dupe-file" onDblClick={() => reveal(path)} title="Double-click to show it in its folder">
                            <input type="checkbox" checked={picked().has(path)} onChange={() => toggle(path)} />
                            <span class="bin-names">
                              <span class="bin-name">{baseName(path)}</span>
                              <span class="muted small bin-from">{parentPath(path)}</span>
                            </span>
                            <span class="muted small bin-meta">{formatDate(modified)}</span>
                          </label>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          )}
        </Show>
        <Show when={wipesGroup()}>
          <p class="conflict-warn small">Every copy in at least one group is selected, so those files would be gone (they go to the Recycle Bin).</p>
        </Show>
        <div class="dialog-actions bin-actions">
          <span class="muted small">{picked().size ? `${picked().size} selected · ${formatSize(pickedBytes())}` : ""}</span>
          <span class="bin-spacer" />
          <button class="btn" onClick={close}>Close</button>
          <button class="btn primary" disabled={picked().size === 0} onClick={recycle}>
            Move to Recycle Bin
          </button>
        </div>
      </div>
    </div>
  );
}
