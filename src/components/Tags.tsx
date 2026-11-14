// Tags and color labels: editing them, listing tagged items, and the sidebar's
// Tags and Searches sections.
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { errorText, pathsAreDirs, runPath, tagsInDir, taggedPaths } from "../lib/ipc";
import { baseName, parentPath } from "../lib/paths";
import { TAB_COLORS } from "../lib/session";
import { savedSearches } from "../state/savedSearches";
import { tags } from "../state/tags";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";
import { Checkbox } from "./Checkbox";
import { Glyph, IconClose, IconCopy, IconRefresh, IconSearch, IconSort, TypeIcon } from "./Icons";

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
              <Checkbox class="props-check" checked={state(t) === "all"} indeterminate={state(t) === "some"} onChange={(checked) => void toggle(t, checked)}>
                {t}
              </Checkbox>
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
  const [paths, { refetch }] = createResource(
    () => [props.tag, tags.version()] as const,
    ([t]) => taggedPaths(t).catch(() => [] as string[]),
  );
  const [dirMap] = createResource(
    () => paths.latest ?? null,
    async (list) => {
      if (!list.length) return new Map<string, boolean>();
      const flags = await pathsAreDirs(list).catch(() => list.map(() => false));
      const out = new Map<string, boolean>();
      list.forEach((p, i) => out.set(p, Boolean(flags[i])));
      return out;
    },
  );
  const [filter, setFilter] = createSignal("");
  const [sortBy, setSortBy] = createSignal<"name" | "folder">("name");
  const [confirmClear, setConfirmClear] = createSignal(false);

  const isDir = (p: string) => dirMap()?.get(p) ?? false;
  const close = () => ui.setTaggedView(null);
  const showInFolder = (p: string) => {
    const dir = parentPath(p);
    close();
    if (dir) void workspace.activeTab()?.navigate(dir, [baseName(p)]);
  };
  const openItem = (p: string) => {
    if (isDir(p)) {
      close();
      void workspace.activeTab()?.navigate(p);
    } else {
      close();
      void runPath(p).catch((e) => ui.toast(errorText(e)));
    }
  };
  const copyPath = (p: string) => {
    void navigator.clipboard.writeText(p).then(
      () => ui.toast("Copied path"),
      () => ui.toast("Could not copy path"),
    );
  };
  const untag = async (target: readonly string[]) => {
    if (!target.length) return;
    try {
      await tags.set(target, props.tag, false);
      setConfirmClear(false);
      await refetch();
      ui.toast(target.length === 1 ? `Removed tag from ${baseName(target[0])}` : `Removed tag from ${target.length} items`);
    } catch (e) {
      ui.toast(errorText(e));
    }
  };

  const labelFor = (t: string) => (isColorTag(t) ? `${COLOR_LABEL[t.toLowerCase()]} label` : t);
  const title = () => (isColorTag(props.tag) ? `${COLOR_LABEL[props.tag.toLowerCase()]} label` : `Tag: ${props.tag}`);

  const visible = createMemo(() => {
    const list = paths.latest ?? [];
    const q = filter().trim().toLowerCase();
    const filtered = q ? list.filter((p) => baseName(p).toLowerCase().includes(q) || (parentPath(p) ?? "").toLowerCase().includes(q)) : [...list];
    return filtered.sort((a, b) => {
      if (sortBy() === "folder") {
        const cmp = (parentPath(a) ?? "").localeCompare(parentPath(b) ?? "");
        if (cmp !== 0) return cmp;
      }
      return baseName(a).localeCompare(baseName(b));
    });
  });

  const countLabel = () => {
    const total = paths.latest?.length ?? 0;
    const shown = visible().length;
    if (filter().trim() && shown !== total) return `${shown} of ${total} ${total === 1 ? "item" : "items"}`;
    return `${total} ${total === 1 ? "item" : "items"}`;
  };

  const rowMenu = (e: MouseEvent, p: string) => {
    e.preventDefault();
    ui.openMenu(e.clientX, e.clientY, [
      { label: isDir(p) ? "Open folder" : "Open", run: () => openItem(p) },
      { label: "Show in folder", run: () => showInFolder(p) },
      { label: "Copy path", run: () => copyPath(p) },
      {
        label: "Edit tags…",
        run: () => {
          close();
          ui.setTagPaths([p]);
        },
      },
      { label: `Remove "${labelFor(props.tag)}"`, danger: true, run: () => void untag([p]) },
    ]);
  };

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="dialog bin-dialog tagged-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tagged-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") close();
        }}
      >
        <div class="bin-head">
          <div class="tagged-title-wrap">
            <Show when={isColorTag(props.tag)} fallback={<Glyph code="E8EC" size={16} />}>
              <span class="tag-dot big" style={{ background: `var(--tab-${props.tag.toLowerCase()})` }} />
            </Show>
            <h2 id="tagged-title">{title()}</h2>
          </div>
          <span class="muted small">{countLabel()}</span>
        </div>

        <Show when={tags.all().length > 1}>
          <div class="tagged-switcher" role="tablist" aria-label="Switch tag">
            <For each={tags.all()}>
              {([t, n]) => {
                const active = () => t.toLowerCase() === props.tag.toLowerCase();
                return (
                  <button
                    class="tagged-chip"
                    classList={{ active: active() }}
                    role="tab"
                    aria-selected={active()}
                    onClick={() => {
                      setConfirmClear(false);
                      ui.setTaggedView(t);
                    }}
                  >
                    <Show when={isColorTag(t)} fallback={<Glyph code="E8EC" size={12} />}>
                      <span class="tag-dot" style={{ background: `var(--tab-${t.toLowerCase()})` }} />
                    </Show>
                    <span>{isColorTag(t) ? COLOR_LABEL[t.toLowerCase()] : t}</span>
                    <span class="tagged-chip-count">{n}</span>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>

        <div class="tagged-toolbar">
          <div class="tagged-search">
            <IconSearch size={14} class="muted" />
            <input
              class="tagged-search-input"
              placeholder="Filter by name or folder…"
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value)}
            />
            <Show when={filter().length > 0}>
              <button class="icon-btn tiny" aria-label="Clear filter" onClick={() => setFilter("")}>
                <IconClose size={12} />
              </button>
            </Show>
          </div>
          <button
            class="btn small tagged-sort-btn"
            onClick={() => setSortBy((s) => (s === "name" ? "folder" : "name"))}
            data-tooltip={`Sorted by ${sortBy() === "name" ? "name" : "folder"} · Click to switch`}
          >
            <IconSort size={14} />
            <span>{sortBy() === "name" ? "Name" : "Folder"}</span>
          </button>
          <button class="icon-btn" aria-label="Refresh tagged items" data-tooltip="Refresh" onClick={() => void refetch()}>
            <IconRefresh size={15} />
          </button>
        </div>

        <Show when={paths.latest !== undefined} fallback={<p class="muted bin-empty">Loading…</p>}>
          <div class="bin-list" aria-busy={paths.loading}>
            <For
              each={visible()}
              fallback={
                <p class="muted bin-empty">
                  {filter().trim() ? "No tagged items match your filter" : "Nothing carries this tag anymore"}
                </p>
              }
            >
              {(p) => (
                <div
                  class="bin-row tagged-row"
                  onDblClick={() => showInFolder(p)}
                  onContextMenu={(e) => rowMenu(e, p)}
                >
                  <TypeIcon path={p} name={baseName(p)} isDir={isDir(p)} size={18} />
                  <span class="bin-names">
                    <span class="bin-name">{baseName(p)}</span>
                    <span class="muted small bin-from">{parentPath(p)}</span>
                  </span>
                  <div class="tagged-row-actions">
                    <button class="link-btn small" onClick={() => openItem(p)} title={isDir(p) ? "Open folder" : "Open file"}>
                      Open
                    </button>
                    <button class="link-btn small" onClick={() => showInFolder(p)} title="Reveal in parent folder">
                      Show
                    </button>
                    <button class="icon-btn tiny" aria-label="Copy path" data-tooltip="Copy path" onClick={() => copyPath(p)}>
                      <IconCopy size={13} />
                    </button>
                    <button
                      class="icon-btn tiny tagged-remove-btn"
                      aria-label="Remove tag"
                      data-tooltip="Remove tag"
                      onClick={() => void untag([p])}
                    >
                      <IconClose size={13} />
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <div class="dialog-actions bin-actions">
          <Show when={(paths.latest?.length ?? 0) > 0}>
            <Show
              when={confirmClear()}
              fallback={
                <button class="btn small" onClick={() => setConfirmClear(true)}>
                  Remove from all
                </button>
              }
            >
              <div class="tagged-confirm">
                <span class="muted small">Remove tag from all {paths.latest?.length}?</span>
                <button class="btn small danger" onClick={() => void untag(paths.latest ?? [])}>
                  Confirm
                </button>
                <button class="btn small" onClick={() => setConfirmClear(false)}>
                  Cancel
                </button>
              </div>
            </Show>
          </Show>
          <span class="bin-spacer" />
          <Show when={visible().length > 0}>
            <button
              class="btn small"
              onClick={() => copyPath(visible().join("\n"))}
              data-tooltip="Copy all visible paths"
            >
              Copy paths
            </button>
          </Show>
          <button class="btn primary" onClick={close}>
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
