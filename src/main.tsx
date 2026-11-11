import { ErrorBoundary } from "solid-js";
import { render } from "solid-js/web";
import { App } from "./App";
import "./styles.css";

// No browser-style right-click menu in release builds; text fields keep theirs
// for copy and paste. The file list draws its own menu.
if (import.meta.env.PROD) {
  document.addEventListener(
    "contextmenu",
    (e) => {
      const el = e.target as HTMLElement;
      if (!(el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) e.preventDefault();
    },
    true,
  );
  // Browser reload/print shortcuts make no sense in a file explorer.
  document.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey && (e.key === "p" || e.key === "P")) || (e.ctrlKey && e.shiftKey && (e.key === "I" || e.key === "i"))) e.preventDefault();
    },
    true,
  );
}

render(
  () => (
    <ErrorBoundary
      fallback={(err, reset) => (
        <div class="crash">
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
