// Resize or convert the selected pictures into new copies. Originals are never changed; re-saving also drops camera and location metadata.
import { createSignal, For, Show } from "solid-js";
import { convertImages, errorText, pickFolderDialog } from "../lib/ipc";
import { baseName, parentPath, samePath } from "../lib/paths";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";
import { Slider } from "./settings/controls";

const SIZES: readonly { edge: number | null; label: string }[] = [
  { edge: null, label: "Keep the size" },
  { edge: 3840, label: "4K (3840 px)" },
  { edge: 2560, label: "2560 px" },
  { edge: 1920, label: "Full HD (1920 px)" },
  { edge: 1280, label: "1280 px" },
  { edge: 800, label: "800 px" },
  { edge: 400, label: "Thumbnail (400 px)" },
];
const FORMATS: readonly { value: string; label: string }[] = [
  { value: "same", label: "Keep each format" },
  { value: "jpeg", label: "JPEG" },
  { value: "png", label: "PNG" },
  { value: "webp", label: "WebP (lossless)" },
];

export function ImageTools(props: { paths: readonly string[] }) {
  const [edge, setEdge] = createSignal<number | null>(1920);
  const [format, setFormat] = createSignal("same");
  const [quality, setQuality] = createSignal(85);
  const [outDir, setOutDir] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const close = () => ui.setImageToolsPaths(null);

  const run = async () => {
    if (edge() === null && format() === "same") return setError("Choose a size or a format to change");
    setBusy(true);
    setError(null);
    try {
      const r = await convertImages([...props.paths], edge(), format(), quality(), outDir());
      for (const t of workspace.allTabs()) if (r.created.some((p) => samePath(parentPath(p) ?? "", t.path()))) void t.refresh();
      ui.toast(r.errors.length ? `Saved ${r.created.length}, ${r.errors.length} failed: ${r.errors[0]}` : `Saved ${r.created.length} picture${r.created.length === 1 ? "" : "s"}`);
      if (r.errors.length === 0) close();
      else setError(r.errors.join("\n"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy() && close()}>
      <div
        class="dialog imgtools"
        role="dialog"
        aria-modal="true"
        aria-labelledby="imgtools-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" && !busy()) close();
        }}
      >
        <h2 id="imgtools-title">Resize or convert pictures</h2>
        <p class="muted small">
          {props.paths.length === 1 ? baseName(props.paths[0]) : `${props.paths.length} pictures`}. New copies are saved; the originals stay as they are.
        </p>
        <label>
          Size
          <select class="conflict-choice" value={String(edge())} disabled={busy()} onChange={(e) => setEdge(e.currentTarget.value === "null" ? null : Number(e.currentTarget.value))}>
            <For each={SIZES}>{(s) => <option value={String(s.edge)}>{s.label}</option>}</For>
          </select>
        </label>
        <label>
          Format
          <select class="conflict-choice" value={format()} disabled={busy()} onChange={(e) => setFormat(e.currentTarget.value)}>
            <For each={FORMATS}>{(f) => <option value={f.value}>{f.label}</option>}</For>
          </select>
        </label>
        <Show when={format() === "jpeg" || format() === "same"}>
          <label>
            JPEG quality
            <Slider label="JPEG quality" min={40} max={100} step={5} value={quality()} format={(v) => `${v}%`} onChange={setQuality} />
          </label>
        </Show>
        <div class="imgtools-out">
          <span>Save to</span>
          <span class="muted small">{outDir() ?? "Next to each original"}</span>
          <button
            class="btn small"
            disabled={busy()}
            onClick={async () => {
              try {
                setOutDir((await pickFolderDialog(outDir() ?? undefined)) ?? outDir());
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            Choose folder…
          </button>
          <Show when={outDir()}>
            <button class="btn small" disabled={busy()} onClick={() => setOutDir(null)}>Next to originals</button>
          </Show>
        </div>
        <Show when={error()}>{(e) => <p class="error-text small">{e()}</p>}</Show>
        <div class="dialog-actions">
          <button class="btn" disabled={busy()} onClick={close}>Cancel</button>
          <button class="btn primary" disabled={busy()} onClick={() => void run()}>{busy() ? "Saving…" : "Save copies"}</button>
        </div>
      </div>
    </div>
  );
}
