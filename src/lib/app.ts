// App identity and external links shown in About and used by the updater.
declare const __APP_VERSION__: string;

export const APP_NAME = "Octopolis";
export const VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
export const TAGLINE = "A blazing-fast file explorer for Windows.";
export const DEVELOPER = "CafeTako";
export const SUPPORT_EMAIL = "support@cafetako.com";
export const COFFEE_URL = "https://buymeacoffee.com/cafetako";
/** GitHub "owner/name" that releases are published to. Empty until the repository exists: updates stay disabled. */
export const REPO = "giran03/Octopolis";
export const LICENSE = "MIT";
export const COPYRIGHT = "Copyright (c) 2026 giran03";

/** Shows progress (0-100) on the taskbar button, "indeterminate" for a busy spinner, or null to clear it. */
export async function setTaskbarProgress(value: number | "indeterminate" | null): Promise<void> {
  try {
    const { getCurrentWindow, ProgressBarStatus } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (value === null) await win.setProgressBar({ status: ProgressBarStatus.None });
    else if (value === "indeterminate") await win.setProgressBar({ status: ProgressBarStatus.Indeterminate });
    else await win.setProgressBar({ status: ProgressBarStatus.Normal, progress: value });
  } catch {
    // Not running inside the app window (browser preview or tests).
  }
}
