// The settings dialog: a rail of tabs on the left and the active tab's settings on the right.
import { createEffect, createSignal, For, Match, onCleanup, onMount, Show, Switch, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { ui, type SettingsTab } from "../../state/ui";
import { updater } from "../../state/updater";
import { Glyph, IconClose } from "../Icons";
import { AboutTab } from "./AboutTab";
import { AdvancedTab } from "./AdvancedTab";
import { AppearanceTab } from "./AppearanceTab";
import { GeneralTab } from "./GeneralTab";
import { ShortcutsTab } from "./ShortcutsTab";
import { UpdatesTab } from "./UpdatesTab";

const TABS: readonly { readonly id: SettingsTab; readonly label: string; readonly code: string }[] = [
  { id: "general", label: "General", code: "E713" },
  { id: "appearance", label: "Appearance", code: "E790" },
  { id: "shortcuts", label: "Shortcuts", code: "E765" },
  { id: "advanced", label: "Advanced", code: "E9E9" },
  { id: "updates", label: "Updates", code: "E895" },
  { id: "about", label: "About", code: "E946" },
];

const PANELS: Record<SettingsTab, Component> = { general: GeneralTab, appearance: AppearanceTab, shortcuts: ShortcutsTab, advanced: AdvancedTab, updates: UpdatesTab, about: AboutTab };

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

export function SettingsModal() {
  let dialog!: HTMLDivElement;
  let panel!: HTMLDivElement;
  let searchInput!: HTMLInputElement;
  const tab = () => ui.settingsTab() ?? "general";
  const index = () => Math.max(0, TABS.findIndex((t) => t.id === tab()));

  onMount(() => dialog.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus());
  // Each tab starts at the top.
  createEffect(() => {
    tab();
    if (panel) panel.scrollTop = 0;
  });

  // Outline: the section headings of the open tab, found in the rendered page so every tab gets one.
  const [outline, setOutline] = createSignal<HTMLElement[]>([]);
  const [current, setCurrent] = createSignal(0);
  // Search: shows every tab's settings stacked and hides the rows that don't match.
  const [query, setQuery] = createSignal("");
  const [noResults, setNoResults] = createSignal(false);
  const searching = () => query().trim().length > 0;
  const ROW_SEL = ".srow, .shortcut-row";
  const applyFilter = () => {
    const q = query().trim().toLowerCase();
    const rows = [...panel.querySelectorAll<HTMLElement>(ROW_SEL)];
    for (const row of rows) row.hidden = !!q && !(row.textContent ?? "").toLowerCase().includes(q);
    for (const section of panel.querySelectorAll<HTMLElement>(".sset")) {
      const title = (section.querySelector(".sset-title")?.textContent ?? "").toLowerCase();
      const sectionRows = [...section.querySelectorAll<HTMLElement>(ROW_SEL)];
      if (sectionRows.length > 0) {
        const hasRow = sectionRows.some((r) => !r.hidden);
        section.hidden = !!q && !hasRow && !title.includes(q);
        // A section whose title matches, but none of its rows do, shows all its rows.
        if (q && !hasRow && title.includes(q)) for (const r of sectionRows) r.hidden = false;
      } else {
        const cardText = (section.querySelector(".update-card")?.textContent ?? "").toLowerCase();
        section.hidden = !!q && !title.includes(q) && !cardText.includes(q);
      }
    }
    for (const group of panel.querySelectorAll<HTMLElement>(".sres-tab")) group.hidden = !!q && ![...group.querySelectorAll<HTMLElement>(".sset")].some((s) => !s.hidden);
    setNoResults(!!q && ![...panel.querySelectorAll<HTMLElement>(".sset")].some((s) => !s.hidden));
  };
  createEffect(() => {
    query();
    queueMicrotask(() => {
      if (panel) applyFilter();
    });
  });

  const scan = () => {
    applyFilter();
    const found = [...panel.querySelectorAll<HTMLElement>(".sset-title")].filter((el) => !el.closest<HTMLElement>(".sset")?.hidden);
    const same = (a: HTMLElement[], b: HTMLElement[]) => a.length === b.length && a.every((el, i) => el === b[i]);
    if (!same(found, outline())) setOutline(found);
    spy();
  };
  const spy = () => {
    const items = outline();
    const top = panel.getBoundingClientRect().top + 24;
    let active = 0;
    items.forEach((el, i) => {
      if (el.getBoundingClientRect().top <= top) active = i;
    });
    if (panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 2 && items.length) active = items.length - 1;
    setCurrent(active);
  };
  const jump = (el: HTMLElement) => {
    const section = el.closest<HTMLElement>(".sset") ?? el;
    section.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const jumpToTab = (id: SettingsTab, target?: { sectionTitle?: string; rowLabel?: string }) => {
    setQuery("");
    ui.setSettingsTab(id);
    if (!target) return;
    queueMicrotask(() => {
      if (!panel) return;
      let match: HTMLElement | undefined;
      if (target.rowLabel) {
        const label = target.rowLabel;
        match =
          [...panel.querySelectorAll<HTMLElement>(".srow")].find((r) => r.querySelector(".srow-label")?.textContent?.trim() === label) ??
          [...panel.querySelectorAll<HTMLElement>(".shortcut-row")].find((r) => r.querySelector(".shortcut-title")?.textContent?.trim() === label);
      } else if (target.sectionTitle) {
        const title = target.sectionTitle;
        match = [...panel.querySelectorAll<HTMLElement>(".sset")].find((s) => s.querySelector(".sset-title")?.textContent?.trim() === title);
      }
      if (!match) return;
      match.scrollIntoView({ block: "center", behavior: "smooth" });
      match.classList.add("srow-flash");
      setTimeout(() => match.classList.remove("srow-flash"), 1400);
    });
  };
  const onPanelClick = (e: MouseEvent) => {
    if (!searching()) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, select, textarea, a, .srow-control, .shortcut-actions")) return;
    const group = target.closest<HTMLElement>(".sres-tab");
    const tabId = group?.dataset.tab as SettingsTab | undefined;
    if (!tabId) return;
    const srowText = target.closest<HTMLElement>(".srow-text");
    if (srowText) {
      const label = srowText.querySelector(".srow-label")?.textContent?.trim();
      if (label) return jumpToTab(tabId, { rowLabel: label });
    }
    const shortcutTitle = target.closest<HTMLElement>(".shortcut-title");
    if (shortcutTitle) {
      const label = shortcutTitle.textContent?.trim();
      if (label) return jumpToTab(tabId, { rowLabel: label });
    }
    const ssetTitle = target.closest<HTMLElement>(".sset-title");
    if (ssetTitle) {
      const title = ssetTitle.textContent?.trim();
      if (title) return jumpToTab(tabId, { sectionTitle: title });
    }
  };
  onMount(() => {
    const mo = new MutationObserver(scan);
    mo.observe(panel, { childList: true, subtree: true });
    panel.addEventListener("scroll", spy, { passive: true });
    scan();
    onCleanup(() => {
      mo.disconnect();
      panel.removeEventListener("scroll", spy);
    });
  });

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") return ui.closeSettings();
    if (e.ctrlKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      searchInput?.focus();
      searchInput?.select();
      return;
    }
    if (e.key === "Tab") {
      // Keep focus inside the dialog.
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    }
  };

  const onRailKey = (e: KeyboardEvent) => {
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!step && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : (index() + step + TABS.length) % TABS.length;
    ui.setSettingsTab(TABS[next].id);
    queueMicrotask(() => dialog.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus());
  };

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && ui.closeSettings()}>
      <div ref={dialog} class="dialog settings-modal" role="dialog" aria-modal="true" aria-label="Settings" onKeyDown={onKey}>
        <nav class="srail" aria-label="Settings sections">
          <div class="srail-title">Settings</div>
          <input
            ref={searchInput}
            class="text-input ssearch"
            type="search"
            placeholder="Search settings"
            aria-label="Search settings"
            spellcheck={false}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query()) {
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
          <div class="srail-tabs" role="tablist" aria-orientation="vertical" style={{ "--i": index() }} onKeyDown={onRailKey}>
            <For each={TABS}>
              {(t) => (
                <button class="stab" role="tab" id={`stab-${t.id}`} aria-selected={tab() === t.id} aria-controls="spanel" tabIndex={tab() === t.id ? 0 : -1} onClick={() => jumpToTab(t.id)}>
                  <Glyph code={t.code} size={16} />
                  <span class="stab-label">{t.label}</span>
                  {t.id === "updates" && updater.status().kind === "available" ? <span class="stab-dot" aria-label="Update available" /> : null}
                  {t.id === "updates" && updater.status().kind === "ready" ? <span class="stab-dot" aria-label="Update ready" /> : null}
                </button>
              )}
            </For>
          </div>
          <Show when={outline().length > 1}>
            <div class="srail-divider" role="separator" />
            <div class="srail-title">On this page</div>
            <div class="sout">
              <For each={outline()}>
                {(el, i) => (
                  <button class="sout-link" classList={{ on: current() === i() }} aria-current={current() === i() ? "location" : undefined} onClick={() => jump(el)}>
                    {el.textContent}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </nav>
        <div class="spane">
          <header class="spane-head">
            <h2>{searching() ? "Search results" : TABS[index()].label}</h2>
            <button class="icon-btn" aria-label="Close settings" data-tooltip="Close · Esc" onClick={ui.closeSettings}>
              <IconClose size={14} />
            </button>
          </header>
          <div ref={panel} class="spanel" id="spanel" role="tabpanel" aria-labelledby={`stab-${tab()}`} onClick={onPanelClick}>
            <Show when={searching()}>
              <For each={TABS}>
                {(t) => (
                  <section class="sres-tab" data-tab={t.id}>
                    <button type="button" class="sres-head" onClick={() => jumpToTab(t.id)}>
                      <span>{t.label}</span>
                      <span class="sres-jump">Open {t.label} →</span>
                    </button>
                    <Dynamic component={PANELS[t.id]} />
                  </section>
                )}
              </For>
              <p class="muted sres-none" hidden={!noResults()}>No setting matches "{query().trim()}"</p>
            </Show>
            <Show when={!searching()}>
            <Switch>
              <Match when={tab() === "general"}>
                <GeneralTab />
              </Match>
              <Match when={tab() === "appearance"}>
                <AppearanceTab />
              </Match>
              <Match when={tab() === "shortcuts"}>
                <ShortcutsTab />
              </Match>
              <Match when={tab() === "advanced"}>
                <AdvancedTab />
              </Match>
              <Match when={tab() === "updates"}>
                <UpdatesTab />
              </Match>
              <Match when={tab() === "about"}>
                <AboutTab />
              </Match>
            </Switch>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
