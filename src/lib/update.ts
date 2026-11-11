// Pure update logic: version comparison, when to check, and what each updater state says to the user.
import type { UpdateMode } from "../state/settings";

/** Shape returned by the backend `update_check` command. */
export interface LatestRelease {
  readonly version: string;
  readonly tag: string;
  readonly notes: string;
  readonly htmlUrl: string;
  readonly installerName: string;
  readonly installerUrl: string;
  readonly sumsUrl: string;
  readonly sha256: string | null;
}

export type UpdateStep = "check" | "download" | "install";

export type UpdateStatus =
  | { readonly kind: "unconfigured" }
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | { readonly kind: "up-to-date" }
  | { readonly kind: "available"; readonly release: LatestRelease }
  | { readonly kind: "downloading"; readonly release: LatestRelease }
  | { readonly kind: "ready"; readonly release: LatestRelease; readonly path: string }
  | { readonly kind: "installing"; readonly release: LatestRelease }
  | { readonly kind: "failed"; readonly message: string; readonly retry: UpdateStep; readonly release?: LatestRelease; readonly path?: string };

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const AUTO_INSTALL_IDLE_MS = 10 * 60 * 1000;

/** Parses "v1.2.3-beta.1" into [1, 2, 3]; missing or non-numeric parts count as 0. */
export function parseVersion(v: string): number[] {
  const core = v.trim().replace(/^v/i, "").split(/[-+]/)[0];
  return core.split(".").map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/** -1 when a is older than b, 1 when newer, 0 when equal. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export const isNewer = (latest: string, current: string) => compareVersions(latest, current) === 1;

/** A background check is due when updates are on and the last one was over a day ago. */
export function checkDue(mode: UpdateMode, lastCheck: number, now: number): boolean {
  return mode !== "off" && now - lastCheck >= CHECK_INTERVAL_MS;
}

/** Automatic mode installs a downloaded update only after the PC has been idle for a while. */
export function shouldAutoInstall(mode: UpdateMode, status: UpdateStatus, lastInput: number, now: number): boolean {
  return mode === "auto" && status.kind === "ready" && now - lastInput >= AUTO_INSTALL_IDLE_MS;
}

export interface StatusView {
  readonly title: string;
  readonly detail: string;
  /** The step the primary button performs, when there is one. */
  readonly action: { readonly label: string; readonly step: UpdateStep } | null;
  /** True while something is running and the controls should be locked. */
  readonly busy: boolean;
  readonly tone: "neutral" | "good" | "bad";
}

const RETRY_LABEL: Record<UpdateStep, string> = { check: "Try again", download: "Retry download", install: "Retry install" };

export function describeStatus(status: UpdateStatus, current: string): StatusView {
  switch (status.kind) {
    case "unconfigured":
      return { title: "Updates aren't set up yet", detail: `Version ${current}. Update checks turn on once a release feed is configured.`, action: null, busy: false, tone: "neutral" };
    case "idle":
      return { title: "Updates", detail: `Version ${current}`, action: { label: "Check now", step: "check" }, busy: false, tone: "neutral" };
    case "checking":
      return { title: "Checking for updates…", detail: `Version ${current}`, action: null, busy: true, tone: "neutral" };
    case "up-to-date":
      return { title: "You're up to date", detail: `Version ${current} is the latest`, action: { label: "Check again", step: "check" }, busy: false, tone: "good" };
    case "available":
      return { title: `Version ${status.release.version} is available`, detail: `You have ${current}`, action: { label: "Download update", step: "download" }, busy: false, tone: "good" };
    case "downloading":
      return { title: `Downloading ${status.release.version}…`, detail: "Downloading and verifying the installer", action: null, busy: true, tone: "neutral" };
    case "ready":
      return { title: `Version ${status.release.version} is ready`, detail: "Download verified. Install and restart when you're ready.", action: { label: "Install and restart", step: "install" }, busy: false, tone: "good" };
    case "installing":
      return { title: `Installing ${status.release.version}…`, detail: "Octopolis restarts by itself in a moment", action: null, busy: true, tone: "neutral" };
    case "failed":
      return { title: "Couldn't update", detail: status.message, action: { label: RETRY_LABEL[status.retry], step: status.retry }, busy: false, tone: "bad" };
  }
}

/** Checksum line format: "<hex>  <filename>" (sha256sum output, optional leading "*" on the name). */
export function parseChecksums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/[\r\n]+/)) {
    const m = /^([0-9a-fA-F]{64})[ \t]+[*]?(.+?)[ \t]*$/.exec(line.trim());
    if (m) out[m[2]] = m[1].toLowerCase();
  }
  return out;
}
