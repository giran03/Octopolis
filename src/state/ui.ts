// Transient UI: context menu, confirmation dialog and toasts.
import { createRoot, createSignal } from "solid-js";
import type { NameConflict, Resolution } from "../lib/conflicts";

export type SettingsTab = "general" | "appearance" | "shortcuts" | "advanced" | "updates" | "about";

export interface MenuItem {
  readonly label: string;
  readonly shortcut?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly run: () => void;
}
export type MenuEntry = MenuItem | "separator";

export interface MenuState {
  readonly x: number;
  readonly y: number;
  readonly items: readonly MenuEntry[];
}

export interface ConfirmState {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly onConfirm: () => void;
}

export interface PromptState {
  readonly title: string;
  readonly label: string;
  /** Text the field starts with (selected, so typing replaces it). */
  readonly initial?: string;
  readonly submitLabel?: string;
  readonly onSubmit: (value: string) => void;
}

/** A copy or move waiting for the user to decide about names already taken. */
export interface ConflictPrompt {
  readonly kind: "copy" | "move";
  readonly dest: string;
  readonly conflicts: readonly NameConflict[];
  readonly total: number;
  /** Per-item choices keyed by lower-case source path, plus the choice for the rest; null choices means cancelled. */
  readonly onResolve: (choices: ReadonlyMap<string, Resolution> | null, fallback: Resolution) => void;
}

export interface ToastAction {
  readonly label: string;
  readonly shortcut?: string;
  readonly onClick: () => void;
}

export interface Toast {
  readonly key: number;
  readonly text: string;
  readonly action?: ToastAction;
}

/** Asks a pane to focus its path bar or its filter box. */
export interface FocusRequest {
  readonly paneId: string;
  readonly target: "path" | "filter";
  readonly nonce: number;
}

const TOAST_MS = 4000;
let focusNonce = 1;
let toastKey = 1;
let lastSettingsTab: SettingsTab = "general";

export const ui = createRoot(() => {
  const [menu, setMenu] = createSignal<MenuState | null>(null);
  const [confirm, setConfirm] = createSignal<ConfirmState | null>(null);
  const [toasts, setToasts] = createSignal<readonly Toast[]>([]);
  const [focusRequest, setFocusRequest] = createSignal<FocusRequest | null>(null);
  const [palette, setPalette] = createSignal<"go" | "commands" | null>(null);
  const [lockPaths, setLockPaths] = createSignal<readonly string[] | null>(null);
  const [batchRenameOpen, setBatchRenameOpen] = createSignal(false);
  const [settingsTab, setSettingsTab] = createSignal<SettingsTab | null>(null);
  const [prompt, setPrompt] = createSignal<PromptState | null>(null);
  const [conflictPrompt, setConflictPrompt] = createSignal<ConflictPrompt | null>(null);
  const [propertiesPaths, setPropertiesPaths] = createSignal<readonly string[] | null>(null);
  const [recycleBinOpen, setRecycleBinOpen] = createSignal(false);
  const [systemCleanupOpen, setSystemCleanupOpen] = createSignal(false);
  const [opsHistoryOpen, setOpsHistoryOpen] = createSignal(false);
  const [welcomeOpen, setWelcomeOpen] = createSignal(false);
  const [rulesOpen, setRulesOpen] = createSignal(false);
  const [imageToolsPaths, setImageToolsPaths] = createSignal<readonly string[] | null>(null);
  /** The folder the duplicate finder is looking in, while it is open. */
  const [duplicatesRoot, setDuplicatesRoot] = createSignal<string | null>(null);
  /** Items whose tags are being edited. */
  const [tagPaths, setTagPaths] = createSignal<readonly string[] | null>(null);
  /** The tag whose items are listed. */
  const [taggedView, setTaggedView] = createSignal<string | null>(null);
  const [actionsEditorOpen, setActionsEditorOpen] = createSignal(false);
  /** The folder the cleanup assistant is looking at, while it is open. */
  const [cleanupRoot, setCleanupRoot] = createSignal<string | null>(null);
  const [diskSpaceRoot, setDiskSpaceRoot] = createSignal<string | null>(null);
  /** The folder whose emoji icon is being chosen. */
  const [emojiTarget, setEmojiTarget] = createSignal<string | null>(null);
  /** Vim visual mode: movement extends the selection. */
  const [visual, setVisual] = createSignal(false);

  const dismissToast = (key: number) => setToasts((t) => t.filter((x) => x.key !== key));

  const toast = (text: string, action?: ToastAction, durationMs = TOAST_MS) => {
    const key = toastKey++;
    setToasts((t) => [...t, { key, text, action }]);
    setTimeout(() => dismissToast(key), durationMs);
    return key;
  };

  return {
    menu,
    openMenu: (x: number, y: number, items: readonly MenuEntry[]) => setMenu({ x, y, items }),
    closeMenu: () => setMenu(null),
    confirm,
    ask: (c: ConfirmState) => setConfirm(c),
    closeConfirm: () => setConfirm(null),
    toasts,
    toast,
    dismissToast,
    palette,
    openPalette: (mode: "go" | "commands") => setPalette(mode),
    closePalette: () => setPalette(null),
    lockPaths,
    setLockPaths,
    batchRenameOpen,
    setBatchRenameOpen,
    settingsTab,
    settingsOpen: () => settingsTab() !== null,
    /** Opens settings on `tab`, or on the tab that was open last. */
    openSettings: (tab?: SettingsTab) => setSettingsTab(tab ?? lastSettingsTab),
    closeSettings: () => setSettingsTab(null),
    setSettingsTab: (tab: SettingsTab) => {
      lastSettingsTab = tab;
      setSettingsTab(tab);
    },
    prompt,
    conflictPrompt,
    propertiesPaths,
    setPropertiesPaths,
    recycleBinOpen,
    systemCleanupOpen,
    opsHistoryOpen,
    welcomeOpen,
    rulesOpen,
    imageToolsPaths,
    setImageToolsPaths,
    setRulesOpen,
    setWelcomeOpen,
    setOpsHistoryOpen,
    setSystemCleanupOpen,
    setRecycleBinOpen,
    duplicatesRoot,
    setDuplicatesRoot,
    tagPaths,
    setTagPaths,
    taggedView,
    setTaggedView,
    actionsEditorOpen,
    setActionsEditorOpen,
    cleanupRoot,
    setCleanupRoot,
    diskSpaceRoot,
    emojiTarget,
    setEmojiTarget,
    openDiskSpace: (root: string) => setDiskSpaceRoot(root),
    closeDiskSpace: () => setDiskSpaceRoot(null),
    askConflicts: (p: ConflictPrompt) => setConflictPrompt(p),
    closeConflicts: () => setConflictPrompt(null),
    askText: (p: PromptState) => setPrompt(p),
    closePrompt: () => setPrompt(null),
    visual,
    setVisual,
    /** True while a modal surface owns the keyboard. */
    modalOpen: () => !!(menu() || confirm() || palette() || lockPaths() || batchRenameOpen() || settingsTab() !== null || prompt() || conflictPrompt() || propertiesPaths() || recycleBinOpen() || systemCleanupOpen() || opsHistoryOpen() || welcomeOpen() || rulesOpen() || imageToolsPaths() || diskSpaceRoot() || duplicatesRoot() || tagPaths() || taggedView() || actionsEditorOpen() || cleanupRoot() || emojiTarget()),
    focusRequest,
    requestFocus: (paneId: string, target: FocusRequest["target"]) => setFocusRequest({ paneId, target, nonce: focusNonce++ }),
  };
});
