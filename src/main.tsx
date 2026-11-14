import { ErrorBoundary } from "solid-js";
import { render } from "solid-js/web";
import { App } from "./App";
import { diagLog } from "./lib/ipc";
import "./styles.css";
import "./motion.css";
import "./settings.css";

// No browser-style right-click menu; text fields keep theirs for copy and paste,
// and Octopolis surfaces draw their own menus.
document.addEventListener(
  "contextmenu",
  (e) => {
    const el = (e.target instanceof Element ? e.target : null)?.closest("input, textarea, [contenteditable]") as HTMLElement | null;
    const isTextInput =
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLInputElement && !["range", "color", "checkbox", "radio", "button", "submit", "reset", "file"].includes(el.type)) ||
      !!el?.isContentEditable;
    if (!isTextInput) e.preventDefault();
  },
  true,
);

// Uncaught errors go to the local diagnostics log (Settings › Advanced › Open log folder).
const logError = (what: unknown) => {
  const text = what instanceof Error ? `${what.message} | ${what.stack ?? ""}` : String(what);
  void diagLog("error", text.slice(0, 1500)).catch(() => undefined);
};
window.addEventListener("error", (e) => logError(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => logError(e.reason));

render(
  () => (
    <ErrorBoundary
      fallback={(err, reset) => (
        <div class="crash" ref={() => logError(err)}>
          <h2>Something went wrong</h2>
          <p>{String(err)}</p>
          <button class="btn primary" onClick={reset}>Try again</button>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  ),
  document.getElementById("root")!,
);
