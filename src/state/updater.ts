// Update flow: check GitHub for a newer release, download and verify its installer, install and restart.
// All network and installer work happens in the Rust backend; this keeps the state and the schedule.
import { createRoot, createSignal } from "solid-js";
import { REPO, VERSION } from "../lib/app";
import { updateCheck, updateDownload, updateInstall } from "../lib/ipc";
import { checkDue, isNewer, shouldAutoInstall, type LatestRelease, type UpdateStatus } from "../lib/update";
import { settings } from "./settings";
import { ui } from "./ui";

const TICK_MS = 30 * 60 * 1000;
const errorText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "Something went wrong");

export const updater = createRoot(() => {
  const configured = REPO.trim() !== "";
  const [status, setStatus] = createSignal<UpdateStatus>(configured ? { kind: "idle" } : { kind: "unconfigured" });
  let lastInput = Date.now();
  let started = false;

  const busy = () => ["checking", "downloading", "installing"].includes(status().kind);

  /** `manual` checks report failures; background ones fail quietly and try again later. */
  async function check(manual: boolean) {
    if (!configured || busy()) return;
    setStatus({ kind: "checking" });
    try {
      const release = await updateCheck(REPO);
      settings.set({ lastUpdateCheck: Date.now() });
      if (!isNewer(release.version, VERSION)) return setStatus({ kind: "up-to-date" });
      if (!release.sha256) return setStatus({ kind: "failed", message: "The release has no checksum for its installer", retry: "check" });
      setStatus({ kind: "available", release });
      if (settings.updateMode() === "auto") void download(release);
      else if (!manual) ui.toast(`Octopolis ${release.version} is available. Open Settings > Updates to install it.`);
    } catch (e) {
      setStatus(manual ? { kind: "failed", message: errorText(e), retry: "check" } : { kind: "idle" });
    }
  }

  async function download(release: LatestRelease) {
    if (!configured || busy() || !release.sha256) return;
    setStatus({ kind: "downloading", release });
    try {
      const path = await updateDownload(release.installerUrl, release.installerName, release.sha256);
      setStatus({ kind: "ready", release, path });
    } catch (e) {
      setStatus({ kind: "failed", message: errorText(e), retry: "download", release });
    }
  }

  async function install() {
    const s = status();
    if (s.kind !== "ready" && !(s.kind === "failed" && s.retry === "install" && s.path && s.release)) return;
    const release = s.release;
    const path = s.kind === "ready" ? s.path : s.path!;
    if (!release?.sha256) return;
    setStatus({ kind: "installing", release });
    try {
      await updateInstall(path, release.sha256);
    } catch (e) {
      setStatus({ kind: "failed", message: errorText(e), retry: "install", release, path });
    }
  }

  /** Runs the step a status button asks for. */
  function run(step: "check" | "download" | "install") {
    const s = status();
    if (step === "check") return void check(true);
    if (step === "download") {
      const release = s.kind === "available" || s.kind === "failed" ? s.release : undefined;
      return release ? void download(release) : void check(true);
    }
    return void install();
  }

  /** Starts the background schedule: one check at launch if due, then a periodic look. */
  function start() {
    if (started || !configured) return;
    started = true;
    const touch = () => (lastInput = Date.now());
    for (const ev of ["pointerdown", "keydown", "wheel"]) window.addEventListener(ev, touch, { passive: true });
    const tick = () => {
      const now = Date.now();
      if (checkDue(settings.updateMode(), settings.lastUpdateCheck(), now)) void check(false);
      if (shouldAutoInstall(settings.updateMode(), status(), lastInput, now)) void install();
    };
    setTimeout(tick, 5000);
    setInterval(tick, TICK_MS);
  }

  return { status, configured, check: () => check(true), run, start, busy };
});
