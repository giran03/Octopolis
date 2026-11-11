// Editing custom actions: name, command line with placeholders, file types and how it runs.
import { createSignal, For, Show } from "solid-js";
import { parseExtensions, type CustomAction } from "../lib/customActions";
import { customActions } from "../state/customActions";
import { ui } from "../state/ui";

const EMPTY: CustomAction = { name: "", command: "", extensions: [], mode: "hidden" };

const EXAMPLES: readonly CustomAction[] = [
  { name: "Open in VS Code", command: "code {paths}", extensions: [], mode: "hidden" },
  { name: "Convert to MP4", command: 'ffmpeg -i {path} "{stem}.mp4"', extensions: ["mov", "mkv", "avi", "webm"], mode: "console" },
  { name: "Git log here", command: "git log --oneline -20", extensions: [], mode: "console" },
];

export function ActionsEditor() {
  const [list, setList] = createSignal<CustomAction[]>([...customActions.list()]);
  const [editing, setEditing] = createSignal<number | null>(null);
  const [draft, setDraft] = createSignal<CustomAction>(EMPTY);
  const [extText, setExtText] = createSignal("");

  const edit = (i: number | null, a: CustomAction = EMPTY) => {
    setEditing(i);
    setDraft(a);
    setExtText(a.extensions.join(", "));
  };
  const commit = () => {
    const a = { ...draft(), name: draft().name.trim(), extensions: parseExtensions(extText()) };
    if (!a.name || !a.command.trim()) return ui.toast("An action needs a name and a command");
    const i = editing();
    const next = i === null || i < 0 ? [...list(), a] : list().map((x, n) => (n === i ? a : x));
    setList(next);
    customActions.save(next);
    setEditing(null);
  };
  const remove = (i: number) => {
    const next = list().filter((_, n) => n !== i);
    setList(next);
    customActions.save(next);
  };
  const close = () => ui.setActionsEditorOpen(false);

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="dialog bin-dialog actions-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="actions-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") return editing() !== null ? setEditing(null) : close();
        }}
      >
        <div class="bin-head">
          <h2 id="actions-title">Custom actions</h2>
          <span class="muted small">Shown under Actions… in the right-click menu</span>
        </div>
        <Show
          when={editing() !== null}
          fallback={
            <>
              <div class="bin-list">
                <For each={list()} fallback={<p class="muted bin-empty">No actions yet. Add one, or start from an example.</p>}>
                  {(a, i) => (
                    <div class="bin-row">
                      <span />
                      <span class="bin-names">
                        <span class="bin-name">{a.name}</span>
                        <code class="muted small bin-from">{a.command}</code>
                      </span>
                      <span class="muted small bin-meta">{a.extensions.length ? a.extensions.join(", ") : "Any item"}</span>
                      <span class="action-buttons">
                        <button class="link-btn small" onClick={() => edit(i(), a)}>Edit</button>
                        <button class="link-btn small" onClick={() => remove(i())}>Remove</button>
                      </span>
                    </div>
                  )}
                </For>
              </div>
              <div class="dupes-bar">
                <button class="btn primary" onClick={() => edit(-1)}>Add action</button>
                <span class="muted small">Examples:</span>
                <For each={EXAMPLES}>{(x) => <button class="link-btn small" onClick={() => edit(-1, x)}>{x.name}</button>}</For>
              </div>
            </>
          }
        >
          <div class="action-form">
            <label class="settings-import">
              Name
              <input class="text-input" value={draft().name} onInput={(e) => setDraft({ ...draft(), name: e.currentTarget.value })} ref={(el) => queueMicrotask(() => el.focus())} />
            </label>
            <label class="settings-import">
              Command
              <input class="text-input mono" spellcheck={false} value={draft().command} onInput={(e) => setDraft({ ...draft(), command: e.currentTarget.value })} />
            </label>
            <p class="muted small">
              {"{path}"} first selected item · {"{paths}"} all of them · {"{dir}"} this folder · {"{name}"} its name · {"{stem}"} name without extension. Paths are quoted for you.
            </p>
            <label class="settings-import">
              Only for these file types (blank: any item)
              <input class="text-input" placeholder="mp4, mov" value={extText()} onInput={(e) => setExtText(e.currentTarget.value)} />
            </label>
            <label class="props-check">
              <input type="checkbox" checked={draft().mode === "console"} onChange={(e) => setDraft({ ...draft(), mode: e.currentTarget.checked ? "console" : "hidden" })} />
              Show a console window (to see its output)
            </label>
          </div>
        </Show>
        <div class="dialog-actions">
          <Show when={editing() !== null} fallback={<button class="btn primary" onClick={close}>Done</button>}>
            <button class="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button class="btn primary" onClick={commit}>Save action</button>
          </Show>
        </div>
      </div>
    </div>
  );
}
