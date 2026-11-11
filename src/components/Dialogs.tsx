// Batch rename and lock hunter dialogs.
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { batchRename, errorText, fileTags, killProcess, whoLocks } from "../lib/ipc";
import { baseOf, isDir } from "../lib/listing";
import { planRenames, renderAll, DEFAULT_SPEC, type CaseMode, type RenameItem, type RenameRow } from "../lib/rename";
import { ops } from "../state/ops";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";

const STATUS_TEXT: Record<RenameRow["status"], string> = { unchanged: "No change", ok: "Ready", conflict: "Conflict", invalid: "Invalid" };

export function BatchRename() {
  const tab = workspace.activeTab()!;
  const l = tab.listing();
  const entries = [...tab.selection()].filter((i) => i < l.count).sort((a, b) => tab.view().indexOf(a) - tab.view().indexOf(b));
  const paths = entries.map(tab.pathOf);

  const [template, setTemplate] = createSignal(DEFAULT_SPEC.template);
  const [find, setFind] = createSignal("");
  const [replace, setReplace] = createSignal("");
  const [regex, setRegex] = createSignal(false);
  const [caseMode, setCaseMode] = createSignal<CaseMode>("keep");
  const [start, setStart] = createSignal(1);
  /** Text of the multi-line editor when the user has edited names by hand. */
  const [manual, setManual] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const [tags] = createResource(() => fileTags(paths));
  const items = createMemo<RenameItem[]>(() =>
    entries.map((e, i) => ({ name: baseOf(l.names[e]), isDir: isDir(l, e), modifiedMs: l.mtimes[e], tags: tags()?.[i] ?? {} })),
  );
  const existing = new Set(l.names.slice(0, l.count).map((n) => baseOf(n).toLowerCase()));

  const plan = createMemo(() => {
    const m = manual();
    try {
      const rendered = renderAll({ template: template(), find: find(), replace: replace(), regex: regex(), caseMode: caseMode(), start: start() }, items());
      const lines = m === null ? rendered : m.split("\n").map((s) => s.replace(/\r$/, ""));
      if (lines.length !== items().length) return { error: `The list has ${lines.length} lines but ${items().length} items are selected`, rendered };
      return { rows: planRenames(items(), lines, existing), rendered };
    } catch (e) {
      return { error: `Find: ${errorText(e)}`, rendered: items().map((i) => i.name) };
    }
  });

  const rows = () => plan().rows ?? [];
  const ready = () => !plan().error && rows().some((r) => r.status === "ok") && rows().every((r) => r.status === "ok" || r.status === "unchanged");

  async function apply() {
    const changes = rows().map((r, i): [string, string] | null => (r.status === "ok" ? [paths[i], r.newName] : null)).filter((x): x is [string, string] => x !== null);
    setBusy(true);
    try {
      const done = await batchRename(changes);
      ops.record({ kind: "move", label: `Batch rename of ${done.length} items`, pairs: done });
      ui.setBatchRenameOpen(false);
      await tab.navigate(tab.path(), changes.map(([, n]) => n));
    } catch (e) {
      ui.toast(errorText(e));
      setBusy(false);
    }
  }

  const reset = () => setManual(null);
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && ui.setBatchRenameOpen(false)}>
      <div class="dialog rename-dialog" role="dialog" aria-label="Batch rename" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") ui.setBatchRenameOpen(false); }}>
        <h2>Rename {entries.length} items</h2>
        <div class="rename-form">
          <label>Name pattern<input class="text-input" spellcheck={false} value={template()} onInput={(e) => (setTemplate(e.currentTarget.value), reset())} /></label>
          <label>Start at<input class="text-input" type="number" value={start()} onInput={(e) => (setStart(Number(e.currentTarget.value) || 0), reset())} /></label>
          <label>Find<input class="text-input" spellcheck={false} value={find()} onInput={(e) => (setFind(e.currentTarget.value), reset())} /></label>
          <label>Replace with<input class="text-input" spellcheck={false} value={replace()} onInput={(e) => (setReplace(e.currentTarget.value), reset())} /></label>
          <label>Case
            <select class="text-input" value={caseMode()} onChange={(e) => (setCaseMode(e.currentTarget.value as CaseMode), reset())}>
              <option value="keep">Keep</option><option value="lower">lower case</option><option value="upper">UPPER CASE</option><option value="title">Title Case</option>
            </select>
          </label>
          <label class="check"><input type="checkbox" checked={regex()} onChange={(e) => (setRegex(e.currentTarget.checked), reset())} /> Regular expression ($1, $2)</label>
        </div>
        <p class="muted small">Tokens: {"{name} {ext} {n} {n:3} {date} {date:YYYYMMDD} {exif:date} {exif:camera} {id3:artist} {id3:title} {id3:album} {id3:track}"}</p>
        <div class="rename-columns">
          <label class="rename-edit">New names (edit freely, one per line)
            <textarea class="text-input" spellcheck={false} wrap="off" value={manual() ?? plan().rendered.join("\n")} onInput={(e) => setManual(e.currentTarget.value)} />
          </label>
          <div class="rename-preview" role="table" aria-label="Preview">
            <For each={rows()}>
              {(r) => (
                <div class={`rename-row ${r.status}`} title={r.reason}>
                  <span class="old">{r.oldName}</span><span class="arrow">→</span><span class="new">{r.newName}</span><span class="status">{r.reason ?? STATUS_TEXT[r.status]}</span>
                </div>
              )}
            </For>
            <Show when={plan().error}>{(e) => <p class="error-text">{e()}</p>}</Show>
          </div>
        </div>
        <div class="dialog-actions">
          <button class="btn" onClick={() => ui.setBatchRenameOpen(false)}>Cancel</button>
          <button class="btn primary" disabled={!ready() || busy()} onClick={() => void apply()}>Rename</button>
        </div>
      </div>
    </div>
  );
}

export function LockHunter(props: { paths: readonly string[] }) {
  const [lockers, { refetch }] = createResource(() => whoLocks([...props.paths]));
  const [killing, setKilling] = createSignal<number | null>(null);

  async function kill(pid: number) {
    try {
      await killProcess(pid);
      ui.toast(`Ended process ${pid}`);
    } catch (e) {
      ui.toast(`Couldn't end it: ${errorText(e)}`);
    }
    setKilling(null);
    await refetch();
  }

  const close = () => ui.setLockPaths(null);
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="dialog" role="dialog" aria-label="File lock hunter" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); }}>
        <h2>What is locking this?</h2>
        <Show when={!lockers.loading} fallback={<p class="muted">Checking…</p>}>
          <Show when={!lockers.error} fallback={<p class="error-text">{errorText(lockers.error)}</p>}>
            <Show when={(lockers() ?? []).length > 0} fallback={<p class="muted">Nothing has this open right now.</p>}>
              <div class="lockers">
                <For each={lockers()}>
                  {(l) => (
                    <div class="locker">
                      <span class="locker-name">{l.name || "Unknown program"}</span>
                      <span class="muted small">PID {l.pid} · {l.kind}</span>
                      <Show
                        when={killing() === l.pid}
                        fallback={<button class="btn small" disabled={l.kind === "critical"} title={l.kind === "critical" ? "Windows needs this process" : undefined} onClick={() => setKilling(l.pid)}>End process</button>}
                      >
                        <button class="btn small danger" onClick={() => void kill(l.pid)}>Confirm: unsaved work is lost</button>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
        <div class="dialog-actions">
          <button class="btn" onClick={() => void refetch()}>Check again</button>
          <button class="btn primary" ref={(b) => queueMicrotask(() => b.focus())} onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
