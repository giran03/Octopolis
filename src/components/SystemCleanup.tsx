// Free up space: system caches, Windows leftovers and the Recycle Bin that are safe to delete.
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { formatSize } from "../lib/format";
import { errorText, listDrives, openExternal, systemCleanupCancel, systemCleanupRun, systemCleanupScan, type SystemCleanupCategory, type SystemCleanupResult } from "../lib/ipc";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";
import { IconMop } from "./Icons";

type Group = SystemCleanupCategory["group"];
const GROUPS: readonly { id: Group; title: string; note: string }[] = [
  { id: "safe", title: "Safe to delete", note: "Programs and Windows rebuild these on their own." },
  { id: "recycle", title: "Recycle Bin", note: "Deleted for good, so you can't restore these afterwards." },
  { id: "browsers", title: "Browsers", note: "Page caches only. Sign-ins, history and bookmarks stay." },
  { id: "developer", title: "Developer caches", note: "Downloaded again or rebuilt next time, so the first build is slower." },
  { id: "windows", title: "Windows", note: "Needs administrator rights. Windows asks once for all of these." },
];

/** The last scan, shown at once on the next open while a fresh one runs. */
let lastScan: SystemCleanupCategory[] = [];

export function SystemCleanup() {
  const [cats, setCats] = createSignal<SystemCleanupCategory[]>(lastScan);
  const [scanning, setScanning] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set());
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = createSignal(false);
  const [running, setRunning] = createSignal(false);
  const [result, setResult] = createSignal<SystemCleanupResult | null>(null);
  const [free, setFree] = createSignal<{ before: number; after: number | null } | null>(null);
  onCleanup(() => void systemCleanupCancel().catch(() => undefined));

  const systemFree = async () => {
    const drives = await listDrives().catch(() => []);
    return (drives.find((d) => d.root.toUpperCase().startsWith("C:")) ?? drives.find((d) => d.kind === "fixed"))?.freeBytes ?? null;
  };

  const scan = async (keepResult = false) => {
    setScanning(true);
    setError(null);
    if (!keepResult) setResult(null);
    try {
      const found = await systemCleanupScan();
      lastScan = found;
      setCats(found);
      // Only the always-safe group starts ticked.
      setPicked(new Set(found.filter((c) => c.group === "safe" && c.bytes > 0).map((c) => c.id)));
    } catch (e) {
      if (errorText(e) !== "cancelled") setError(errorText(e));
    } finally {
      setScanning(false);
    }
  };
  void scan();

  const byId = createMemo(() => new Map(cats().map((c) => [c.id, c])));
  const selectable = (c: SystemCleanupCategory) => !c.reportOnly && (c.action || c.bytes > 0);
  const chosen = () => [...picked()].map((id) => byId().get(id)).filter((c): c is SystemCleanupCategory => !!c);
  const pickedBytes = () => chosen().reduce((s, c) => s + c.bytes, 0);
  const reclaimable = () => cats().filter((c) => !c.reportOnly && !c.action).reduce((s, c) => s + c.bytes, 0);
  const needsAdmin = () => chosen().some((c) => c.admin);
  const includesBin = () => picked().has("recycle-bin");

  const flip = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  const groupSelect = (group: Group, on: boolean) =>
    setPicked((s) => {
      const next = new Set(s);
      for (const c of cats().filter((c) => c.group === group && selectable(c))) {
        if (on) next.add(c.id);
        else next.delete(c.id);
      }
      return next;
    });

  const run = async () => {
    setConfirming(false);
    setRunning(true);
    setError(null);
    try {
      const before = await systemFree();
      const r = await systemCleanupRun([...picked()]);
      setResult(r);
      const after = await systemFree();
      setFree(before !== null ? { before, after } : null);
      await scan(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRunning(false);
    }
  };

  const showFolder = (path: string) => {
    ui.setSystemCleanupOpen(false);
    void workspace.activeTab()?.navigate(path);
  };
  const close = () => ui.setSystemCleanupOpen(false);
  const busy = () => scanning() || running();

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && !running() && close()}>
      <div
        class="dialog bin-dialog dupes-dialog sc-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sc-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" && !running()) close();
        }}
      >
        <div class="sc-progress" classList={{ on: busy() }} role="progressbar" aria-label={running() ? "Cleaning" : "Measuring"} aria-hidden={!busy()}>
          <span />
        </div>
        <div class="bin-head">
          <h2 id="sc-title" class="sc-title">
            <IconMop size={18} class={busy() ? "sc-mop busy" : "sc-mop"} /> Free up space
          </h2>
          <span class="muted small">
            <Show when={!scanning()} fallback="Measuring…">
              {formatSize(reclaimable())} can be cleaned
            </Show>
          </span>
        </div>

        <Show when={error()}>{(e) => <p class="error-text">{e()}</p>}</Show>
        <Show when={result()}>
          {(r) => (
            <div class="sc-result" role="status">
              <strong>Freed {formatSize(r().freedBytes)}</strong>
              <Show when={free()?.after != null}>
                <span class="muted small"> · free space on the system drive: {formatSize(free()!.before)} → {formatSize(free()!.after!)}</span>
              </Show>
              <Show when={r().skippedFiles > 0}>
                <div class="muted small">{r().skippedFiles} file{r().skippedFiles === 1 ? " was" : "s were"} in use or too new, and left alone.</div>
              </Show>
              <For each={r().errors}>{(m) => <div class="error-text small">{m}</div>}</For>
            </div>
          )}
        </Show>

        <div class="sc-body" classList={{ busy: busy() && cats().length > 0 }} aria-busy={busy()}>
          <Show when={scanning() && cats().length === 0}>
            <p class="muted">Looking for caches and leftovers… <button class="link-btn" onClick={() => void systemCleanupCancel()}>Stop</button></p>
            <For each={[4, 3, 5]}>
              {(rows) => (
                <div class="bin-list sc-list sc-skel" aria-hidden="true">
                  <For each={Array.from({ length: rows })}>
                    {() => (
                      <div class="sc-skel-row">
                        <span class="sc-skel-box" />
                        <span class="sc-skel-lines">
                          <span class="sc-skel-bar" />
                          <span class="sc-skel-bar short" />
                        </span>
                        <span class="sc-skel-bar size" />
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </Show>
          <For each={GROUPS}>
            {(g) => {
              const rows = () => cats().filter((c) => c.group === g.id && (c.bytes > 0 || c.action || c.reportOnly));
              return (
                <Show when={rows().length > 0}>
                  <section class="sc-group">
                    <div class="dupes-summary small">
                      <span>
                        <strong>{g.title}</strong> <span class="muted">· {g.note}</span>
                      </span>
                      <span class="dupes-picks">
                        <button class="link-btn" disabled={busy()} onClick={() => groupSelect(g.id, true)}>Select all</button>
                        <button class="link-btn" disabled={busy()} onClick={() => groupSelect(g.id, false)}>None</button>
                      </span>
                    </div>
                    <div class="bin-list sc-list">
                      <For each={rows()}>
                        {(c) => (
                          <div class="sc-item">
                            <label class="sc-row" classList={{ off: !selectable(c) }}>
                              <input type="checkbox" disabled={!selectable(c) || busy()} checked={picked().has(c.id)} onChange={() => setPicked((s) => flip(s, c.id))} />
                              <span class="bin-names">
                                <span class="bin-name">
                                  {c.label}
                                  <Show when={c.admin}>
                                    <span class="sc-tag" title="Windows asks for administrator rights">Admin</span>
                                  </Show>
                                </span>
                                <span class="muted small sc-note">{c.note}</span>
                              </span>
                              <span class="muted small bin-meta">{c.action ? "Size unknown" : formatSize(c.bytes)}</span>
                            </label>
                            <Show when={c.reportOnly}>
                              <div class="sc-extra">
                                <button class="link-btn" onClick={() => void openExternal("ms-settings:storagesense").catch((e) => setError(errorText(e)))}>
                                  Open Windows Storage settings
                                </button>
                              </div>
                            </Show>
                            <Show when={c.folders.length > 0}>
                              <div class="sc-extra">
                                <button class="link-btn" onClick={() => setOpen((s) => flip(s, c.id))}>
                                  {open().has(c.id) ? "Hide" : "Show"} folders ({c.folders.length}) · {c.files.toLocaleString()} file{c.files === 1 ? "" : "s"}
                                </button>
                                <Show when={open().has(c.id)}>
                                  <For each={c.folders}>
                                    {(f) => (
                                      <button class="link-btn sc-folder" title="Open this folder" onClick={() => showFolder(f)}>
                                        {f}
                                      </button>
                                    )}
                                  </For>
                                </Show>
                              </div>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </section>
                </Show>
              );
            }}
          </For>
          <Show when={!scanning() && !error() && cats().every((c) => c.bytes === 0 && !c.action)}>
            <p class="muted bin-empty">Nothing to clean right now.</p>
          </Show>
        </div>

        <Show when={confirming()}>
          <div class="setting-note" role="alertdialog" aria-label="Confirm cleanup">
            <p>
              Delete {chosen().length} categor{chosen().length === 1 ? "y" : "ies"} ({formatSize(pickedBytes())})? This can't be undone.
              <Show when={includesBin()}> The Recycle Bin will be emptied for good.</Show>
              <Show when={needsAdmin()}> Windows will ask for administrator rights next.</Show>
            </p>
            <div class="dialog-actions">
              <button class="btn" onClick={() => setConfirming(false)}>Cancel</button>
              <button class="btn primary" onClick={() => void run()}>Delete</button>
            </div>
          </div>
        </Show>

        <div class="dialog-actions bin-actions">
          <span class="muted small">
            <Show when={running()} fallback={picked().size ? `${picked().size} selected · ${formatSize(pickedBytes())}` : ""}>
              Cleaning… this can take a minute
            </Show>
          </span>
          <span class="bin-spacer" />
          <button class="btn" disabled={busy()} onClick={() => void scan()}>Scan again</button>
          <button class="btn" disabled={running()} onClick={close}>Close</button>
          <button class="btn primary" disabled={busy() || picked().size === 0 || confirming()} onClick={() => setConfirming(true)}>
            Clean up
          </button>
        </div>
      </div>
    </div>
  );
}
