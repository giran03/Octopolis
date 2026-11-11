// App identity and external links shown in About and used by the updater.
declare const __APP_VERSION__: string;

export const APP_NAME = "Octopolis";
export const VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
export const TAGLINE = "A blazing-fast file explorer for Windows.";
export const DEVELOPER = "CafeTako";
export const SUPPORT_EMAIL = "support@cafetako.com";
export const COFFEE_URL = "https://buymeacoffee.com/cafetako";
/** GitHub "owner/name" that releases are published to. Empty until the repository exists: updates stay disabled. */
export const REPO = "";
export const LICENSE = "MIT";
export const COPYRIGHT = "Copyright (c) 2026 giran03";
