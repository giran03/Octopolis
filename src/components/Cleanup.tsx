// Cleanup assistant: biggest files, old large files, empty folders, junk folders and temp files.
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { formatDate, formatSize } from "../lib/format";
import { cancelScan, errorText, scanCleanup, type CleanupItem, type CleanupReport } from "../lib/ipc";
import { baseName, parentPath } from "../lib/paths";
import { ops } from "../state/ops";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";
import { Checkbox } from "./Checkbox";

const SCAN_ID = "cleanup";
type SectionKey = "junkDirs" | "largest" | "oldLarge" | "tempFiles" | "emptyDirs";
const SECTIONS: readonly { key: SectionKey; title: string; note: string }[] = [
  { key: "junkDirs", title: "Rebuildable folders", note: "Dependencies, build output and caches. Tools recreate them when needed." },
  { key: "largest", title: "Largest files", note: "The 50 biggest files." },
  { key: "oldLarge", title: "Large files not changed in a year", note: "Over 50 MB." },
  { key: "tempFiles", title: "Temporary files", note: "Leftover .tmp, .bak, ~$ files and similar." },
  { key: "emptyDirs", title: "Empty folders", note: "Folders with no files at any depth." },
];

export function Cleanup(props: { root: string }) {
  const [report, setReport] = createSignal<CleanupReport | null>(null);
  const [scanning, setScanning] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set());
  const [open, setOpen] = createSignal<SectionKey>("junkDirs");
  onCleanup(() => void cancelScan(SCAN_ID).catch(() => undefined));

  const scan = async () => {
    setScanning(true);
    setError(null);
    setPicked(new Set<string>());
    try {
      setReport(await scanCleanup(SCAN_ID, props.root));
    } catch (e) {
      if (errorText(e) !== "cancelled") setError(errorText(e));
    } finally {
      setScanning(false);
    }
  };
  void scan();

  const sizeOf = createMemo(() => {
    const m = new Map<string, number>();
    const r = report();
    if (r) for (const s of SECTIONS) for (const [p, size] of r[s.key]) m.set(p, size);
    return m;
  });
  const pickedBytes = () => [...picked()].reduce((s, p) => s + (sizeOf().get(p) ?? 0), 0);
  const toggle = (p: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  const pickAll = (items: readonly CleanupItem[], on: boolean) =>
    setPicked((s) => {
      const next = new Set(s);
      for (const [p] of items) if (on) next.add(p);
      else next.delete(p);
      return next;
    });
  const recycle = () => {
    const paths = [...picked()];
    // A folder and something inside it: recycling the folder is enough.
    const outer = paths.filter((p) => !paths.some((q) => q !== p && p.toLowerCase().startsWith(`${q.toLowerCase()}\\`)));
    if (!outer.length) return;
    ops.remove(outer, false);
    setReport((r) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Array.isArray(v) ? v.filter(([p]) => !picked().has(p)) : v])) as unknown as CleanupReport : r));
    setPicked(new Set<string>());
  };
  const reveal = (p: string) => {
    const dir = parentPath(p);
    if (!dir) return;
    ui.setCleanupRoot(null);
    void workspace.activeTab()?.navigate(dir, [baseName(p)]);
  };
  const close = () => ui.setCleanupRoot(null);

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="dialog bin-dialog dupes-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cleanup-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") close();
        }}
      >
        <div class="bin-head">
          <h2 id="cleanup-title">Clean up</h2>
          <span class="muted small" title={props.root}>
            {baseName(props.root) || props.root}
            <Show when={report()}>{(r) => ` · ${formatSize(r().totalBytes)} in all`}</Show>
          </span>
        </div>
        <Show when={!scanning()} fallback={<p class="muted">Looking through every folder… <button class="link-btn" onClick={() => void cancelScan(SCAN_ID)}>Stop</button></p>}>
          <Show when={error()}>{(e) => <p class="error-text">{e()}</p>}</Show>
          <Show when={report()}>
            {(r) => (
              <div class="cleanup-body">
                <nav class="cleanup-nav" aria-label="Kinds">
                  <For each={SECTIONS}>
                    {(s) => (
                      <button class="side-item" classList={{ current: open() === s.key }} onClick={() => setOpen(s.key)}>
                        <span class="side-label">{s.title}</span>
                        <span class="side-count">{r()[s.key].length}</span>
                      </button>
                    )}
                  </For>
                </nav>
                <div class="cleanup-list">
                  <For each={SECTIONS.filter((s) => s.key === open())}>
                    {(s) => (
                      <>
                        <div class="dupes-summary small">
                          <span class="muted">{s.note}</span>
                          <Show when={r()[s.key].length > 0 && s.key !== "largest"}>
                            <span class="dupes-picks">
                              <button class="link-btn" onClick={() => pickAll(r()[s.key], true)}>Select all</button>
                              <button class="link-btn" onClick={() => pickAll(r()[s.key], false)}>None</button>
                            </span>
                          </Show>
                        </div>
                        <div class="bin-list">
                          <For each={r()[s.key]} fallback={<p class="muted bin-empty">Nothing here</p>}>
                            {([p, size, modified]) => (
                              <label class="dupe-file" onDblClick={() => reveal(p)} title="Double-click to show it in its folder">
                                <Checkbox checked={picked().has(p)} onChange={() => toggle(p)} />
                                <span class="bin-names">
                                  <span class="bin-name">{baseName(p)}</span>
                                  <span class="muted small bin-from">{parentPath(p)}</span>
                                </span>
                                <span class="muted small bin-meta">{s.key === "emptyDirs" ? formatDate(modified) : formatSize(size)}</span>
                              </label>
                            )}
                          </For>
                        </div>
                      </>
                    )}
                  </For>
                </div>
              </div>
            )}
          </Show>
        </Show>
        <div class="dialog-actions bin-actions">
          <span class="muted small">{picked().size ? `${picked().size} selected · ${formatSize(pickedBytes())}` : ""}</span>
          <span class="bin-spacer" />
          <button class="btn" disabled={scanning()} onClick={() => void scan()}>Scan again</button>
          <button class="btn" onClick={close}>Close</button>
          <button class="btn primary" disabled={picked().size === 0} onClick={recycle}>
            Move to Recycle Bin
          </button>
        </div>
      </div>
    </div>
  );
}
