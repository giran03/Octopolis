// The Sort & Group button: sort field, direction, and grouping for the active tab.
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { GROUP_KEYS, GROUP_TITLES, type GroupKey } from "../lib/group";
import { DEFAULT_SORT, type SortKey } from "../lib/sort";
import { settings } from "../state/settings";
import type { TabModel } from "../state/tab";
import { IconSort, MaterialIcon } from "./Icons";

interface SortEntry {
  readonly key: SortKey;
  readonly label: string;
}

const SORT_ENTRIES: readonly SortEntry[] = [
  { key: "name", label: "Name" },
  { key: "modified", label: "Date modified" },
  { key: "type", label: "Type" },
  { key: "size", label: "Size" },
];

export function SortMenu(props: { tab: TabModel }) {
  let button!: HTMLButtonElement;
  let panel: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ left: 0, top: 0 });
  const close = () => setOpen(false);

  const place = () => {
    const z = Math.max(0.1, settings.uiScale() / 100);
    const r = button.getBoundingClientRect();
    const width = 232;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width));
    setPos({ left: left / z, top: (r.bottom + 4) / z });
  };

  const toggle = () => {
    if (open()) return close();
    place();
    setOpen(true);
    queueMicrotask(() => panel?.focus());
  };

  createEffect(() => {
    if (!open()) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (button.contains(t) || panel?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        button.focus();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
    });
  });

  const sort = () => props.tab.sort();
  const group = () => props.tab.groupBy();
  const searching = () => props.tab.search() !== null;
  const isCustom = () => sort().key !== DEFAULT_SORT.key || sort().dir !== DEFAULT_SORT.dir || group() !== "none";

  const entries = (): readonly SortEntry[] =>
    searching() ? [...SORT_ENTRIES, { key: "relevance", label: "Relevance" }] : SORT_ENTRIES;

  const setDir = (dir: 1 | -1) => {
    const cur = sort();
    if (cur.key === "relevance" || cur.dir === dir) return;
    props.tab.sortBy(cur.key);
  };

  const chooseGroup = (key: GroupKey) => {
    props.tab.setGroupBy(key);
  };

  const resetAll = () => {
    if (sort().key !== DEFAULT_SORT.key) props.tab.sortBy(DEFAULT_SORT.key);
    if (sort().dir !== DEFAULT_SORT.dir) props.tab.sortBy(DEFAULT_SORT.key);
    props.tab.setGroupBy("none");
  };

  const tooltip = () => {
    const s = sort();
    const label = entries().find((e) => e.key === s.key)?.label ?? s.key;
    const dir = s.key === "relevance" ? "" : s.dir === 1 ? " ↑" : " ↓";
    const g = group();
    return g === "none" ? `Sort: ${label}${dir}` : `Sort: ${label}${dir} · Group: ${GROUP_TITLES[g]}`;
  };

  return (
    <>
      <button
        ref={button}
        class="icon-btn sort-btn"
        classList={{ on: open(), custom: isCustom() }}
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-label="Sort and group"
        data-tooltip={tooltip()}
        onClick={toggle}
      >
        <IconSort size={16} />
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={panel}
            class="view-pop sort-pop"
            role="dialog"
            aria-label="Sort and group"
            tabIndex={-1}
            style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
          >
            <div class="sort-section-label muted small">Sort by</div>
            <For each={entries()}>
              {(e) => {
                const active = () => sort().key === e.key;
                return (
                  <button
                    class="view-opt"
                    classList={{ on: active() }}
                    aria-pressed={active()}
                    onClick={() => props.tab.sortBy(e.key)}
                  >
                    <span class="view-dot" aria-hidden="true">{active() ? "•" : ""}</span>
                    <span class="view-label">{e.label}</span>
                    <Show when={active() && e.key !== "relevance"}>
                      <MaterialIcon name={sort().dir === 1 ? "expand_less" : "expand_more"} size={16} />
                    </Show>
                  </button>
                );
              }}
            </For>
            <div class="sort-dir-row" role="group" aria-label="Sort direction">
              <button
                class="sort-dir-btn"
                classList={{ on: sort().dir === 1 && sort().key !== "relevance" }}
                disabled={sort().key === "relevance"}
                onClick={() => setDir(1)}
              >
                <MaterialIcon name="expand_less" size={14} />
                <span>Ascending</span>
              </button>
              <button
                class="sort-dir-btn"
                classList={{ on: sort().dir === -1 && sort().key !== "relevance" }}
                disabled={sort().key === "relevance"}
                onClick={() => setDir(-1)}
              >
                <MaterialIcon name="expand_more" size={14} />
                <span>Descending</span>
              </button>
            </div>
            <div class="view-sep" />
            <div class="sort-section-label muted small">Group by</div>
            <For each={GROUP_KEYS}>
              {(g) => {
                const active = () => group() === g;
                return (
                  <button
                    class="view-opt"
                    classList={{ on: active() }}
                    aria-pressed={active()}
                    disabled={searching() && g !== "none"}
                    onClick={() => chooseGroup(g)}
                  >
                    <span class="view-dot" aria-hidden="true">{active() ? "•" : ""}</span>
                    <span class="view-label">{GROUP_TITLES[g]}</span>
                  </button>
                );
              }}
            </For>
            <Show when={isCustom()}>
              <div class="view-sep" />
              <button class="view-opt" onClick={resetAll}>
                <span class="view-dot" aria-hidden="true" />
                <MaterialIcon name="restart_alt" size={16} />
                <span class="view-label">Reset to default</span>
              </button>
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  );
}
