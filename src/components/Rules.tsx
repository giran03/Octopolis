// Folder rules: tidy folders by moving or deleting old files that match name patterns. Every run is previewed first.
import { createSignal, For, Show } from "solid-js";
import { formatSize } from "../lib/format";
import { errorText, pickFolderDialog, ruleMatches, type RuleMatch } from "../lib/ipc";
import { baseName } from "../lib/paths";
import { ops } from "../state/ops";
import { blankRule, type Rule, ruleProblem, rules } from "../state/rules";
import { ui } from "../state/ui";
import { MaterialIcon } from "./Icons";
import { Segmented, type Option } from "./settings/controls";

const ACTIONS: readonly Option<Rule["action"]>[] = [
  { value: "move", label: "Move to a folder" },
  { value: "recycle", label: "Recycle Bin" },
];

interface Preview {
  readonly rule: Rule;
  readonly matches: readonly RuleMatch[];
}

export function Rules() {
  const [editing, setEditing] = createSignal<Rule | null>(null);
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const close = () => ui.setRulesOpen(false);

  const pick = async (current: string, apply: (p: string) => void) => {
    try {
      const p = await pickFolderDialog(current || undefined);
      if (p) apply(p);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const check = async (rule: Rule) => {
    const problem = ruleProblem(rule);
    if (problem) return void setError(problem);
    setBusy(true);
    setError(null);
    try {
      setPreview({ rule, matches: await ruleMatches(rule.folder, rule.patterns, rule.olderThanDays, rule.recursive) });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    const p = preview();
    if (!p || p.matches.length === 0) return;
    const paths = p.matches.map((m) => m.path);
    setPreview(null);
    if (p.rule.action === "move") await ops.transfer("move", paths, p.rule.dest);
    else ops.remove(paths, false);
    ui.toast(`"${p.rule.name || "Rule"}" ran on ${paths.length} file${paths.length === 1 ? "" : "s"}. Undo with Ctrl+Z`);
  };

  const field = (key: keyof Rule, value: string | number | boolean) => setEditing((r) => (r ? { ...r, [key]: value } : r));

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="dialog bin-dialog rules-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rules-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") (preview() ? setPreview(null) : editing() ? setEditing(null) : close());
        }}
      >
        <div class="bin-head">
          <h2 id="rules-title">Folder rules</h2>
          <span class="muted small">Tidy a folder by moving or deleting old files. You always see the files first.</span>
        </div>
        <Show when={error()}>{(e) => <p class="error-text">{e()}</p>}</Show>

        <Show
          when={!preview()}
          fallback={
            <div class="rules-preview">
              <p>
                <strong>{preview()!.matches.length.toLocaleString()} file{preview()!.matches.length === 1 ? "" : "s"}</strong> in <span title={preview()!.rule.folder}>{baseName(preview()!.rule.folder) || preview()!.rule.folder}</span> would{" "}
                {preview()!.rule.action === "move" ? <>move to <strong>{baseName(preview()!.rule.dest) || preview()!.rule.dest}</strong></> : <>go to the Recycle Bin</>} ({formatSize(preview()!.matches.reduce((s, m) => s + m.size, 0))}).
              </p>
              <div class="bin-list">
                <For each={preview()!.matches.slice(0, 200)} fallback={<p class="muted bin-empty">Nothing matches right now</p>}>
                  {(m) => (
                    <div class="rule-file">
                      <span class="bin-name" title={m.path}>{baseName(m.path)}</span>
                      <span class="muted small bin-meta">{formatSize(m.size)}</span>
                    </div>
                  )}
                </For>
                <Show when={preview()!.matches.length > 200}>
                  <p class="muted small">…and {(preview()!.matches.length - 200).toLocaleString()} more</p>
                </Show>
              </div>
              <div class="dialog-actions">
                <button class="btn" onClick={() => setPreview(null)}>Back</button>
                <button class="btn primary" disabled={preview()!.matches.length === 0} onClick={() => void apply()}>
                  {preview()!.rule.action === "move" ? "Move them" : "Move to Recycle Bin"}
                </button>
              </div>
            </div>
          }
        >
          <Show
            when={!editing()}
            fallback={
              <div class="rules-form">
                <label>Name<input class="text-input" placeholder="Old downloads" value={editing()!.name} onInput={(e) => field("name", e.currentTarget.value)} /></label>
                <label>
                  Folder to tidy
                  <span class="inline">
                    <input class="text-input wide" spellcheck={false} placeholder="Folder path" value={editing()!.folder} onInput={(e) => field("folder", e.currentTarget.value.trim())} />
                    <button class="btn" onClick={() => void pick(editing()!.folder, (p) => field("folder", p))}>Browse…</button>
                  </span>
                </label>
                <label>
                  File names
                  <input class="text-input" spellcheck={false} placeholder="*.pdf; invoice*   (empty matches every file)" value={editing()!.patterns} onInput={(e) => field("patterns", e.currentTarget.value)} />
                </label>
                <label>
                  Not changed for at least (days)
                  <input class="text-input num" type="number" min="0" value={editing()!.olderThanDays} onInput={(e) => field("olderThanDays", Number(e.currentTarget.value))} />
                </label>
                <label class="rules-check">
                  <input type="checkbox" checked={editing()!.recursive} onChange={(e) => field("recursive", e.currentTarget.checked)} /> Include files in subfolders
                </label>
                <div>
                  What to do
                  <Segmented label="Action" value={editing()!.action} options={ACTIONS} onChange={(a) => field("action", a)} />
                </div>
                <Show when={editing()!.action === "move"}>
                  <label>
                    Move them to
                    <span class="inline">
                      <input class="text-input wide" spellcheck={false} placeholder="Destination folder" value={editing()!.dest} onInput={(e) => field("dest", e.currentTarget.value.trim())} />
                      <button class="btn" onClick={() => void pick(editing()!.dest, (p) => field("dest", p))}>Browse…</button>
                    </span>
                  </label>
                </Show>
                <div class="dialog-actions">
                  <button class="btn" onClick={() => (setEditing(null), setError(null))}>Cancel</button>
                  <button
                    class="btn"
                    onClick={() => {
                      const r = editing()!;
                      const problem = ruleProblem(r);
                      if (problem) return setError(problem);
                      rules.upsert({ ...r, name: r.name.trim() || "Untitled rule" });
                      setEditing(null);
                      setError(null);
                    }}
                  >
                    Save
                  </button>
                  <button class="btn primary" disabled={busy()} onClick={() => void check(editing()!)}>Preview what it would do</button>
                </div>
              </div>
            }
          >
            <div class="bin-list rules-list">
              <For each={rules.list()} fallback={<p class="muted bin-empty">No rules yet. A rule could move PDFs older than 30 days out of Downloads, for example.</p>}>
                {(r) => (
                  <div class="rule-row">
                    <MaterialIcon name="rule" size={20} class="ops-state" />
                    <span class="bin-names">
                      <span class="bin-name">{r.name}</span>
                      <span class="muted small bin-from" title={r.folder}>
                        {r.patterns || "all files"} in {baseName(r.folder) || r.folder}, older than {r.olderThanDays} day{r.olderThanDays === 1 ? "" : "s"} → {r.action === "move" ? baseName(r.dest) || r.dest : "Recycle Bin"}
                      </span>
                    </span>
                    <button class="btn small" disabled={busy()} onClick={() => void check(r)}>Run…</button>
                    <button class="btn small" onClick={() => setEditing(r)}>Edit</button>
                    <button class="btn small" onClick={() => rules.remove(r.id)}>Delete</button>
                  </div>
                )}
              </For>
            </div>
            <div class="dialog-actions bin-actions">
              <button class="btn" onClick={close}>Close</button>
              <span class="bin-spacer" />
              <button class="btn primary" onClick={() => (setEditing(blankRule()), setError(null))}>New rule</button>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
