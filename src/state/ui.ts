// Transient UI: context menu, confirmation dialog and toasts.
import { createRoot, createSignal } from "solid-js";

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
  readonly onSubmit: (value: string) => void;
}

export interface Toast {
  readonly key: number;
  readonly text: string;
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

export const ui = createRoot(() => {
  const [menu, setMenu] = createSignal<MenuState | null>(null);
  const [confirm, setConfirm] = createSignal<ConfirmState | null>(null);
  const [toasts, setToasts] = createSignal<readonly Toast[]>([]);
  const [focusRequest, setFocusRequest] = createSignal<FocusRequest | null>(null);
  const [palette, setPalette] = createSignal<"go" | "commands" | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = createSignal(false);
  const [lockPaths, setLockPaths] = createSignal<readonly string[] | null>(null);
  const [batchRenameOpen, setBatchRenameOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [prompt, setPrompt] = createSignal<PromptState | null>(null);
  /** Vim visual mode: movement extends the selection. */
  const [visual, setVisual] = createSignal(false);

  const toast = (text: string) => {
    const key = toastKey++;
    setToasts((t) => [...t, { key, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.key !== key)), TOAST_MS);
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
    palette,
    openPalette: (mode: "go" | "commands") => setPalette(mode),
    closePalette: () => setPalette(null),
    shortcutsOpen,
    setShortcutsOpen,
    lockPaths,
    setLockPaths,
    batchRenameOpen,
    setBatchRenameOpen,
    settingsOpen,
    setSettingsOpen,
    prompt,
    askText: (p: PromptState) => setPrompt(p),
    closePrompt: () => setPrompt(null),
    visual,
    setVisual,
    /** True while a modal surface owns the keyboard. */
    modalOpen: () => !!(menu() || confirm() || palette() || shortcutsOpen() || lockPaths() || batchRenameOpen() || settingsOpen() || prompt()),
    focusRequest,
    requestFocus: (paneId: string, target: FocusRequest["target"]) => setFocusRequest({ paneId, target, nonce: focusNonce++ }),
  };
});
