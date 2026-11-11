import { createSignal, Show } from "solid-js";
import { APP_NAME, COFFEE_URL, COPYRIGHT, DEVELOPER, LICENSE, REPO, SUPPORT_EMAIL, TAGLINE, VERSION } from "../../lib/app";
import { debugInfo, openDataFolder, openExternal } from "../../lib/ipc";
import { ui } from "../../state/ui";
import { AppMark, Glyph } from "../Icons";
import { Section, SettingRow } from "./controls";

const MIT_BODY = [
  "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:",
  "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.",
  "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.",
];

const failed = (what: string) => (e: unknown) => ui.toast(`Couldn't ${what}: ${typeof e === "string" ? e : e instanceof Error ? e.message : "unknown error"}`);

export function AboutTab() {
  const [showLicense, setShowLicense] = createSignal(false);
  const open = (url: string) => void openExternal(url).catch(failed("open the link"));

  const copyDebug = async () => {
    try {
      const backend = await debugInfo().catch(() => "Backend details unavailable");
      const text = `${APP_NAME} ${VERSION}\n${backend}\nUser agent: ${navigator.userAgent}`;
      await navigator.clipboard.writeText(text);
      ui.toast("Debug info copied. Paste it into a bug report");
    } catch (e) {
      failed("copy debug info")(e);
    }
  };

  return (
    <>
      <div class="about-hero">
        <AppMark class="about-mark" />
        <div class="about-text">
          <div class="about-name">{APP_NAME}</div>
          <div class="about-version num">
            Version {VERSION} · by {DEVELOPER}
          </div>
          <div class="about-tagline">{TAGLINE}</div>
        </div>
      </div>

      <Section title="Developer">
        <SettingRow label="Made by">
          <span class="about-value">{DEVELOPER}</span>
        </SettingRow>
        <SettingRow label="Support" hint={SUPPORT_EMAIL}>
          <button class="btn small" onClick={() => open(`mailto:${SUPPORT_EMAIL}`)}>
            Email us
          </button>
        </SettingRow>
        <SettingRow label="Support the developers" hint="Octopolis is free. A coffee helps keep it growing">
          <button class="btn small" onClick={() => open(COFFEE_URL)}>
            <Glyph code="E734" size={12} /> Buy us a coffee
          </button>
        </SettingRow>
        <Show when={REPO.trim() !== ""}>
          <SettingRow label="Source and releases" hint={`github.com/${REPO}`}>
            <button class="btn small" onClick={() => open(`https://github.com/${REPO}`)}>
              Open GitHub
            </button>
          </SettingRow>
          <SettingRow label="Report a problem" hint="Include your debug info below">
            <button class="btn small" onClick={() => open(`https://github.com/${REPO}/issues/new`)}>
              New issue
            </button>
          </SettingRow>
        </Show>
      </Section>

      <Section title="Privacy" note="Octopolis has no accounts, no analytics and no telemetry. Your settings, pins, recent folders and shelf stay on this PC.">
        <SettingRow label="What leaves your PC" hint="Only the update check, which asks GitHub for the latest release. No information about you or your files is sent." />
        <SettingRow label="Your data folder" hint="Uninstalling and deleting this folder removes everything Octopolis kept">
          <button class="btn small" onClick={() => void openDataFolder().catch(failed("open the folder"))}>
            Open folder
          </button>
        </SettingRow>
      </Section>

      <Section title="Legal">
        <SettingRow label={`${LICENSE} License`} hint={COPYRIGHT}>
          <button class="btn small" aria-expanded={showLicense()} onClick={() => setShowLicense(!showLicense())}>
            {showLicense() ? "Hide text" : "Read license"}
          </button>
        </SettingRow>
        <Show when={showLicense()}>
          <div class="license">
            <p class="license-head">{LICENSE} License · {COPYRIGHT}</p>
            {MIT_BODY.map((para) => (
              <p>{para}</p>
            ))}
          </div>
        </Show>
      </Section>

      <Section title="Help">
        <SettingRow label="Debug info" hint="App and Windows details, ready to paste into a bug report. No file names or settings are included">
          <button class="btn small" onClick={() => void copyDebug()}>
            Copy
          </button>
        </SettingRow>
      </Section>
    </>
  );
}
