// Properties (Alt+Enter): details, editable dates and attributes, and checksums.
import { createResource, createSignal, For, Show } from "solid-js";
import { formatDate, formatSize, typeLabel } from "../lib/format";
import { errorText, fileChecksum, filePropertiesMany, setFileAttributes, setFileTimes, type ChecksumKind, type FileAttributes, type FileProperties } from "../lib/ipc";
import { baseName, parentPath, samePath } from "../lib/paths";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";
import { Checkbox } from "./Checkbox";

const CHECKSUMS: readonly { kind: ChecksumKind; label: string }[] = [
  { kind: "sha256", label: "SHA-256" },
  { kind: "md5", label: "MD5" },
  { kind: "blake3", label: "BLAKE3" },
];

const ATTRS: readonly { key: keyof FileAttributes; label: string }[] = [
  { key: "readOnly", label: "Read-only" },
  { key: "hidden", label: "Hidden" },
  { key: "system", label: "System" },
  { key: "archive", label: "Ready for archiving" },
];

const DATES = [
  ["Created", "createdMs"],
  ["Modified", "modifiedMs"],
  ["Accessed", "accessedMs"],
] as const;

/** `<input type="datetime-local">` value for a time, in local time with seconds. */
export function toLocalInput(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Milliseconds for a `datetime-local` value, or null if empty or invalid. */
export function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

const STREAM_NOTES: Record<string, string> = { "Zone.Identifier": "marks the file as downloaded from the internet" };

export function PropertiesDialog(props: { paths: readonly string[] }) {
  const single = () => props.paths.length === 1;
  const [info, { refetch }] = createResource(
    () => [...props.paths],
    (paths) => filePropertiesMany(paths).catch(() => paths.map(() => null)),
  );
  const first = (): FileProperties | null => info()?.[0] ?? null;
  const known = () => (info() ?? []).filter((p): p is FileProperties => p !== null);

  // Edited values; null / empty means "unchanged".
  const [attrs, setAttrs] = createSignal<FileAttributes | null>(null);
  const [times, setTimes] = createSignal<{ createdMs?: number; modifiedMs?: number; accessedMs?: number }>({});
  const [saving, setSaving] = createSignal(false);
  const allHave = (key: keyof FileAttributes) => known().length > 0 && known().every((p) => p.attributes[key]);
  const shownAttrs = (): FileAttributes => attrs() ?? { readOnly: allHave("readOnly"), hidden: allHave("hidden"), system: allHave("system"), archive: allHave("archive") };
  const mixed = (key: keyof FileAttributes) => !attrs() && known().some((p) => p.attributes[key]) && !allHave(key);
  const dirty = () => attrs() !== null || Object.keys(times()).length > 0;

  const save = async () => {
    setSaving(true);
    try {
      const a = attrs();
      if (a) await setFileAttributes([...props.paths], a);
      if (single() && Object.keys(times()).length) await setFileTimes(props.paths[0], times());
      setAttrs(null);
      setTimes({});
      await refetch();
      for (const t of workspace.allTabs()) if (props.paths.some((p) => samePath(parentPath(p) ?? "", t.path()))) void t.refresh();
      ui.toast("Properties saved");
    } catch (e) {
      ui.toast(`Couldn't save: ${errorText(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const totalSize = () => known().reduce((s, p) => s + p.size, 0);
  const title = () => (single() ? baseName(props.paths[0]) || props.paths[0] : `${props.paths.length} items`);
  const close = () => ui.setPropertiesPaths(null);
  const range = () => {
    const times = known().map((p) => p.modifiedMs).filter((t) => t > 0);
    return times.length ? `${formatDate(Math.min(...times))} – ${formatDate(Math.max(...times))}` : "";
  };

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="dialog props-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="props-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") close();
        }}
      >
        <h2 id="props-title" title={props.paths.join("\n")}>
          {title()}
        </h2>
        <Show when={info()} fallback={<p class="muted">Reading…</p>}>
          <dl class="props-grid">
            <Show when={single() && first()}>
              {(p) => (
                <>
                  <dt>Type</dt>
                  <dd>
                    {typeLabel(baseName(props.paths[0]), p().isDir)}
                    {p().linkTarget ? " (link)" : ""}
                  </dd>
                  <dt>Location</dt>
                  <dd class="props-path">{parentPath(props.paths[0]) ?? props.paths[0]}</dd>
                  <Show when={p().linkTarget}>
                    <dt>Points to</dt>
                    <dd class="props-path">{p().linkTarget}</dd>
                  </Show>
                </>
              )}
            </Show>
            <dt>Size</dt>
            <dd>{single() && first()?.isDir ? "Folder (use Calculate folder sizes to measure it)" : `${formatSize(totalSize())} (${totalSize().toLocaleString()} bytes)`}</dd>
            <Show when={single() && first()?.sizeOnDisk != null}>
              <dt>On disk</dt>
              <dd>{formatSize(first()!.sizeOnDisk!)}</dd>
            </Show>
            <Show when={single() && first()}>
              {(p) => (
                <>
                  <For each={DATES}>
                    {([label, key]) => (
                      <>
                        <dt>{label}</dt>
                        <dd>
                          <input
                            type="datetime-local"
                            step="1"
                            class="text-input props-date"
                            aria-label={`${label} date`}
                            value={toLocalInput(times()[key] ?? p()[key])}
                            onChange={(e) => {
                              const ms = fromLocalInput(e.currentTarget.value);
                              if (ms !== null) setTimes((t) => ({ ...t, [key]: ms }));
                            }}
                          />
                        </dd>
                      </>
                    )}
                  </For>
                  <Show when={p().hardLinks > 1}>
                    <dt>Hard links</dt>
                    <dd>{p().hardLinks} names share this file's contents</dd>
                  </Show>
                  <Show when={p().streams.length > 0}>
                    <dt>Extra streams</dt>
                    <dd>
                      <For each={p().streams}>
                        {([name, size]) => (
                          <div>
                            {name} · {formatSize(size)}
                            <Show when={STREAM_NOTES[name]}>
                              <span class="muted"> ({STREAM_NOTES[name]})</span>
                            </Show>
                          </div>
                        )}
                      </For>
                    </dd>
                  </Show>
                </>
              )}
            </Show>
            <Show when={!single() && range()}>
              <dt>Modified</dt>
              <dd class="muted">{range()}</dd>
            </Show>
          </dl>
          <fieldset class="props-attrs">
            <legend>Attributes{single() ? "" : " (all selected items)"}</legend>
            <For each={ATTRS}>
              {(a) => (
                <Checkbox
                  class="props-check"
                  checked={shownAttrs()[a.key]}
                  indeterminate={mixed(a.key)}
                  onChange={(checked) => setAttrs({ ...shownAttrs(), [a.key]: checked })}
                >
                  {a.label}
                </Checkbox>
              )}
            </For>
          </fieldset>
          <Show when={single() && first() && !first()!.isDir}>
            <Checksums path={props.paths[0]} />
          </Show>
        </Show>
        <div class="dialog-actions">
          <button class="btn" onClick={close}>
            {dirty() ? "Cancel" : "Close"}
          </button>
          <Show when={dirty()}>
            <button class="btn primary" disabled={saving()} onClick={() => void save()}>
              Save
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}

/** On-demand checksums, with a box to paste an expected value and compare. */
function Checksums(props: { path: string }) {
  const [values, setValues] = createSignal<Partial<Record<ChecksumKind, string>>>({});
  const [busy, setBusy] = createSignal<ChecksumKind | null>(null);
  const [expected, setExpected] = createSignal("");
  const compute = async (kind: ChecksumKind) => {
    setBusy(kind);
    try {
      const v = await fileChecksum(props.path, kind);
      setValues((m) => ({ ...m, [kind]: v }));
    } catch (e) {
      ui.toast(`Couldn't calculate the checksum: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const verdict = () => {
    const want = expected().trim().toLowerCase();
    if (!want) return null;
    const have = Object.values(values());
    if (have.length === 0) return "Calculate a checksum to compare";
    return have.includes(want) ? "Matches" : "Doesn't match";
  };
  const copy = (v: string) => navigator.clipboard.writeText(v).then(() => ui.toast("Checksum copied"), () => ui.toast("Couldn't copy"));
  return (
    <div class="props-sums">
      <div class="props-sums-head">
        <span>Checksums</span>
        <span class="props-sum-buttons">
          <For each={CHECKSUMS}>
            {(c) => (
              <button class="btn small" disabled={busy() !== null} onClick={() => void compute(c.kind)}>
                {busy() === c.kind ? "Calculating…" : c.label}
              </button>
            )}
          </For>
        </span>
      </div>
      <For each={CHECKSUMS.filter((c) => values()[c.kind])}>
        {(c) => (
          <div class="props-sum">
            <span class="muted small">{c.label}</span>
            <code>{values()[c.kind]}</code>
            <button class="link-btn small" onClick={() => void copy(values()[c.kind]!)}>
              Copy
            </button>
          </div>
        )}
      </For>
      <label class="props-compare">
        <span class="muted small">Compare with</span>
        <input class="text-input" spellcheck={false} placeholder="Paste a checksum from the download page" value={expected()} onInput={(e) => setExpected(e.currentTarget.value)} />
        <Show when={verdict()}>
          {(v) => <span classList={{ "props-match": v() === "Matches", "props-nomatch": v() === "Doesn't match", muted: v() !== "Matches" && v() !== "Doesn't match" }}>{v()}</span>}
        </Show>
      </label>
    </div>
  );
}
