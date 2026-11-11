// "These names already exist": choose Replace, Skip or Keep both, for all items or one by one.
import { createMemo, createSignal, For, Show } from "solid-js";
import { canReplace, isNewer, type NameConflict, type Resolution } from "../lib/conflicts";
import { formatDate, formatSize } from "../lib/format";
import { baseName } from "../lib/paths";
import { ui, type ConflictPrompt } from "../state/ui";
import { Segmented, type Option } from "./settings/controls";
import { FileIcon } from "./Icons";
import { Select } from "./Select";

const ALL_CHOICES: readonly Option<Resolution>[] = [
  { value: "replace", label: "Replace" },
  { value: "newer", label: "Replace if newer" },
  { value: "skip", label: "Skip" },
  { value: "keepBoth", label: "Keep both" },
];

const ITEM_CHOICES: readonly Option<Resolution>[] = ALL_CHOICES.filter((c) => c.value !== "newer");

/** Rows shown at most; larger batches are decided with the "for all" choice. */
const MAX_ROWS = 200;

function describeSide(c: NameConflict, which: "source" | "target") {
  const s = c[which];
  const size = s.isDir ? "Folder" : formatSize(s.size);
  return s.modifiedMs ? `${size} · ${formatDate(s.modifiedMs)}` : size;
}

export function ConflictDialog(props: { prompt: ConflictPrompt }) {
  const p = () => props.prompt;
  const [fallback, setFallback] = createSignal<Resolution>("keepBoth");
  const [choices, setChoices] = createSignal<ReadonlyMap<string, Resolution>>(new Map());
  const keyOf = (c: NameConflict) => c.source.path.toLowerCase();

  const effective = (c: NameConflict): Resolution => {
    const r = choices().get(keyOf(c)) ?? fallback();
    if (r === "newer") return canReplace(c) && isNewer(c) ? "replace" : "skip";
    return r === "replace" && !canReplace(c) ? "keepBoth" : r;
  };
  const replacing = createMemo(() => p().conflicts.filter((c) => effective(c) === "replace"));
  const losesData = () => replacing().some((c) => !c.target.isDir);

  const setAll = (r: Resolution) => {
    setFallback(r);
    setChoices(new Map());
  };
  const setOne = (c: NameConflict, r: Resolution) => setChoices((m) => new Map(m).set(keyOf(c), r));
  const finish = (ok: boolean) => {
    ui.closeConflicts();
    p().onResolve(ok ? choices() : null, fallback());
  };

  const count = () => p().conflicts.length;
  const title = () => (count() === 1 ? `"${baseName(p().conflicts[0].source.path)}" already exists` : `${count()} items already exist`);

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && finish(false)}>
      <div
        class="dialog conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") finish(false);
        }}
      >
        <h2 id="conflict-title">{title()}</h2>
        <p>
          {p().kind === "move" ? "Moving" : "Copying"} {p().total === 1 ? "1 item" : `${p().total} items`} to <bdi class="conflict-dest">{baseName(p().dest) || p().dest}</bdi>. Choose what to do with the names that are taken.
        </p>
        <div class="conflict-all">
          <span class="muted small">{count() === 1 ? "This item" : "All of them"}</span>
          <Segmented label="Choice for all conflicting items" value={choices().size ? ("" as Resolution) : fallback()} options={ALL_CHOICES} onChange={setAll} />
        </div>
        <Show when={count() > 1}>
          <ul class="conflict-list">
            <For each={p().conflicts.slice(0, MAX_ROWS)}>
              {(c) => (
                <li class="conflict-row">
                  <FileIcon name={baseName(c.source.path)} isDir={c.source.isDir} size={18} />
                  <div class="conflict-names">
                    <span class="conflict-name">{baseName(c.source.path)}</span>
                    <span class="muted small">
                      Incoming: {describeSide(c, "source")}
                      <Show when={!c.source.isDir && isNewer(c)}>
                        <span class="conflict-badge">newer</span>
                      </Show>
                    </span>
                    <span class="muted small">Existing: {describeSide(c, "target")}</span>
                  </div>
                  <Select
                    class="conflict-choice"
                    label={`What to do with ${baseName(c.source.path)}`}
                    value={effective(c)}
                    options={ITEM_CHOICES.filter((o) => o.value !== "replace" || canReplace(c)).map((o) => ({
                      value: o.value,
                      label: c.source.isDir && o.value === "replace" ? "Merge" : o.label,
                    }))}
                    onChange={(v) => setOne(c, v)}
                  />
                </li>
              )}
            </For>
            <Show when={count() > MAX_ROWS}>
              <li class="muted small">{count() - MAX_ROWS} more follow the choice for all.</li>
            </Show>
          </ul>
        </Show>
        <Show when={count() === 1}>
          <div class="conflict-compare">
            <div>
              <span class="muted small">Incoming</span>
              <span>{describeSide(p().conflicts[0], "source")}</span>
            </div>
            <div>
              <span class="muted small">Existing</span>
              <span>{describeSide(p().conflicts[0], "target")}</span>
            </div>
          </div>
        </Show>
        <Show when={losesData()}>
          <p class="conflict-warn small">Replaced files are overwritten. Undo can't bring the old versions back.</p>
        </Show>
        <div class="dialog-actions">
          <button class="btn" onClick={() => finish(false)}>
            Cancel
          </button>
          <button class="btn primary" ref={(b) => queueMicrotask(() => b.focus())} onClick={() => finish(true)}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
