import { describe, expect, it } from "vitest";
import { sanitizeSettings, SETTING_DEFAULTS } from "../state/settings";
import { AUTO_INSTALL_IDLE_MS, CHECK_INTERVAL_MS, checkDue, compareVersions, describeStatus, isNewer, parseChecksums, parseVersion, shouldAutoInstall, type LatestRelease, type UpdateStatus } from "./update";

const release: LatestRelease = { version: "0.2.0", tag: "v0.2.0", notes: "", htmlUrl: "", installerName: "Octopolis_0.2.0_x64-setup.exe", installerUrl: "", sumsUrl: "", sha256: null };

describe("versions", () => {
  it("parses tags with a v prefix and pre-release suffix", () => {
    expect(parseVersion("v1.2.3-beta.1")).toEqual([1, 2, 3]);
    expect(parseVersion("2")).toEqual([2]);
  });

  it("compares numerically, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.1.1")).toBe(-1);
    expect(isNewer("v0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
  });
});

describe("update scheduling", () => {
  it("checks in the background only when on and a day has passed", () => {
    expect(checkDue("off", 0, CHECK_INTERVAL_MS * 5)).toBe(false);
    expect(checkDue("notify", 1000, 1000 + CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(checkDue("notify", 1000, 1000 + CHECK_INTERVAL_MS)).toBe(true);
  });

  it("auto-installs only in Automatic mode, when ready and the PC has been idle", () => {
    const ready: UpdateStatus = { kind: "ready", release, path: "x" };
    expect(shouldAutoInstall("auto", ready, 0, AUTO_INSTALL_IDLE_MS)).toBe(true);
    expect(shouldAutoInstall("auto", ready, 1, AUTO_INSTALL_IDLE_MS)).toBe(false);
    expect(shouldAutoInstall("notify", ready, 0, AUTO_INSTALL_IDLE_MS * 2)).toBe(false);
    expect(shouldAutoInstall("auto", { kind: "available", release }, 0, AUTO_INSTALL_IDLE_MS * 2)).toBe(false);
  });
});

describe("status view", () => {
  it("offers the next step for each state and locks controls while busy", () => {
    expect(describeStatus({ kind: "idle" }, "0.1.0").action?.step).toBe("check");
    expect(describeStatus({ kind: "available", release }, "0.1.0").action?.step).toBe("download");
    expect(describeStatus({ kind: "ready", release, path: "p" }, "0.1.0").action?.step).toBe("install");
    expect(describeStatus({ kind: "downloading", release }, "0.1.0")).toMatchObject({ action: null, busy: true });
    expect(describeStatus({ kind: "unconfigured" }, "0.1.0").action).toBeNull();
  });

  it("retries the step that failed", () => {
    const v = describeStatus({ kind: "failed", message: "offline", retry: "download", release }, "0.1.0");
    expect(v).toMatchObject({ tone: "bad", detail: "offline", action: { step: "download", label: "Retry download" } });
  });
});

describe("checksums", () => {
  it("reads sha256sum output", () => {
    const hash = "a".repeat(64);
    const text = `${hash}  Octopolis_0.2.0_x64-setup.exe\r\nnot a line\n${"B".repeat(64)} *other.zip`;
    expect(parseChecksums(text)).toEqual({ "Octopolis_0.2.0_x64-setup.exe": hash, "other.zip": "b".repeat(64) });
  });
});

describe("settings import", () => {
  it("keeps known keys with the right type and drops the rest", () => {
    const clean = sanitizeSettings({ motion: "reduce", uiScale: 110, tooltips: "yes", nope: 1, pinnedActions: ["Copy"], speedLimit: null });
    expect(clean).toMatchObject({ motion: "reduce", uiScale: 110, pinnedActions: ["Copy"], speedLimit: null });
    expect(clean).not.toHaveProperty("tooltips");
    expect(clean).not.toHaveProperty("nope");
    expect(sanitizeSettings("garbage")).toEqual({});
    expect(SETTING_DEFAULTS.updateMode).toBe("auto");
    expect(SETTING_DEFAULTS.autoFolderSizes).toBe(true);
    expect(SETTING_DEFAULTS.confirmRecycle).toBe(true);
  });
});
