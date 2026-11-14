// Folder rules: tidy folders by moving or deleting old files that match name patterns. Every run is previewed first.
// The dialog works like Custom actions: a list with toggles, an editor, ready-made presets, import and export.
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Checkbox } from "./Checkbox";
import { formatSize } from "../lib/format";
import { errorText, knownFolders, pickFolderDialog, ruleMatches, type RuleMatch } from "../lib/ipc";
import { baseName } from "../lib/paths";
import { presetFolderIds, resolvePreset, RULE_PRESET_GROUPS, RULE_PRESETS } from "../lib/rulePresets";
import {
  blankRule,
  DEST_TOKENS,
  groupByDestination,
  newRuleId,
  parseRulesText,
  type IntervalUnit,
  type Rule,
  type RuleSchedule,
  type ScheduleActionMode,
  type ScheduleLimitKind,
  type ScheduleMode,
  ruleProblem,
  ruleQuery,
  rulesToJson,
  ruleSummary,
  SCHEDULE_PRESETS,
  scheduleSummary,
  sinceText,
  uniqueRuleName,
} from "../lib/rules";
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

const SCHEDULE_MODES: readonly Option<ScheduleMode>[] = [
  { value: "manual", label: "Manual" },
  { value: "interval", label: "Every…" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "startup", label: "Startup" },
];

const LIMIT_KINDS: readonly Option<ScheduleLimitKind>[] = [
  { value: "forever", label: "Forever" },
  { value: "runs", label: "N runs" },
  { value: "duration", label: "For duration" },
];

const ACTION_MODES: readonly Option<ScheduleActionMode>[] = [
  { value: "auto", label: "Run automatically" },
  { value: "preview", label: "Notify & preview" },
];

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

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
  const setSchedule = (patch: Partial<RuleSchedule>) => {
    const next: RuleSchedule = { ...draft().schedule, ...patch };
    const normalized: RuleSchedule = {
      ...next,
      runsRemaining: next.limitKind === "runs" ? (patch.runsRemaining !== undefined ? patch.runsRemaining : next.limitValue) : null,
      untilAt:
        next.limitKind === "duration"
          ? patch.untilAt !== undefined
            ? patch.untilAt
            : Date.now() + next.limitValue * (next.limitUnit === "hours" ? 3_600_000 : 86_400_000)
          : null,
    };
    set({ schedule: normalized });
  };
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

  const badges = (r: Pick<Rule, "action" | "recursive" | "minSizeMb"> & { schedule?: RuleSchedule }) => [
    r.action === "move" ? "Move" : "Recycle Bin",
    r.schedule && r.schedule.mode !== "manual" ? scheduleSummary(r.schedule) : "",
    r.recursive ? "Subfolders" : "",
    r.minSizeMb > 0 ? `≥ ${r.minSizeMb} MB` : "",
  ].filter(Boolean);
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
          <div class="ax-form rx-form">
            <section class="rx-card">
              <div class="rx-row">
                <label class="rx-label" for="rule-name">Rule name</label>
                <div class="rx-ctrl">
                  <input id="rule-name" class="text-input" maxLength={80} placeholder="Old downloads" value={draft().name} onInput={(e) => set({ name: e.currentTarget.value })} ref={(el) => queueMicrotask(() => el.focus())} />
                </div>
              </div>
              <div class="rx-row">
                <label class="rx-label" for="rule-folder">Folder to tidy</label>
                <div class="rx-ctrl rx-inline-ctrl">
                  <input id="rule-folder" class="text-input mono" spellcheck={false} placeholder="Folder path" value={draft().folder} onInput={(e) => set({ folder: e.currentTarget.value.trim() })} />
                  <button class="btn small" onClick={() => void pick(draft().folder, (p) => set({ folder: p }))}>Browse…</button>
                </div>
              </div>
            </section>

            <section class="rx-card">
              <h3 class="rx-card-title">Which files</h3>
              <div class="rx-row rx-row-top">
                <label class="rx-label" for="rule-patterns">
                  <span>File names</span>
                  <span class="rx-hint muted small">Blank = every file</span>
                </label>
                <div class="rx-ctrl rx-stack">
                  <input id="rule-patterns" class="text-input mono" spellcheck={false} placeholder="*.pdf; invoice*" value={draft().patterns} onInput={(e) => set({ patterns: e.currentTarget.value })} />
                  <div class="ax-chips rx-chips" aria-label="Common file types">
                    <For each={PATTERN_SETS}>{(s) => <button class="ax-chip" title={s.patterns} onClick={() => usePatterns(s.patterns)}>{s.label}</button>}</For>
                    <button class="ax-chip rx-chip-clear" title="Clear the names" onClick={() => set({ patterns: "" })}>Clear</button>
                  </div>
                </div>
              </div>
              <div class="rx-row">
                <span class="rx-label">
                  <span>Not changed for</span>
                  <span class="rx-hint muted small">Age in days</span>
                </span>
                <div class="rx-ctrl rx-num-row">
                  <input class="text-input rx-num" type="number" min="0" aria-label="Days since last change" value={draft().olderThanDays} onInput={(e) => set({ olderThanDays: Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)) })} />
                  <span class="muted small">to</span>
                  <input class="text-input rx-num" type="number" min="0" aria-label="Newest age in days (blank: no limit)" placeholder="any" value={draft().newerThanDays ?? ""} onInput={(e) => set({ newerThanDays: optionalDays(e.currentTarget.value) })} />
                  <span class="muted small">days (blank = no max)</span>
                </div>
              </div>
              <div class="rx-row">
                <label class="rx-label" for="rule-size">
                  <span>Minimum size</span>
                  <span class="rx-hint muted small">0 = any size</span>
                </label>
                <div class="rx-ctrl rx-num-row">
                  <input id="rule-size" class="text-input rx-num" type="number" min="0" step="any" aria-label="Smallest size in MB" value={draft().minSizeMb} onInput={(e) => set({ minSizeMb: Math.max(0, Number(e.currentTarget.value) || 0) })} />
                  <span class="muted small">MB</span>
                </div>
              </div>
              <div class="rx-row">
                <span class="rx-label" />
                <div class="rx-ctrl">
                  <Checkbox class="props-check" checked={draft().recursive} onChange={(recursive) => set({ recursive })}>Include files in subfolders</Checkbox>
                </div>
              </div>
            </section>

            <section class="rx-card">
              <h3 class="rx-card-title">What to do</h3>
              <div class="rx-row">
                <span class="rx-label">Action</span>
                <div class="rx-ctrl">
                  <Segmented label="Action" value={draft().action} options={ACTIONS} onChange={(action) => set({ action })} />
                </div>
              </div>
              <Show when={draft().action === "move"}>
                <div class="rx-row rx-row-top">
                  <label class="rx-label" for="rule-dest">Move them to</label>
                  <div class="rx-ctrl rx-stack">
                    <div class="rx-inline-ctrl">
                      <input id="rule-dest" class="text-input mono" spellcheck={false} placeholder="Destination folder" value={draft().dest} onInput={(e) => set({ dest: e.currentTarget.value.trim() })} />
                      <button class="btn small" onClick={() => void pick(draft().dest, (p) => set({ dest: p }))}>Browse…</button>
                    </div>
                    <div class="ax-chips rx-chips" aria-label="Destination placeholders">
                      <For each={DEST_TOKENS}>{(t) => <button class="ax-chip" title={t.hint} onClick={() => set({ dest: draft().dest + t.token })}>{t.token}</button>}</For>
                    </div>
                  </div>
                </div>
              </Show>
              <Show when={draft().action === "recycle"}>
                <div class="rx-row">
                  <span class="rx-label" />
                  <div class="rx-ctrl">
                    <p class="muted small rx-note">Files go to the Recycle Bin, so they can be restored from there or with Ctrl+Z.</p>
                  </div>
                </div>
              </Show>
            </section>

            <section class="rx-card">
              <h3 class="rx-card-title">Schedule</h3>
              <div class="rx-row rx-row-top">
                <span class="rx-label">
                  <span>Presets</span>
                  <span class="rx-hint muted small">One-click schedules</span>
                </span>
                <div class="rx-ctrl rx-stack">
                  <div class="ax-chips rx-chips" aria-label="Schedule presets">
                    <For each={SCHEDULE_PRESETS}>
                      {(p) => <button class="ax-chip" onClick={() => setSchedule(p.patch)}>{p.label}</button>}
                    </For>
                  </div>
                </div>
              </div>
              <div class="rx-row">
                <span class="rx-label">Frequency</span>
                <div class="rx-ctrl">
                  <Segmented label="Schedule frequency" value={draft().schedule.mode} options={SCHEDULE_MODES} onChange={(mode) => setSchedule({ mode })} />
                </div>
              </div>
              <Show when={draft().schedule.mode === "interval"}>
                <div class="rx-row">
                  <span class="rx-label">Run every</span>
                  <div class="rx-ctrl rx-num-row">
                    <input
                      class="text-input rx-num"
                      type="number"
                      min="1"
                      max="999"
                      aria-label="Interval amount"
                      value={draft().schedule.every}
                      onInput={(e) => setSchedule({ every: Math.max(1, Math.min(999, Math.floor(Number(e.currentTarget.value) || 1))) })}
                    />
                    <select
                      class="text-input rx-select"
                      aria-label="Interval unit"
                      value={draft().schedule.unit}
                      onChange={(e) => setSchedule({ unit: e.currentTarget.value as IntervalUnit })}
                    >
                      <option value="minutes">minutes</option>
                      <option value="hours">hours</option>
                      <option value="days">days</option>
                    </select>
                  </div>
                </div>
              </Show>
              <Show when={draft().schedule.mode === "weekly"}>
                <div class="rx-row">
                  <label class="rx-label" for="rule-weekday">Day of week</label>
                  <div class="rx-ctrl">
                    <select
                      id="rule-weekday"
                      class="text-input rx-select"
                      value={draft().schedule.weekday}
                      onChange={(e) => setSchedule({ weekday: Number(e.currentTarget.value) })}
                    >
                      <For each={WEEKDAY_NAMES}>{(d, idx) => <option value={idx()}>{d}</option>}</For>
                    </select>
                  </div>
                </div>
              </Show>
              <Show when={draft().schedule.mode === "monthly"}>
                <div class="rx-row">
                  <label class="rx-label" for="rule-monthday">Day of month</label>
                  <div class="rx-ctrl rx-num-row">
                    <input
                      id="rule-monthday"
                      class="text-input rx-num"
                      type="number"
                      min="1"
                      max="31"
                      value={draft().schedule.monthDay}
                      onInput={(e) => setSchedule({ monthDay: Math.max(1, Math.min(31, Math.floor(Number(e.currentTarget.value) || 1))) })}
                    />
                    <span class="muted small">(1–31)</span>
                  </div>
                </div>
              </Show>
              <Show when={draft().schedule.mode === "daily" || draft().schedule.mode === "weekly" || draft().schedule.mode === "monthly"}>
                <div class="rx-row">
                  <label class="rx-label" for="rule-time">At time</label>
                  <div class="rx-ctrl">
                    <input
                      id="rule-time"
                      class="text-input rx-time"
                      type="time"
                      value={draft().schedule.time}
                      onInput={(e) => setSchedule({ time: e.currentTarget.value || "09:00" })}
                    />
                  </div>
                </div>
              </Show>
              <Show when={draft().schedule.mode !== "manual" && draft().schedule.mode !== "startup"}>
                <div class="rx-row rx-row-top">
                  <span class="rx-label">
                    <span>Run for</span>
                    <span class="rx-hint muted small">Optional stop limit</span>
                  </span>
                  <div class="rx-ctrl rx-stack">
                    <Segmented label="Schedule duration" value={draft().schedule.limitKind} options={LIMIT_KINDS} onChange={(limitKind) => setSchedule({ limitKind })} />
                    <Show when={draft().schedule.limitKind !== "forever"}>
                      <div class="rx-num-row" style={{ display: "flex", "align-items": "center" }}>
                        <input
                          class="text-input rx-num"
                          type="number"
                          min="1"
                          max="999"
                          aria-label="Limit value"
                          value={draft().schedule.limitValue}
                          onInput={(e) => setSchedule({ limitValue: Math.max(1, Math.min(999, Math.floor(Number(e.currentTarget.value) || 1))) })}
                        />
                        <Show when={draft().schedule.limitKind === "runs"} fallback={
                          <select
                            class="text-input rx-select"
                            aria-label="Duration unit"
                            value={draft().schedule.limitUnit}
                            onChange={(e) => setSchedule({ limitUnit: e.currentTarget.value as "hours" | "days" })}
                          >
                            <option value="hours">hours</option>
                            <option value="days">days</option>
                          </select>
                        }>
                          <span class="muted small">runs, then stop</span>
                        </Show>
                      </div>
                    </Show>
                  </div>
                </div>
              </Show>
              <Show when={draft().schedule.mode !== "manual"}>
                <div class="rx-row">
                  <span class="rx-label">When due</span>
                  <div class="rx-ctrl">
                    <Segmented label="When due" value={draft().schedule.actionMode} options={ACTION_MODES} onChange={(actionMode) => setSchedule({ actionMode })} />
                  </div>
                </div>
              </Show>
            </section>

            <div class="ax-preview rx-summary-card" aria-live="polite">
              <span class="muted small">
                {ruleSummary(draft())} · <strong>{scheduleSummary(draft().schedule)}</strong>
              </span>
              <Show when={live()} fallback={<span class="muted small">Fill in the folder to see how many files match.</span>}>
                {(l) => <code class="rx-live-count">{l()}</code>}
              </Show>
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
