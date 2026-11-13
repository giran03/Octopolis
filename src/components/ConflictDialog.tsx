// "These names already exist": choose Replace, Skip or Keep both, for all items or one by one.
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { canReplace, isNewer, type ConflictSide, type NameConflict, type Resolution } from "../lib/conflicts";
import { categoryOf, formatDate, formatSize } from "../lib/format";
import { thumbnail } from "../lib/ipc";
import { baseName, parentPath } from "../lib/paths";
import { loadCachedThumb, peekThumb, thumbCacheKey } from "../state/thumbs";
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

const THUMB_PX = 128;

const isImageSide = (s: ConflictSide) => !s.isDir && categoryOf(baseName(s.path), false) === "image";

function describeSide(c: NameConflict, which: "source" | "target") {
  const s = c[which];
  const size = s.isDir ? "Folder" : formatSize(s.size);
  return s.modifiedMs ? `${size} · ${formatDate(s.modifiedMs)}` : size;
}

function ConflictThumb(props: { side: ConflictSide }) {
  const [url, setUrl] = createSignal<string | null>(null);
  createEffect(() => {
    const s = props.side;
    const cached = s.modifiedMs > 0 ? peekThumb(thumbCacheKey(s.path, s.modifiedMs, THUMB_PX)) : undefined;
    if (cached !== undefined) {
      setUrl(cached);
      return;
    }
    setUrl(null);
    let alive = true;
    let ownedUrl: string | null = null;
    if (s.modifiedMs > 0) {
      void loadCachedThumb(s.path, s.modifiedMs, THUMB_PX).then((u) => {
        if (alive) setUrl(u);
      });
    } else {
      thumbnail(s.path, THUMB_PX, false).then(
        (b) => {
          if (!alive) return;
          ownedUrl = URL.createObjectURL(new Blob([b], { type: "image/png" }));
          setUrl(ownedUrl);
        },
        () => undefined,
      );
    }
    onCleanup(() => {
      alive = false;
      if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    });
  });

  return (
    <Show when={url()} fallback={<FileIcon name={baseName(props.side.path)} isDir={props.side.isDir} size={32} />}>
      {(u) => <img class="conflict-thumb-img" src={u()} alt={baseName(props.side.path)} />}
    </Show>
  );
}

function ConflictSideCard(props: { label: string; side: ConflictSide; other: ConflictSide; showThumb: boolean }) {
  const newer = () => !props.side.isDir && props.other.modifiedMs > 0 && props.side.modifiedMs > props.other.modifiedMs;
  const larger = () => !props.side.isDir && !props.other.isDir && props.side.size > props.other.size;
  const folder = () => parentPath(props.side.path) ?? props.side.path;

  return (
    <div class="conflict-side">
      <div class="conflict-side-head">
        <span class="muted small conflict-side-label">{props.label}</span>
        <div class="conflict-side-badges">
          <Show when={newer()}>
            <span class="conflict-badge">newer</span>
          </Show>
          <Show when={larger()}>
            <span class="conflict-badge subtle">larger</span>
          </Show>
        </div>
      </div>
      <div class="conflict-side-body">
        <div class="conflict-side-preview" classList={{ image: props.showThumb }}>
          <Show when={props.showThumb} fallback={<FileIcon name={baseName(props.side.path)} isDir={props.side.isDir} size={32} />}>
            <ConflictThumb side={props.side} />
          </Show>
        </div>
        <dl class="conflict-side-meta">
          <dt>Size</dt>
          <dd title={props.side.isDir ? undefined : `${props.side.size.toLocaleString()} bytes`}>
            {props.side.isDir ? "Folder" : formatSize(props.side.size)}
          </dd>
          <dt>Modified</dt>
          <dd>{props.side.modifiedMs ? formatDate(props.side.modifiedMs) : "Unknown"}</dd>
          <dt>Folder</dt>
          <dd class="conflict-side-path" title={props.side.path}>
            <bdi>{folder()}</bdi>
          </dd>
        </dl>
      </div>
    </div>
  );
}

export function ConflictDialog(props: { prompt: ConflictPrompt }) {
  const p = () => props.prompt;
  const [fallback, setFallback] = createSignal<Resolution>("keepBoth");
  const [choices, setChoices] = createSignal<ReadonlyMap<string, Resolution>>(new Map());
  const [selected, setSelected] = createSignal(0);
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
  const activeConflict = () => p().conflicts[Math.min(selected(), Math.max(0, count() - 1))];
  const bothImages = () => {
    const c = activeConflict();
    return !!c && isImageSide(c.source) && isImageSide(c.target);
  };
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
              {(c, i) => (
                <li class="conflict-row" classList={{ selected: selected() === i() }} onClick={() => setSelected(i())}>
                  <FileIcon name={baseName(c.source.path)} isDir={c.source.isDir} size={18} />
                  <div class="conflict-names">
                    <span class="conflict-name">{baseName(c.source.path)}</span>
                    <span class="muted small">
                      Source: {describeSide(c, "source")}
                      <Show when={!c.source.isDir && isNewer(c)}>
                        <span class="conflict-badge">newer</span>
                      </Show>
                    </span>
                    <span class="muted small">Destination: {describeSide(c, "target")}</span>
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
        <Show when={activeConflict()}>
          {(c) => (
            <div class="conflict-compare">
              <ConflictSideCard label="Source (Incoming)" side={c().source} other={c().target} showThumb={bothImages()} />
              <ConflictSideCard label="Destination (Existing)" side={c().target} other={c().source} showThumb={bothImages()} />
            </div>
          )}
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
