import { Show } from "solid-js";
import { VERSION } from "../../lib/app";
import { describeStatus, type LatestRelease } from "../../lib/update";
import { splitReleases } from "../../lib/whatsNew";
import { type UpdateMode, settings } from "../../state/settings";
import { ui } from "../../state/ui";
import { updater } from "../../state/updater";
import changelog from "../../../CHANGELOG.md?raw";
import { ChangelogText } from "../Changelog";
import { Glyph, MaterialIcon } from "../Icons";
import { Section, Segmented, SettingRow, type Option } from "./controls";

const MODES: readonly Option<UpdateMode>[] = [
  { value: "off", label: "Off" },
  { value: "notify", label: "Notify me" },
  { value: "auto", label: "Automatic" },
];

const MODE_HINT: Record<UpdateMode, string> = {
  off: "Octopolis never checks by itself. You can still check here whenever you like.",
  notify: "Checks once a day and tells you when an update is ready. You choose when to install.",
  auto: "Downloads updates in the background and installs them once the PC has been idle for 10 minutes.",
};

const TONE_GLYPH = { neutral: "E895", good: "E73E", bad: "E783" } as const;

export function UpdatesTab() {
  const view = () => describeStatus(updater.status(), VERSION);
  const release = (): LatestRelease | undefined => {
    const s = updater.status();
    return "release" in s ? s.release : undefined;
  };
  const latestChangelog = () =>
    splitReleases(changelog).find((r) => r.version === VERSION)?.text ??
    splitReleases(changelog)[0]?.text ??
    changelog;
  return (
    <>
      <section class="sset">
        <h3 class="sset-title">Updates</h3>
        <div class="update-card" classList={{ good: view().tone === "good", bad: view().tone === "bad" }}>
          <span class="update-glyph">
            <Show when={view().busy} fallback={<Glyph code={TONE_GLYPH[view().tone]} size={20} />}>
              <MaterialIcon name="schedule" size={20} />
            </Show>
          </span>
          <div class="update-text" role="status" aria-live="polite">
            <div class="update-title">{view().title}</div>
            <div class="update-detail">{view().detail}</div>
          </div>
          <Show when={view().action}>
            {(a) => (
              <button class="btn" classList={{ primary: a().step !== "check" }} disabled={updater.busy()} onClick={() => updater.run(a().step)}>
                {a().label}
              </button>
            )}
          </Show>
        </div>
        <Show when={release()}>
          {(r) => (
            <Show when={r().notes.trim()}>
              <div class="update-notes">
                <div class="update-notes-title">What's in {r().version}</div>
                <ChangelogText text={r().notes} />
              </div>
            </Show>
          )}
        </Show>
      </section>

      <Section title="Automatic updates">
        <SettingRow label="When to update" hint={MODE_HINT[settings.updateMode()]}>
          <Segmented label="Automatic updates" value={settings.updateMode()} options={MODES} onChange={(updateMode) => settings.set({ updateMode })} />
        </SettingRow>
        <SettingRow label="Privacy" hint="The only request Octopolis makes is asking GitHub for the latest release. Nothing about you or your PC is sent." />
      </Section>

      <section class="sset">
        <div class="sset-head">
          <h3 class="sset-title">What's new</h3>
          <button class="btn small" onClick={() => ui.setWhatsNewText(changelog)}>
            View changelogs
          </button>
        </div>
        <div class="sset-card padded">
          <ChangelogText text={latestChangelog()} />
        </div>
      </section>
    </>
  );
}
