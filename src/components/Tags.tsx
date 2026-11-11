// Tags and color labels: editing them, listing tagged items, and the sidebar's
// Tags and Searches sections.
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { errorText, tagsInDir, taggedPaths } from "../lib/ipc";
import { baseName, parentPath } from "../lib/paths";
import { TAB_COLORS } from "../lib/session";
import { savedSearches } from "../state/savedSearches";
import { tags } from "../state/tags";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";
import { Glyph } from "./Icons";

/** Color labels are tags named after a color. */
export const isColorTag = (t: string) => (TAB_COLORS as readonly string[]).includes(t.toLowerCase());
const COLOR_LABEL: Record<string, string> = { red: "Red", orange: "Orange", yellow: "Yellow", green: "Green", blue: "Blue", purple: "Purple" };

/** Tags of the items in `dir`, reloaded whenever any tag changes. */
export function createDirTags(dir: () => string | null) {
  const [map] = createResource(
    () => {
      const d = dir();
      return d ? ([d, tags.version()] as const) : null;
    },
    ([d]) => tagsInDir(d).then((rows) => new Map(rows)).catch(() => new Map<string, string[]>()),
  );
  return () => map() ?? null;
}

/** Colored dots and a tag mark for one row. */
export function TagMarks(props: { tags: readonly string[] | undefined }) {
  const all = () => props.tags ?? [];
  const colors = () => all().filter(isColorTag);
  const named = () => all().filter((t) => !isColorTag(t));
  return (
    <Show when={all().length > 0}>
      <span class="tag-marks" title={all().join(", ")} aria-label={`Tags: ${all().join(", ")}`}>
        <For each={colors()}>{(c) => <span class="tag-dot" style={{ background: `var(--tab-${c.toLowerCase()})` }} />}</For>
        <Show when={named().length > 0}>
          <Glyph code="E8EC" size={11} />
        </Show>
      </span>
    </Show>
  );
}

/** Edit tags for one or more items. Changes apply as you click. */
export function TagsDialog(props: { paths: readonly string[] }) {
  const [current, { refetch }] = createResource(
    () => [...props.paths],
    async (paths) => {
      // Read each folder's tags once.
      const byDir = new Map<string, string[]>();
      for (const p of paths) {
        const dir = parentPath(p) ?? p;
        byDir.set(dir, [...(byDir.get(dir) ?? []), p]);
      }
      const out = new Map<string, readonly string[]>();
      for (const [dir, items] of byDir) {
        const rows = new Map(await tagsInDir(dir).catch(() => [] as [string, string[]][]));
        for (const p of items) out.set(p, rows.get(baseName(p).toLowerCase()) ?? []);
      }
      return out;
    },
  );
  const [draft, setDraft] = createSignal("");
  /** "all", "some" or "none" of the items carry `tag`. */
  const state = (tag: string) => {
    const m = current();
    if (!m) return "none";
    const n = [...m.values()].filter((t) => t.some((x) => x.toLowerCase() === tag.toLowerCase())).length;
    return n === 0 ? "none" : n === props.paths.length ? "all" : "some";
  };
  const toggle = async (tag: string, on = state(tag) !== "all") => {
    try {
      await tags.set(props.paths, tag, on);
      await refetch();
    } catch (e) {
      ui.toast(errorText(e));
    }
  };
  const named = createMemo(() => {
    const seen = new Map<string, string>();
    const note = (t: string) => !isColorTag(t) && !seen.has(t.toLowerCase()) && seen.set(t.toLowerCase(), t);
    for (const [t] of tags.all()) note(t);
    for (const ts of current()?.values() ?? []) ts.forEach(note);
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  });
  const add = () => {
    const t = draft().trim();
    if (!t) return;
    setDraft("");
    void toggle(t, true);
  };
  const close = () => ui.setTagPaths(null);
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="dialog tags-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tags-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") close();
        }}
      >
        <h2 id="tags-title">Tags · {props.paths.length === 1 ? baseName(props.paths[0]) : `${props.paths.length} items`}</h2>
        <div class="tag-colors" role="group" aria-label="Color labels">
          <For each={TAB_COLORS}>
            {(c) => (
              <button class="tag-swatch" classList={{ on: state(c) === "all", some: state(c) === "some" }} style={{ "--swatch": `var(--tab-${c})` }} aria-pressed={state(c) === "all"} aria-label={COLOR_LABEL[c]} title={COLOR_LABEL[c]} onClick={() => void toggle(c)} />
            )}
          </For>
        </div>
        <div class="tag-list">
          <For each={named()} fallback={<p class="muted small">No tags yet. Type one below.</p>}>
            {(t) => (
              <label class="props-check">
                <input type="checkbox" checked={state(t) === "all"} ref={(el) => queueMicrotask(() => (el.indeterminate = state(t) === "some"))} onChange={(e) => void toggle(t, e.currentTarget.checked)} />
                {t}
              </label>
            )}
          </For>
        </div>
        <div class="tag-add">
          <input
            class="text-input"
            placeholder="New tag, e.g. Work or Invoices"
            maxLength={40}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            ref={(el) => queueMicrotask(() => el.focus())}
          />
          <button class="btn" disabled={!draft().trim()} onClick={add}>
            Add
          </button>
        </div>
        <p class="muted small">Tags are kept by Octopolis, not inside the files. Search them with tag:name.</p>
        <div class="dialog-actions">
          <button class="btn primary" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/** Everything carrying one tag, wherever it is. */
export function TaggedList(props: { tag: string }) {
  const [paths] = createResource(() => props.tag, (t) => taggedPaths(t));
  const close = () => ui.setTaggedView(null);
  const open = (p: string) => {
    const dir = parentPath(p);
    close();
    if (dir) void workspace.activeTab()?.navigate(dir, [baseName(p)]);
  };
  const title = () => (isColorTag(props.tag) ? `${COLOR_LABEL[props.tag.toLowerCase()]} label` : `Tag: ${props.tag}`);
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="dialog bin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tagged-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") close();
        }}
      >
        <div class="bin-head">
          <h2 id="tagged-title">{title()}</h2>
          <span class="muted small">{paths()?.length ?? 0} items</span>
        </div>
        <Show when={paths()} fallback={<p class="muted">Loading…</p>}>
          {(list) => (
            <div class="bin-list">
              <For each={list()} fallback={<p class="muted bin-empty">Nothing carries this tag anymore</p>}>
                {(p) => (
                  <div class="bin-row" onDblClick={() => open(p)} title="Double-click to show it in its folder">
                    <Glyph code="E8B7" size={16} />
                    <span class="bin-names">
                      <span class="bin-name">{baseName(p)}</span>
                      <span class="muted small bin-from">{parentPath(p)}</span>
                    </span>
                    <span />
                    <button class="link-btn small" onClick={() => open(p)}>
                      Show
                    </button>
                  </div>
                )}
              </For>
            </div>
          )}
        </Show>
        <div class="dialog-actions">
          <button class="btn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Sidebar: every tag, opening the list of its items. */
export function TagItems() {
  return (
    <For each={tags.all()} fallback={<p class="side-empty">Tag items from their right-click menu.</p>}>
      {([t, n]) => (
        <button class="side-item" onClick={() => ui.setTaggedView(t)} data-tooltip={`${n} item${n === 1 ? "" : "s"}`}>
          <Show when={isColorTag(t)} fallback={<Glyph code="E8EC" size={16} />}>
            <span class="tag-dot big" style={{ background: `var(--tab-${t.toLowerCase()})` }} />
          </Show>
          <span class="side-label">{isColorTag(t) ? COLOR_LABEL[t.toLowerCase()] : t}</span>
          <span class="side-count">{n}</span>
        </button>
      )}
    </For>
  );
}

/** Sidebar: saved searches, run live when clicked. */
export function SearchItems() {
  const run = (root: string, query: string) => {
    const tab = workspace.activeTab();
    if (!tab) return;
    void tab.navigate(root).then(() => void tab.runSearch(query));
  };
  const menu = (e: MouseEvent, name: string) => {
    e.preventDefault();
    ui.openMenu(e.clientX, e.clientY, [{ label: "Remove saved search", danger: true, run: () => savedSearches.remove(name) }]);
  };
  return (
    <For each={savedSearches.list()} fallback={<p class="side-empty">Search a folder, then choose Save this search.</p>}>
      {(s) => (
        <button class="side-item" onClick={() => run(s.root, s.query)} onContextMenu={(e) => menu(e, s.name)} data-tooltip={`${s.query || "All files"} in ${s.root}`}>
          <Glyph code="E721" size={16} />
          <span class="side-label">{s.name}</span>
        </button>
      )}
    </For>
  );
}
