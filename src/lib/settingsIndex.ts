import type { SettingsTab } from "../state/ui";

export interface SettingsEntry {
  readonly id: string;
  readonly tab: SettingsTab;
  readonly tabLabel: string;
  readonly title: string;
  readonly rowLabel?: string;
  readonly keywords: string;
  readonly icon: string;
  readonly isTab?: boolean;
}

/** Searchable index of Settings tabs and individual settings for the PowerBar. */
export const SETTINGS_INDEX: readonly SettingsEntry[] = [
  // Tabs
  { id: "tab:general", tab: "general", tabLabel: "General", title: "Settings: General", keywords: "general startup home tray summon editor delete recycle terminal git", icon: "tune", isTab: true },
  { id: "tab:appearance", tab: "appearance", tabLabel: "Appearance", title: "Settings: Appearance", keywords: "appearance theme dark light accent color font scale density icons thumbnails animations tooltips", icon: "palette", isTab: true },
  { id: "tab:shortcuts", tab: "shortcuts", tabLabel: "Shortcuts", title: "Settings: Shortcuts", keywords: "shortcuts keybindings hotkeys keys vim restore defaults", icon: "keyboard", isTab: true },
  { id: "tab:advanced", tab: "advanced", tabLabel: "Advanced", title: "Settings: Advanced", keywords: "advanced explorer context menu default file manager logs diagnostics", icon: "settings", isTab: true },
  { id: "tab:updates", tab: "updates", tabLabel: "Updates", title: "Settings: Updates", keywords: "updates version release automatic check", icon: "sync", isTab: true },
  { id: "tab:about", tab: "about", tabLabel: "About", title: "Settings: About", keywords: "about privacy license data folder support github", icon: "info", isTab: true },

  // General
  { id: "set:startup", tab: "general", tabLabel: "General", title: "Open Octopolis in", rowLabel: "Open Octopolis in", keywords: "startup start folder home last session", icon: "tune" },
  { id: "set:tray", tab: "general", tabLabel: "General", title: "Keep running in the notification area", rowLabel: "Keep running in the notification area", keywords: "tray background minimize clock notification", icon: "tune" },
  { id: "set:summon", tab: "general", tabLabel: "General", title: "Global summon shortcut", rowLabel: "Global summon shortcut", keywords: "summon hotkey shortcut quick open", icon: "tune" },
  { id: "set:editor", tab: "general", tabLabel: "General", title: "Editor", rowLabel: "Editor", keywords: "editor vscode notepad code open in editor", icon: "tune" },
  { id: "set:editor-text", tab: "general", tabLabel: "General", title: "Double-click on text and code files", rowLabel: "Double-click on text and code files", keywords: "double click text code editor default app", icon: "tune" },
  { id: "set:recycle", tab: "general", tabLabel: "General", title: "Ask before moving to Recycle Bin", rowLabel: "Ask before moving to Recycle Bin", keywords: "confirm delete recycle bin trash", icon: "tune" },
  { id: "set:hidden", tab: "general", tabLabel: "General", title: "Show hidden files and folders", rowLabel: "Show hidden files and folders", keywords: "hidden dotfiles system files", icon: "tune" },
  { id: "set:extensions", tab: "general", tabLabel: "General", title: "Show file extensions", rowLabel: "Show file extensions", keywords: "extensions file names", icon: "tune" },
  { id: "set:shell", tab: "general", tabLabel: "General", title: "Shell", rowLabel: "Shell", keywords: "terminal powershell cmd windows terminal", icon: "tune" },
  { id: "set:gitignore", tab: "general", tabLabel: "General", title: "Hide files Git ignores", rowLabel: "Hide files Git ignores", keywords: "git ignored gitignore", icon: "tune" },

  // Appearance
  { id: "set:theme", tab: "appearance", tabLabel: "Appearance", title: "Theme", rowLabel: "Theme", keywords: "theme dark light midnight custom colors", icon: "palette" },
  { id: "set:accent", tab: "appearance", tabLabel: "Appearance", title: "Accent color", rowLabel: "Accent color", keywords: "accent color highlight primary", icon: "palette" },
  { id: "set:font", tab: "appearance", tabLabel: "Appearance", title: "Interface font", rowLabel: "Interface font", keywords: "font typeface google fonts typography", icon: "palette" },
  { id: "set:scale", tab: "appearance", tabLabel: "Appearance", title: "Interface scale", rowLabel: "Interface scale", keywords: "zoom size dpi text scale", icon: "palette" },
  { id: "set:density", tab: "appearance", tabLabel: "Appearance", title: "Density", rowLabel: "Density", keywords: "row spacing compact comfortable", icon: "palette" },
  { id: "set:icons", tab: "appearance", tabLabel: "Appearance", title: "Icon style", rowLabel: "Icon style", keywords: "icons outlined rounded sharp weight fill", icon: "palette" },
  { id: "set:thumbs", tab: "appearance", tabLabel: "Appearance", title: "Thumbnails", rowLabel: "Thumbnails", keywords: "thumbnails preview images videos", icon: "palette" },
  { id: "set:motion", tab: "appearance", tabLabel: "Appearance", title: "Animations", rowLabel: "Animations", keywords: "motion reduce animations", icon: "palette" },

  // Shortcuts
  { id: "set:vim", tab: "shortcuts", tabLabel: "Shortcuts", title: "Vim keys", rowLabel: "Vim keys", keywords: "vim hjkl modal navigation", icon: "keyboard" },
  { id: "set:reset-keys", tab: "shortcuts", tabLabel: "Shortcuts", title: "Restore default shortcuts", rowLabel: "Restore default shortcuts", keywords: "reset shortcuts keybindings", icon: "keyboard" },

  // Updates
  { id: "set:updates", tab: "updates", tabLabel: "Updates", title: "When to update", rowLabel: "When to update", keywords: "automatic updates check release", icon: "sync" },

  // About
  { id: "set:data-folder", tab: "about", tabLabel: "About", title: "Your data folder", rowLabel: "Your data folder", keywords: "data folder config appdata", icon: "info" },
];
