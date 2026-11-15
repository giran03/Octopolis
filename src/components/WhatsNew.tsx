// Shown once after Octopolis is updated: the changelog for the releases the user hasn't seen yet.
import { onCleanup } from "solid-js";
import { VERSION } from "../lib/app";
import { installDragScroll } from "../lib/dragScroll";
import { settings } from "../state/settings";
import { ui } from "../state/ui";
import { splitReleases } from "../lib/whatsNew";
import { ChangelogText } from "./Changelog";
import { MaterialIcon } from "./Icons";

/** Only the current release's notes; falls back to the newest block when the current version has none. */
function currentRelease(text: string): string {
  const releases = splitReleases(text);
  return (releases.find((r) => r.version === VERSION) ?? releases[0])?.text ?? text;
}

export function WhatsNew(props: { text: string }) {
  const close = () => {
    settings.set({ lastSeenVersion: VERSION });
    ui.setWhatsNewText(null);
  };
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="dialog whatsnew"
        role="dialog"
        aria-modal="true"
        aria-labelledby="whatsnew-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" || e.key === "Enter") close();
        }}
        ref={(el) => {
          queueMicrotask(() => el.querySelector<HTMLElement>(".btn.primary")?.focus());
          onCleanup(installDragScroll(el));
        }}
      >
        <div class="whatsnew-head">
          <MaterialIcon name="star" fill size={32} class="welcome-icon" />
          <div>
            <h2 id="whatsnew-title">What's new in Octopolis</h2>
            <p class="muted">You're now on version {VERSION}.</p>
          </div>
        </div>
        <div class="whatsnew-body">
          <ChangelogText text={currentRelease(props.text)} />
        </div>
        <div class="welcome-foot">
          <span class="bin-spacer" />
          <button class="btn primary" onClick={close}>Got it</button>
        </div>
      </div>
    </div>
  );
}
