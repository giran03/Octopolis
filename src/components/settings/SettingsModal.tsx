// The settings dialog: a rail of tabs on the left and the active tab's settings on the right.
import { createEffect, For, Match, onMount, Switch } from "solid-js";
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

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

export function SettingsModal() {
  let dialog!: HTMLDivElement;
  let panel!: HTMLDivElement;
  const tab = () => ui.settingsTab() ?? "general";
  const index = () => Math.max(0, TABS.findIndex((t) => t.id === tab()));

  onMount(() => dialog.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus());
  // Each tab starts at the top.
  createEffect(() => {
    tab();
    if (panel) panel.scrollTop = 0;
  });

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") return ui.closeSettings();
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
          <div class="srail-tabs" role="tablist" aria-orientation="vertical" style={{ "--i": index() }} onKeyDown={onRailKey}>
            <For each={TABS}>
              {(t) => (
                <button class="stab" role="tab" id={`stab-${t.id}`} aria-selected={tab() === t.id} aria-controls="spanel" tabIndex={tab() === t.id ? 0 : -1} onClick={() => ui.setSettingsTab(t.id)}>
                  <Glyph code={t.code} size={16} />
                  <span class="stab-label">{t.label}</span>
                  {t.id === "updates" && updater.status().kind === "available" ? <span class="stab-dot" aria-label="Update available" /> : null}
                  {t.id === "updates" && updater.status().kind === "ready" ? <span class="stab-dot" aria-label="Update ready" /> : null}
                </button>
              )}
            </For>
          </div>
        </nav>
        <div class="spane">
          <header class="spane-head">
            <h2>{TABS[index()].label}</h2>
            <button class="icon-btn" aria-label="Close settings" data-tooltip="Close · Esc" onClick={ui.closeSettings}>
              <IconClose size={14} />
            </button>
          </header>
          <div ref={panel} class="spanel" id="spanel" role="tabpanel" aria-labelledby={`stab-${tab()}`}>
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
          </div>
        </div>
      </div>
    </div>
  );
}
