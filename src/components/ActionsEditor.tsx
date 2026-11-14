// Custom actions: the list, an editor for one action, and a gallery of ready-made ones.
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import * as A from "../actions";
import { ACTION_PRESETS, PRESET_GROUPS } from "../lib/actionPresets";
import {
  actionApplies,
  actionsToJson,
  batchActionFromPath,
  batchActionFromText,
  expandCommand,
  isBatchPath,
  leadingProgram,
  NEW_ACTION,
  newActionId,
  parseActionsText,
  parseExtensions,
  placeholderNeeds,
  uniqueActionName,
  type CustomAction,
} from "../lib/customActions";
import { errorText, programExists } from "../lib/ipc";
import { formatKeys } from "../lib/keymap";
import { isDir } from "../lib/listing";
import { downloadText, readTextFile } from "../lib/textFile";
import { customActions, type AddBatchResult } from "../state/customActions";
import { carriesPaths, dragRaw, dragState, isExternalDrag, onDragReset } from "../state/drag";
import { keybindings } from "../state/keybindings";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";
import { Checkbox } from "./Checkbox";
import { IconPlay, MaterialIcon } from "./Icons";
import { Segmented, Toggle } from "./settings/controls";

type View = "list" | "edit" | "presets";

const PLACEHOLDERS: readonly { token: string; hint: string }[] = [
  { token: "{path}", hint: "The first selected item" },
  { token: "{paths}", hint: "All selected items, separated by spaces" },
  { token: "{pslist}", hint: "All selected items as a PowerShell list: 'a','b'" },
  { token: "{dir}", hint: "The folder you are viewing" },
  { token: "{parent}", hint: "The folder containing the first item" },
  { token: "{name}", hint: "Name of the first item" },
  { token: "{stem}", hint: "Its name without the extension" },
  { token: "{ext}", hint: "Its extension" },
  { token: "{list}", hint: "A text file listing every selected path (for very long selections)" },
  { token: "{pickfolder}", hint: "Asks you to choose a folder" },
  { token: "{prompt:Label}", hint: "Asks you to type a value" },
];

export function ActionsEditor() {
  const [view, setView] = createSignal<View>("list");
  const [filter, setFilter] = createSignal("");
  const [draft, setDraft] = createSignal<CustomAction>(NEW_ACTION);
  const [extText, setExtText] = createSignal("");
  const [missing, setMissing] = createSignal<string | null>(null);
  const [dropHot, setDropHot] = createSignal(false);
  let dragDepth = 0;
  let commandEl: HTMLTextAreaElement | undefined;
  let fileEl: HTMLInputElement | undefined;

  onCleanup(
    onDragReset(() => {
      dragDepth = 0;
      setDropHot(false);
    }),
  );

  const list = () => customActions.list();
  const shown = () => {
    const q = filter().trim().toLowerCase();
    return q ? list().filter((a) => `${a.name} ${a.command}`.toLowerCase().includes(q)) : list();
  };
  const close = () => ui.setActionsEditorOpen(false);
  const set = (patch: Partial<CustomAction>) => setDraft({ ...draft(), ...patch });

  const edit = (a: CustomAction) => {
    setDraft(a);
    setExtText(a.extensions.join(", "));
    setView("edit");
  };
  const add = (a: Omit<CustomAction, "id">) => customActions.save([...list(), { ...a, id: newActionId(), name: uniqueActionName(a.name, list().map((x) => x.name)) }]);
  const patchOne = (id: string, patch: Partial<CustomAction>) => customActions.save(list().map((a) => (a.id === id ? { ...a, ...patch } : a)));

  const commit = () => {
    const d = draft();
    const a: CustomAction = { ...d, name: d.name.trim(), extensions: parseExtensions(extText()), id: d.id || newActionId() };
    if (!a.name || !a.command.trim()) return ui.toast("An action needs a name and a command");
    const taken = list().filter((x) => x.id !== a.id).map((x) => x.name);
    if (taken.some((n) => n.toLowerCase() === a.name.toLowerCase())) return ui.toast("Another action already has that name");
    customActions.save(list().some((x) => x.id === a.id) ? list().map((x) => (x.id === a.id ? a : x)) : [...list(), a]);
    setView("list");
  };

  const remove = (a: CustomAction) =>
    ui.ask({
      title: `Remove "${a.name}"?`,
      body: "The action is deleted, along with its shortcut. Export your actions first if you may want it back.",
      confirmLabel: "Remove",
      danger: true,
      onConfirm: () => {
        customActions.save(list().filter((x) => x.id !== a.id));
        keybindings.reset(`action:${a.id}`);
      },
    });

  const duplicate = (a: CustomAction) => add({ ...a, name: `${a.name} copy`, enabled: a.enabled });

  const activeExplorerFolder = (): string => {
    const t = workspace.activeTab();
    if (!t || t.archive()) return "";
    const picked = [...t.selection()];
    const entry = picked.length ? picked[0] : t.view()[t.focus()];
    if (entry !== undefined && isDir(t.listing(), entry)) return t.pathOf(entry);
    return t.path();
  };

  const runOne = (a: CustomAction) => {
    const t = workspace.activeTab();
    if (!t) return ui.toast("No active folder tab");
    if (!actionApplies(a, A.targetItems(t))) return ui.toast(`"${a.name}" doesn't apply to this selection`);
    close();
    void A.runAction(t, a);
  };

  const announceBatchResult = (res: AddBatchResult) => {
    setFilter("");
    setView("list");
    const total = [...res.added, ...res.existing];
    if (total.length === 1) {
      const target = total[0];
      const msg = res.added.length ? `Added "${target.name}" as a runnable action` : `"${target.name}" is already in Custom actions`;
      ui.toast(msg, workspace.activeTab() ? { label: "Run", onClick: () => runOne(target) } : undefined);
      return;
    }
    if (res.added.length && res.existing.length) {
      ui.toast(`Added ${res.added.length} batch action${res.added.length === 1 ? "" : "s"} (${res.existing.length} already present)`);
    } else if (res.added.length) {
      ui.toast(`Added ${res.added.length} batch action${res.added.length === 1 ? "" : "s"}`);
    } else if (res.existing.length) {
      ui.toast(`${res.existing.length} batch action${res.existing.length === 1 ? " is" : "s are"} already in Custom actions`);
    }
  };

  const acceptsDrop = (dt: DataTransfer | null) => {
    if (!dt) return false;
    if (isExternalDrag(dt)) return dt.types.includes("Files");
    return carriesPaths(dt) && dragState.paths.some(isBatchPath);
  };

  const handleDrop = async (e: DragEvent) => {
    dragDepth = 0;
    setDropHot(false);
    const dt = e.dataTransfer;
    if (!dt) return;
    if (isExternalDrag(dt) && dt.files.length) {
      e.preventDefault();
      e.stopPropagation();
      const files = [...dt.files];
      const batFiles = files.filter((f) => isBatchPath(f.name));
      const jsonFiles = files.filter((f) => /\.json$/i.test(f.name));
      if (!batFiles.length && !jsonFiles.length) {
        return ui.toast("Drop .bat or .cmd files to add them as runnable actions");
      }
      if (batFiles.length) {
        const candidates = await Promise.all(
          batFiles.map(async (f) => {
            const nativePath = (f as File & { path?: string }).path;
            return nativePath ? batchActionFromPath(nativePath) : batchActionFromText(f.name, await f.text());
          }),
        );
        announceBatchResult(customActions.addBatchActions(candidates));
      }
      for (const jf of jsonFiles) {
        try {
          const incoming = parseActionsText(await jf.text());
          const names = list().map((a) => a.name);
          const added = incoming.map((a) => {
            const name = uniqueActionName(a.name, names);
            names.push(name);
            return { ...a, name, id: newActionId() };
          });
          customActions.save([...list(), ...added]);
          ui.toast(`Added ${added.length} action${added.length === 1 ? "" : "s"}`);
        } catch (err) {
          ui.toast(errorText(err));
        }
      }
      return;
    }
    if (carriesPaths(dt)) {
      const raw = dragRaw(dt);
      const paths = raw ? (JSON.parse(raw) as string[]) : [];
      const bats = paths.filter(isBatchPath);
      if (!bats.length) return ui.toast("Drop .bat or .cmd files to add them as runnable actions");
      e.preventDefault();
      e.stopPropagation();
      announceBatchResult(customActions.addBatchActions(bats.map(batchActionFromPath)));
    }
  };

  const insert = (token: string) => {
    const el = commandEl;
    const text = draft().command;
    if (!el) return set({ command: text + token });
    const [s, e] = [el.selectionStart, el.selectionEnd];
    set({ command: text.slice(0, s) + token + text.slice(e) });
    queueMicrotask(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = s + token.length;
    });
  };

  // What the command becomes for what is selected right now.
  const sample = createMemo(() => {
    const t = workspace.activeTab();
    const real = t && !t.archive() ? A.targets(t) : [];
    return { paths: real.length ? real : ["C:\\Users\\You\\Documents\\report.pdf"], dir: t?.path() ?? "C:\\Users\\You\\Documents", real: real.length > 0 };
  });
  const preview = () => {
    const d = draft();
    const needs = placeholderNeeds(d.command);
    const prompts = Object.fromEntries(needs.prompts.map((p) => [p, `‹${p}›`]));
    const paths = d.each ? sample().paths.slice(0, 1) : sample().paths;
    return expandCommand(d.command, paths, sample().dir, { shell: d.shell, prompts, folder: "C:\\Chosen\\Folder", list: "C:\\Temp\\octopolis-actions\\list.txt" });
  };

  // Warn when the program the command starts with can't be found.
  createEffect(() => {
    const d = draft();
    if (view() !== "edit") return;
    const prog = leadingProgram(d.command, d.shell);
    setMissing(null);
    if (!prog) return;
    let stale = false;
    const timer = setTimeout(() => {
      programExists(prog).then((ok) => !stale && setMissing(ok ? null : prog), () => undefined);
    }, 400);
    onCleanup(() => {
      stale = true;
      clearTimeout(timer);
    });
  });

  const importFile = async (e: Event & { currentTarget: HTMLInputElement }) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (!file) return;
    try {
      const incoming = parseActionsText(await readTextFile(file));
      const names = list().map((a) => a.name);
      const added = incoming.map((a) => {
        const name = uniqueActionName(a.name, names);
        names.push(name);
        return { ...a, name, id: newActionId() };
      });
      customActions.save([...list(), ...added]);
      ui.toast(`Added ${added.length} action${added.length === 1 ? "" : "s"}`);
    } catch (err) {
      ui.toast(errorText(err));
    }
  };
  const exportAll = async (how: "copy" | "file") => {
    if (list().length === 0) return ui.toast("There are no actions to export");
    try {
      if (how === "copy") {
        await navigator.clipboard.writeText(actionsToJson(list()));
        ui.toast("Actions copied as JSON");
      } else downloadText("octopolis-actions.json", actionsToJson(list()));
    } catch (err) {
      ui.toast(errorText(err));
    }
  };

  const shortcutOf = (a: CustomAction) => keybindings.keysForId(`action:${a.id}`).map(formatKeys).join("  ");
  const added = (name: string) => list().some((a) => a.name.toLowerCase() === name.toLowerCase());

  const badges = (a: CustomAction) => [a.shell === "powershell" ? "PowerShell" : "cmd", a.elevate ? "Admin" : "", a.mode === "console" ? "Console" : "", a.each ? "Each item" : ""].filter(Boolean);
  const scope = (a: CustomAction) => {
    const parts: string[] = [];
    if (a.target !== "any") parts.push(a.target === "files" ? "Files" : "Folders");
    if (a.extensions.length) parts.push(a.extensions.join(", "));
    if (a.namePattern.trim()) parts.push(a.namePattern.trim());
    if (a.minItems || a.maxItems) parts.push(a.maxItems === 1 ? "1 item" : `${a.minItems || 1}${a.maxItems ? `–${a.maxItems}` : "+"} items`);
    return parts.length ? parts.join(" · ") : "Any item";
  };

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="dialog actions-dialog2"
        classList={{ "ax-drop-hot": dropHot() }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="actions-title"
        onDragEnter={(e) => {
          if (!acceptsDrop(e.dataTransfer)) return;
          e.preventDefault();
          dragDepth++;
          setDropHot(true);
        }}
        onDragOver={(e) => {
          if (!acceptsDrop(e.dataTransfer)) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
          setDropHot(true);
        }}
        onDragLeave={() => {
          dragDepth = Math.max(0, dragDepth - 1);
          if (dragDepth === 0) setDropHot(false);
        }}
        onDrop={(e) => void handleDrop(e)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") return view() !== "list" ? setView("list") : close();
        }}
      >
        <Show when={dropHot()}>
          <div class="ax-drop-overlay" aria-hidden="true">
            <MaterialIcon name="terminal" size={28} />
            <strong>Drop .bat or .cmd files</strong>
            <span class="muted small">Adds each batch script as a runnable custom action</span>
          </div>
        </Show>
        <div class="ax-head">
          <Show when={view() !== "list"}>
            <button class="btn small icon-btn" aria-label="Back" title="Back" onClick={() => setView("list")}>
              <MaterialIcon name="arrow_back" size={16} />
            </button>
          </Show>
          <h2 id="actions-title">{view() === "edit" ? (draft().id ? "Edit action" : "New action") : view() === "presets" ? "Presets" : "Custom actions"}</h2>
          <span class="muted small ax-sub">
            {view() === "list" ? "Run from right-click → Actions…, the command palette, or a shortcut" : view() === "presets" ? "Only Windows' own cmd and PowerShell. Add one, then change it if you like" : ""}
          </span>
        </div>

        <Show when={view() === "list"}>
          <div class="ax-bar">
            <input class="text-input" placeholder="Filter actions" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
            <button class="btn small primary" onClick={() => edit({ ...NEW_ACTION, workDir: activeExplorerFolder() })}><MaterialIcon name="add" size={15} /> New</button>
            <button class="btn small" onClick={() => setView("presets")}><MaterialIcon name="auto_fix_high" size={15} /> Presets</button>
            <button class="btn small" title="Add actions from a JSON file" onClick={() => fileEl?.click()}><MaterialIcon name="upload_file" size={15} /> Import</button>
            <input ref={fileEl} type="file" accept=".json,application/json" hidden onChange={(e) => void importFile(e)} />
            <button class="btn small icon-btn" title="Copy all as JSON" aria-label="Copy all actions as JSON" onClick={() => void exportAll("copy")}><MaterialIcon name="data_object" size={16} /></button>
            <button class="btn small icon-btn" title="Save all as a file" aria-label="Save all actions as a file" onClick={() => void exportAll("file")}><MaterialIcon name="download" size={16} /></button>
          </div>
          <div class="ax-list">
            <For each={shown()} fallback={<p class="muted ax-empty">{list().length ? "No action matches." : "No actions yet. Add one, start from the presets, or drop .bat / .cmd files here."}</p>}>
              {(a) => (
                <div class="ax-row" classList={{ off: !a.enabled, "ax-new": customActions.highlighted().includes(a.id) }}>
                  <Toggle label={`${a.name} enabled`} checked={a.enabled} onChange={(enabled) => patchOne(a.id, { enabled })} />
                  <span class="ax-main">
                    <span class="ax-name">{a.name}</span>
                    <code class="muted small ax-cmd">{a.command}</code>
                    <span class="ax-meta small">
                      <span class="muted">{scope(a)}</span>
                      <For each={badges(a)}>{(b) => <span class="ax-badge" classList={{ warn: b === "Admin" }}>{b}</span>}</For>
                      <Show when={shortcutOf(a)}>{(k) => <kbd>{k()}</kbd>}</Show>
                    </span>
                  </span>
                  <span class="ax-buttons">
                    <button class="btn small icon-btn" title="Run" aria-label={`Run ${a.name}`} onClick={() => runOne(a)}><IconPlay size={15} /></button>
                    <button class="btn small icon-btn" title="Edit" aria-label={`Edit ${a.name}`} onClick={() => edit(a)}><MaterialIcon name="edit" size={16} /></button>
                    <button class="btn small icon-btn" title="Duplicate" aria-label={`Duplicate ${a.name}`} onClick={() => duplicate(a)}><MaterialIcon name="content_copy" size={16} /></button>
                    <button class="btn small icon-btn" title="Remove" aria-label={`Remove ${a.name}`} onClick={() => remove(a)}><MaterialIcon name="delete" size={16} /></button>
                  </span>
                </div>
              )}
            </For>
            <Show when={list().length > 0}>
              <div class="ax-drop-hint muted small">
                <MaterialIcon name="terminal" size={14} />
                <span>Tip: Drag and drop <code>.bat</code> or <code>.cmd</code> files here to add them as runnable actions.</span>
              </div>
            </Show>
          </div>
        </Show>

        <Show when={view() === "presets"}>
          <div class="ax-list ax-presets">
            <For each={PRESET_GROUPS}>
              {(g) => (
                <section>
                  <h3>{g.title}</h3>
                  <For each={ACTION_PRESETS.filter((p) => p.group === g.id)}>
                    {(p) => (
                      <div class="ax-row">
                        <span class="ax-main">
                          <span class="ax-name">{p.action.name}</span>
                          <span class="muted small">{p.description}</span>
                          <span class="ax-meta small">
                            <span class="muted">{scope({ ...NEW_ACTION, ...p.action, id: "" })}</span>
                            <For each={badges({ ...NEW_ACTION, ...p.action, id: "" })}>{(b) => <span class="ax-badge" classList={{ warn: b === "Admin" }}>{b}</span>}</For>
                          </span>
                        </span>
                        <button class="btn small" disabled={added(p.action.name)} onClick={() => (add(p.action), ui.toast(`Added "${p.action.name}"`))}>
                          {added(p.action.name) ? "Added" : "Add"}
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
              <input class="text-input" maxLength={80} value={draft().name} onInput={(e) => set({ name: e.currentTarget.value })} ref={(el) => queueMicrotask(() => el.focus())} />
            </label>
            <div class="ax-field">
              <span>Runs in</span>
              <Segmented<"cmd" | "powershell"> label="Shell" value={draft().shell} options={[{ value: "cmd", label: "Command Prompt" }, { value: "powershell", label: "PowerShell" }]} onChange={(shell) => set({ shell })} />
            </div>
            <label class="ax-field">
              <span>Command</span>
              <textarea ref={commandEl} class="text-input mono" rows="3" spellcheck={false} value={draft().command} onInput={(e) => set({ command: e.currentTarget.value })} />
            </label>
            <div class="ax-chips" aria-label="Placeholders">
              <For each={PLACEHOLDERS}>{(p) => <button class="ax-chip" title={p.hint} onClick={() => insert(p.token)}>{p.token}</button>}</For>
            </div>
            <div class="ax-preview" aria-live="polite">
              <span class="muted small">{sample().real ? "With your current selection" : "Example (select something to see yours)"}</span>
              <code>{draft().command.trim() ? preview() : "…"}</code>
              <Show when={missing()}>{(m) => <span class="ax-warn small"><MaterialIcon name="warning" size={14} /> "{m()}" wasn't found on this PC's PATH</span>}</Show>
              <Show when={draft().each && sample().paths.length > 1 && sample().real}>
                <span class="muted small">Runs {sample().paths.length} times, once per item. The first is shown.</span>
              </Show>
            </div>

            <h3>Shows up for</h3>
            <div class="ax-field">
              <span>Items</span>
              <Segmented<"any" | "files" | "folders"> label="Applies to" value={draft().target} options={[{ value: "any", label: "Any" }, { value: "files", label: "Files" }, { value: "folders", label: "Folders" }]} onChange={(target) => set({ target })} />
            </div>
            <label class="ax-field">
              <span>File types (blank: any)</span>
              <input class="text-input" placeholder="mp4, mov" value={extText()} onInput={(e) => setExtText(e.currentTarget.value)} />
            </label>
            <label class="ax-field">
              <span>Names matching (blank: any)</span>
              <input class="text-input" placeholder="*.log; report?.txt" value={draft().namePattern} onInput={(e) => set({ namePattern: e.currentTarget.value })} />
            </label>
            <div class="ax-field">
              <span>Number of items</span>
              <span class="ax-count">
                <input class="text-input" type="number" min="0" aria-label="Fewest items" value={draft().minItems} onInput={(e) => set({ minItems: Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)) })} />
                <span class="muted small">to</span>
                <input class="text-input" type="number" min="0" aria-label="Most items" value={draft().maxItems} onInput={(e) => set({ maxItems: Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)) })} />
                <span class="muted small">(0: no limit)</span>
              </span>
            </div>

            <h3>When it runs</h3>
            <Checkbox class="props-check" checked={draft().each} onChange={(each) => set({ each })}>Run once for each selected item</Checkbox>
            <Checkbox class="props-check" checked={draft().mode === "console"} onChange={(checked) => set({ mode: checked ? "console" : "hidden" })}>Show a console window (to see the output)</Checkbox>
            <Checkbox class="props-check" checked={draft().elevate} onChange={(elevate) => set({ elevate, confirm: elevate ? true : draft().confirm })}>Run as administrator (Windows asks first)</Checkbox>
            <Checkbox class="props-check" checked={draft().confirm} onChange={(confirm) => set({ confirm })}>Show the command and ask before running</Checkbox>
            <Checkbox class="props-check" checked={draft().refresh} onChange={(refresh) => set({ refresh })}>Reload the folder when it finishes</Checkbox>
            <label class="ax-field">
              <span>Start in folder (blank: the folder you are viewing)</span>
              <input class="text-input mono" spellcheck={false} placeholder={activeExplorerFolder() || "The folder you are viewing"} value={draft().workDir} onInput={(e) => set({ workDir: e.currentTarget.value })} />
            </label>
            <Show when={draft().id}>
              <div class="ax-field">
                <span>Shortcut</span>
                <span class="ax-shortcut">
                  <Show when={shortcutOf(draft())} fallback={<span class="muted small">None</span>}>{(k) => <kbd>{k()}</kbd>}</Show>
                  <button class="btn small" onClick={() => (close(), ui.openSettings("shortcuts"))}>Set in Shortcuts…</button>
                </span>
              </div>
            </Show>
          </div>
        </Show>

        <div class="dialog-actions">
          <Show when={view() === "edit"} fallback={<button class="btn primary" onClick={close}>Done</button>}>
            <button class="btn" onClick={() => setView("list")}>Cancel</button>
            <button class="btn primary" onClick={commit}>Save action</button>
          </Show>
        </div>
      </div>
    </div>
  );
}
