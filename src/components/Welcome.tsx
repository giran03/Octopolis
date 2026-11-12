// First-run welcome: a short tour of what makes Octopolis different, with the look-and-feel choices people change first.
import { createSignal, For, Show } from "solid-js";
import { BUILT_IN_THEMES } from "../lib/themes";
import { type IconStyle, settings } from "../state/settings";
import { ui } from "../state/ui";
import { MaterialIcon } from "./Icons";
import { Segmented, Select, type Option } from "./settings/controls";

interface Step {
  readonly icon: string;
  readonly title: string;
  readonly lines: readonly string[];
}

const STEPS: readonly Step[] = [
  { icon: "vertical_split", title: "Work in tabs and split panes", lines: ["Ctrl+T opens a tab, Ctrl+\\ splits the pane. Drag items between panes to copy or move them.", "Middle-click a folder to open it in a new tab."] },
  { icon: "search", title: "Find things fast", lines: ["Ctrl+P jumps to a folder you use, Ctrl+Shift+P runs any command.", "Ctrl+Shift+F searches subfolders as you type, with filters like ext:pdf and size:>100mb."] },
  { icon: "inventory_2", title: "Keep it tidy", lines: ["The shelf collects files from many folders. Tags label them. Duplicates and Free up space (the mop in the sidebar) show what you can delete safely."] },
];

const ICON_STYLES: readonly Option<IconStyle>[] = [
  { value: "outlined", label: "Outlined" },
  { value: "rounded", label: "Rounded" },
  { value: "sharp", label: "Sharp" },
];

export function Welcome() {
  const [step, setStep] = createSignal(0);
  const last = STEPS.length; // the extra final step is the look-and-feel choice
  const finish = () => {
    settings.set({ welcomeSeen: true });
    ui.setWelcomeOpen(false);
  };
  const next = () => (step() >= last ? finish() : setStep(step() + 1));
  const themes = (): Option<string>[] => [{ value: "System", label: "Follow Windows" }, ...BUILT_IN_THEMES.map((t) => ({ value: t.name, label: t.name }))];

  return (
    <div class="scrim">
      <div
        class="dialog welcome"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") finish();
          else if (e.key === "ArrowRight" || e.key === "Enter") next();
          else if (e.key === "ArrowLeft" && step() > 0) setStep(step() - 1);
        }}
        ref={(el) => queueMicrotask(() => el.querySelector<HTMLElement>(".btn.primary")?.focus())}
      >
        <Show
          when={step() < last}
          fallback={
            <div class="welcome-body">
              <MaterialIcon name="palette" size={40} class="welcome-icon" />
              <h2 id="welcome-title">Make it yours</h2>
              <p class="muted">You can change all of this later in Settings → Appearance.</p>
              <div class="welcome-choices">
                <label>
                  <span>Theme</span>
                  <Select label="Theme" value={settings.theme()} options={themes()} onChange={settings.setTheme} />
                </label>
                <label>
                  <span>Icon style</span>
                  <Segmented label="Icon style" value={settings.iconStyle()} options={ICON_STYLES} onChange={(iconStyle) => settings.set({ iconStyle })} />
                </label>
              </div>
            </div>
          }
        >
          <div class="welcome-body">
            <MaterialIcon name={STEPS[step()].icon} size={40} class="welcome-icon" />
            <h2 id="welcome-title">{STEPS[step()].title}</h2>
            <For each={STEPS[step()].lines}>{(l) => <p class="muted">{l}</p>}</For>
          </div>
        </Show>
        <div class="welcome-foot">
          <span class="welcome-dots" aria-hidden="true">
            <For each={[...STEPS, null]}>{(_, i) => <span classList={{ on: i() === step() }} />}</For>
          </span>
          <span class="bin-spacer" />
          <button class="btn" onClick={finish}>Skip</button>
          <button class="btn primary" onClick={next}>{step() >= last ? "Start using Octopolis" : "Next"}</button>
        </div>
      </div>
    </div>
  );
}
