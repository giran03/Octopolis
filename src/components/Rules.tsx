// Folder rules: tidy folders by moving or deleting old files that match name patterns. Every run is previewed first.
// The dialog works like Custom actions: a list with toggles, an editor, ready-made presets, import and export.
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { formatSize } from "../lib/format";
import { errorText, knownFolders, pickFolderDialog, ruleMatches, type RuleMatch } from "../lib/ipc";
import { baseName } from "../lib/paths";
import { presetFolderIds, resolvePreset, RULE_PRESET_GROUPS, RULE_PRESETS } from "../lib/rulePresets";
import { blankRule, DEST_TOKENS, groupByDestination, newRuleId, parseRulesText, type Rule, ruleProblem, ruleQuery, rulesToJson, ruleSummary, sinceText, uniqueRuleName } from "../lib/rules";
import { downloadText, readTextFile } from "../lib/textFile";
import { ops } from "../state/ops";
import { rules } from "../state/rules";
import { ui } from "../state/ui";
import { MaterialIcon } from "./Icons";
import { Segmented, Toggle, type Option } from "./settings/controls";

type View = "list" | "edit" | "presets" | "preview";

const ACTIONS: readonly Option<Rule["action"]>[] = [
  { value: "move", label: "Move to a folder" },
  { value: "recycle", label: "Recycle Bin" },
];

/** Name patterns to start from. */
const PATTERN_SETS: readonly { label: string; patterns: string }[] = [
  { label: "Pictures", patterns: "*.jpg; *.jpeg; *.png; *.gif; *.webp; *.heic" },
  { label: "Documents", patterns: "*.pdf; *.doc; *.docx; *.xls; *.xlsx; *.ppt; *.pptx; *.txt" },
  { label: "Installers", patterns: "*.exe; *.msi; *.msix; *.appx" },
  { label: "Archives", patterns: "*.zip; *.7z; *.rar; *.tar; *.gz" },
  { label: "Video", patterns: "*.mp4; *.mkv; *.mov; *.avi; *.webm" },
  { label: "Music", patterns: "*.mp3; *.flac; *.wav; *.m4a; *.ogg" },
  { label: "Temp files", patterns: "*.tmp; *.crdownload; *.part; *.partial" },
];

interface Part {
  readonly rule: Rule;
  readonly matches: readonly RuleMatch[];
}

const SHOWN_FILES = 150;
const total = (parts: readonly Part[]) => parts.reduce((n, p) => n + p.matches.length, 0);
const bytes = (parts: readonly Part[]) => parts.reduce((n, p) => n + p.matches.reduce((s, m) => s + m.size, 0), 0);
const files = (n: number) => `${n.toLocaleString()} file${n === 1 ? "" : "s"}`;

export function Rules() {
  const [view, setView] = createSignal<View>("list");
  const [back, setBack] = createSignal<View>("list");
  const [filter, setFilter] = createSignal("");
  const [draft, setDraft] = createSignal<Rule>(blankRule());
  const [parts, setParts] = createSignal<readonly Part[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [live, setLive] = createSignal<string | null>(null);
  let fileEl: HTMLInputElement | undefined;

  const list = () => rules.list();
  const shown = () => {
    const q = filter().trim().toLowerCase();
    return q ? list().filter((r) => `${r.name} ${r.folder} ${r.patterns} ${r.dest}`.toLowerCase().includes(q)) : list();
  };
  const close = () => ui.setRulesOpen(false);
  const set = (patch: Partial<Rule>) => setDraft({ ...draft(), ...patch });
  const go = (v: View) => (setError(null), setView(v));

  const edit = (r: Rule) => {
    setDraft(r);
    go("edit");
  };
  const add = (r: Omit<Rule, "id">) => rules.upsert({ ...r, id: newRuleId(), name: uniqueRuleName(r.name, list().map((x) => x.name)), lastRun: null });
  const added = (name: string) => list().some((r) => r.name.toLowerCase() === name.toLowerCase());

  const pick = async (current: string, apply: (p: string) => void) => {
    try {
      const p = await pickFolderDialog(current || undefined);
      if (p) apply(p);
    } catch (e) {
      setError(errorText(e));
    }
  };

  /** Looks up what the rules would act on and shows it. Nothing changes until the user confirms. */
  const check = async (targets: readonly Rule[], from: View) => {
    for (const r of targets) {
      const problem = ruleProblem(r);
      if (problem) return void setError(targets.length > 1 ? `"${r.name}": ${problem}` : problem);
    }
    setBusy(true);
    setError(null);
    try {
      const found: Part[] = [];
      for (const rule of targets) found.push({ rule, matches: await ruleMatches(rule.folder, ruleQuery(rule)) });
      setParts(found);
      setBack(from);
      setView("preview");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    const run = parts().filter((p) => p.matches.length > 0);
    if (run.length === 0) return;
    setParts([]);
    setView("list");
    let count = 0;
    for (const { rule, matches } of run) {
      if (rule.action === "move") {
        for (const g of groupByDestination(rule, matches)) await ops.transfer("move", g.files.map((m) => m.path), g.dest);
      } else ops.remove(matches.map((m) => m.path), false);
      rules.recordRun(rule.id, matches.length);
      count += matches.length;
    }
    ui.toast(`${run.length > 1 ? `${run.length} rules` : `"${run[0].rule.name || "Rule"}"`} ran on ${files(count)}. Undo with Ctrl+Z`);
  };

  const save = () => {
    const d = draft();
    const problem = ruleProblem(d);
    if (problem) return setError(problem);
    const name = d.name.trim() || "Untitled rule";
    if (list().some((x) => x.id !== d.id && x.name.toLowerCase() === name.toLowerCase())) return setError("Another rule already has that name");
    rules.upsert({ ...d, name });
    go("list");
  };

  const remove = (r: Rule) =>
    ui.ask({
      title: `Remove "${r.name}"?`,
      body: "The rule is deleted. Files it already moved stay where they are. Export your rules first if you may want it back.",
      confirmLabel: "Remove",
      danger: true,
      onConfirm: () => rules.remove(r.id),
    });

  const addPreset = async (p: (typeof RULE_PRESETS)[number]) => {
    try {
      const wanted = presetFolderIds(p);
      const known = Object.fromEntries((await knownFolders()).map((f) => [f.id, f.path]));
      const resolved = resolvePreset(p, known);
      if (!resolved) return ui.toast(`Couldn't find your ${wanted.filter((id) => !known[id]).join(" and ")} folder`);
      add(resolved);
      ui.toast(`Added "${p.rule.name}". Run it from the list to see what it would do`);
    } catch (e) {
      ui.toast(errorText(e));
    }
  };

  const importFile = async (e: Event & { currentTarget: HTMLInputElement }) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (!file) return;
    try {
      const incoming = parseRulesText(await readTextFile(file));
      const names = list().map((r) => r.name);
      const fresh = incoming.map((r) => {
        const name = uniqueRuleName(r.name, names);
        names.push(name);
        return { ...r, name, id: newRuleId() };
      });
      rules.save([...list(), ...fresh]);
      ui.toast(`Added ${fresh.length} rule${fresh.length === 1 ? "" : "s"}`);
    } catch (err) {
      ui.toast(errorText(err));
    }
  };
  const exportAll = async (how: "copy" | "file") => {
    if (list().length === 0) return ui.toast("There are no rules to export");
    try {
      if (how === "copy") {
        await navigator.clipboard.writeText(rulesToJson(list()));
        ui.toast("Rules copied as JSON");
      } else downloadText("octopolis-rules.json", rulesToJson(list()));
    } catch (err) {
      ui.toast(errorText(err));
    }
  };

  const usePatterns = (patterns: string) => {
    const have = draft().patterns.split(";").map((p) => p.trim()).filter(Boolean);
    const merged = [...have, ...patterns.split(";").map((p) => p.trim()).filter((p) => !have.some((h) => h.toLowerCase() === p.toLowerCase()))];
    set({ patterns: merged.join("; ") });
  };
  const optionalDays = (text: string) => {
    const n = Number(text);
    return text.trim() === "" || !Number.isFinite(n) ? null : Math.max(0, Math.floor(n));
  };

  // While editing, a short line says how many files the rule matches right now.
  createEffect(() => {
    const d = draft();
    if (view() !== "edit") return;
    setLive(null);
    // The count needs the folder and sensible numbers, not a destination yet.
    if (ruleProblem({ ...d, action: "recycle" })) return;
    let stale = false;
    const timer = setTimeout(() => {
      ruleMatches(d.folder, ruleQuery(d)).then(
        (m) => !stale && setLive(m.length === 0 ? "Nothing matches right now" : `${m.length >= 5000 ? "5,000+" : m.length.toLocaleString()} file${m.length === 1 ? "" : "s"} match right now (${formatSize(m.reduce((s, x) => s + x.size, 0))})`),
        (e) => !stale && setLive(errorText(e)),
      );
    }, 450);
    onCleanup(() => {
      stale = true;
      clearTimeout(timer);
    });
  });

  // "Run rule: …" from the command palette opens straight on that rule's preview.
  onMount(() => {
    const id = rules.takePendingRun();
    const r = id ? list().find((x) => x.id === id) : undefined;
    if (r) void check([r], "list");
  });

  const badges = (r: Pick<Rule, "action" | "recursive" | "minSizeMb">) => [r.action === "move" ? "Move" : "Recycle Bin", r.recursive ? "Subfolders" : "", r.minSizeMb > 0 ? `≥ ${r.minSizeMb} MB` : ""].filter(Boolean);
  const title = () => (view() === "edit" ? (list().some((r) => r.id === draft().id) ? "Edit rule" : "New rule") : view() === "presets" ? "Presets" : view() === "preview" ? "What would happen" : "Folder rules");
  const sub = () =>
    view() === "list" ? "Tidy a folder by moving or deleting old files. You always see the files first."
    : view() === "presets" ? "Add one, then change it if you like. Nothing runs until you preview it"
    : view() === "preview" ? "Nothing has changed yet"
    : "";
  const enabledCount = () => list().filter((r) => r.enabled).length;

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="dialog actions-dialog2 rules-dialog2"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rules-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") return view() === "preview" ? go(back()) : view() !== "list" ? go("list") : close();
        }}
      >
        <div class="ax-head">
          <Show when={view() !== "list"}>
            <button class="btn small icon-btn" aria-label="Back" title="Back" onClick={() => go(view() === "preview" ? back() : "list")}>
              <MaterialIcon name="arrow_back" size={16} />
            </button>
          </Show>
          <h2 id="rules-title">{title()}</h2>
          <span class="muted small ax-sub">{sub()}</span>
        </div>
        <Show when={error()}>{(e) => <p class="error-text small rx-error" role="alert">{e()}</p>}</Show>

        <Show when={view() === "list"}>
          <div class="ax-bar">
            <input class="text-input" placeholder="Filter rules" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
            <button class="btn small primary" onClick={() => edit(blankRule())}><MaterialIcon name="add" size={15} /> New</button>
            <button class="btn small" onClick={() => go("presets")}><MaterialIcon name="auto_fix_high" size={15} /> Presets</button>
            <button class="btn small" title="Add rules from a JSON file" onClick={() => fileEl?.click()}><MaterialIcon name="upload_file" size={15} /> Import</button>
            <input ref={fileEl} type="file" accept=".json,application/json" hidden onChange={(e) => void importFile(e)} />
            <button class="btn small icon-btn" title="Copy all as JSON" aria-label="Copy all rules as JSON" onClick={() => void exportAll("copy")}><MaterialIcon name="data_object" size={16} /></button>
            <button class="btn small icon-btn" title="Save all as a file" aria-label="Save all rules as a file" onClick={() => void exportAll("file")}><MaterialIcon name="download" size={16} /></button>
          </div>
          <div class="ax-list">
            <For each={shown()} fallback={<p class="muted ax-empty">{list().length ? "No rule matches." : "No rules yet. Add one, or start from the presets. A rule could move PDFs older than 30 days out of Downloads, for example."}</p>}>
              {(r) => (
                <div class="ax-row" classList={{ off: !r.enabled }}>
                  <Toggle label={`${r.name} enabled`} checked={r.enabled} onChange={(enabled) => rules.patch(r.id, { enabled })} />
                  <span class="ax-main">
                    <span class="ax-name">{r.name}</span>
                    <span class="muted small rx-summary" title={r.folder}>{ruleSummary(r)}</span>
                    <span class="ax-meta small">
                      <For each={badges(r)}>{(b) => <span class="ax-badge" classList={{ warn: b === "Recycle Bin" }}>{b}</span>}</For>
                      <Show when={r.lastRun}>{(l) => <span class="muted">Last run {sinceText(l().at, Date.now())}: {files(l().count)}</span>}</Show>
                    </span>
                  </span>
                  <span class="ax-buttons">
                    <button class="btn small" disabled={busy()} title="See what this rule would do" onClick={() => void check([r], "list")}>Run…</button>
                    <button class="btn small icon-btn" title="Edit" aria-label={`Edit ${r.name}`} onClick={() => edit(r)}><MaterialIcon name="edit" size={16} /></button>
                    <button class="btn small icon-btn" title="Duplicate" aria-label={`Duplicate ${r.name}`} onClick={() => add({ ...r, name: `${r.name} copy` })}><MaterialIcon name="content_copy" size={16} /></button>
                    <button class="btn small icon-btn" title="Remove" aria-label={`Remove ${r.name}`} onClick={() => remove(r)}><MaterialIcon name="delete" size={16} /></button>
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={view() === "presets"}>
          <div class="ax-list ax-presets">
            <For each={RULE_PRESET_GROUPS}>
              {(g) => (
                <section>
                  <h3>{g.title}</h3>
                  <For each={RULE_PRESETS.filter((p) => p.group === g.id)}>
                    {(p) => (
                      <div class="ax-row">
                        <span class="ax-main">
                          <span class="ax-name">{p.rule.name}</span>
                          <span class="muted small">{p.description}</span>
                          <span class="ax-meta small">
                            <For each={badges(p.rule)}>{(b) => <span class="ax-badge" classList={{ warn: b === "Recycle Bin" }}>{b}</span>}</For>
                            <span class="muted">{p.rule.patterns || "All files"} · {p.rule.olderThanDays}+ days</span>
                          </span>
                        </span>
                        <button class="btn small" disabled={added(p.rule.name)} onClick={() => void addPreset(p)}>
                          {added(p.rule.name) ? "Added" : "Add"}
                        </button>
                      </div>
                    )}
                  </For>
                </section>
              )}
            </For>
          </div>
        </Show>

        <Show when={view() === "edit"}>
          <div class="ax-form">
            <label class="ax-field">
              <span>Name</span>
              <input class="text-input" maxLength={80} placeholder="Old downloads" value={draft().name} onInput={(e) => set({ name: e.currentTarget.value })} ref={(el) => queueMicrotask(() => el.focus())} />
            </label>
            <label class="ax-field">
              <span>Folder to tidy</span>
              <span class="rx-inline">
                <input class="text-input mono" spellcheck={false} placeholder="Folder path" value={draft().folder} onInput={(e) => set({ folder: e.currentTarget.value.trim() })} />
                <button class="btn small" onClick={() => void pick(draft().folder, (p) => set({ folder: p }))}>Browse…</button>
              </span>
            </label>

            <h3>Which files</h3>
            <label class="ax-field">
              <span>Names (blank: every file)</span>
              <input class="text-input mono" spellcheck={false} placeholder="*.pdf; invoice*" value={draft().patterns} onInput={(e) => set({ patterns: e.currentTarget.value })} />
            </label>
            <div class="ax-chips" aria-label="Common file types">
              <For each={PATTERN_SETS}>{(s) => <button class="ax-chip" title={s.patterns} onClick={() => usePatterns(s.patterns)}>{s.label}</button>}</For>
              <button class="ax-chip" title="Clear the names" onClick={() => set({ patterns: "" })}>Clear</button>
            </div>
            <div class="ax-field">
              <span>Not changed for</span>
              <span class="ax-count">
                <input class="text-input" type="number" min="0" aria-label="Days since last change" value={draft().olderThanDays} onInput={(e) => set({ olderThanDays: Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)) })} />
                <span class="muted small">days or more, and no more than</span>
                <input class="text-input" type="number" min="0" aria-label="Newest age in days (blank: no limit)" placeholder="any" value={draft().newerThanDays ?? ""} onInput={(e) => set({ newerThanDays: optionalDays(e.currentTarget.value) })} />
                <span class="muted small">days (blank: no limit)</span>
              </span>
            </div>
            <div class="ax-field">
              <span>At least this big</span>
              <span class="ax-count">
                <input class="text-input" type="number" min="0" step="any" aria-label="Smallest size in MB" value={draft().minSizeMb} onInput={(e) => set({ minSizeMb: Math.max(0, Number(e.currentTarget.value) || 0) })} />
                <span class="muted small">MB (0: any size)</span>
              </span>
            </div>
            <label class="props-check"><input type="checkbox" checked={draft().recursive} onChange={(e) => set({ recursive: e.currentTarget.checked })} /> Include files in subfolders</label>

            <h3>What to do</h3>
            <div class="ax-field">
              <span>Action</span>
              <Segmented label="Action" value={draft().action} options={ACTIONS} onChange={(action) => set({ action })} />
            </div>
            <Show when={draft().action === "move"}>
              <label class="ax-field">
                <span>Move them to</span>
                <span class="rx-inline">
                  <input class="text-input mono" spellcheck={false} placeholder="Destination folder" value={draft().dest} onInput={(e) => set({ dest: e.currentTarget.value.trim() })} />
                  <button class="btn small" onClick={() => void pick(draft().dest, (p) => set({ dest: p }))}>Browse…</button>
                </span>
              </label>
              <div class="ax-chips" aria-label="Destination placeholders">
                <For each={DEST_TOKENS}>{(t) => <button class="ax-chip" title={t.hint} onClick={() => set({ dest: draft().dest + t.token })}>{t.token}</button>}</For>
              </div>
            </Show>
            <Show when={draft().action === "recycle"}>
              <p class="muted small rx-note">Files go to the Recycle Bin, so they can be restored from there or with Ctrl+Z.</p>
            </Show>

            <div class="ax-preview" aria-live="polite">
              <span class="muted small">{ruleSummary(draft())}</span>
              <Show when={live()} fallback={<span class="muted small">Fill in the folder to see how many files match.</span>}>{(l) => <code>{l()}</code>}</Show>
            </div>
          </div>
        </Show>

        <Show when={view() === "preview"}>
          <div class="rx-preview">
            <p class="rx-lead">
              <strong>{files(total(parts()))}</strong> ({formatSize(bytes(parts()))}) would be changed.
            </p>
            <div class="ax-list rx-files">
              <For each={parts()}>
                {(part) => (
                  <section>
                    <h3>{part.rule.name || "Rule"}: {files(part.matches.length)} in {baseName(part.rule.folder) || part.rule.folder} → {part.rule.action === "move" ? "moved" : "Recycle Bin"}</h3>
                    <Show when={part.rule.action === "move"}>
                      <For each={groupByDestination(part.rule, part.matches)}>
                        {(g) => <p class="muted small rx-dest" title={g.dest}>→ {g.dest}: {files(g.files.length)}</p>}
                      </For>
                    </Show>
                    <For each={part.matches.slice(0, Math.max(10, Math.floor(SHOWN_FILES / parts().length)))} fallback={<p class="muted small">Nothing matches right now</p>}>
                      {(m) => (
                        <div class="rx-file">
                          <span class="bin-name" title={m.path}>{baseName(m.path)}</span>
                          <span class="muted small">{formatSize(m.size)}</span>
                        </div>
                      )}
                    </For>
                    <Show when={part.matches.length > Math.max(10, Math.floor(SHOWN_FILES / parts().length))}>
                      <p class="muted small">…and {(part.matches.length - Math.max(10, Math.floor(SHOWN_FILES / parts().length))).toLocaleString()} more</p>
                    </Show>
                  </section>
                )}
              </For>
            </div>
          </div>
        </Show>

        <div class="dialog-actions">
          <Show when={view() === "list"}>
            <button class="btn" disabled={busy() || enabledCount() === 0} title="Preview every rule that is switched on, together" onClick={() => void check(list().filter((r) => r.enabled), "list")}>
              Run all enabled…
            </button>
            <button class="btn primary" onClick={close}>Done</button>
          </Show>
          <Show when={view() === "presets"}>
            <button class="btn primary" onClick={() => go("list")}>Done</button>
          </Show>
          <Show when={view() === "edit"}>
            <button class="btn" onClick={() => go("list")}>Cancel</button>
            <button class="btn" disabled={busy()} onClick={() => void check([{ ...draft(), name: draft().name.trim() || "Untitled rule" }], "edit")}>Preview…</button>
            <button class="btn primary" onClick={save}>Save rule</button>
          </Show>
          <Show when={view() === "preview"}>
            <button class="btn" onClick={() => go(back())}>Back</button>
            <button class="btn primary" classList={{ danger: parts().some((p) => p.rule.action === "recycle") }} disabled={total(parts()) === 0} onClick={() => void apply()}>
              {parts().every((p) => p.rule.action === "move") ? "Move them" : parts().every((p) => p.rule.action === "recycle") ? "Move to Recycle Bin" : "Run these rules"}
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
