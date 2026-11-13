// The "Windows" tab of the folder icon picker: the colored icons of Windows' special folders, the apps in the Start
// menu, and every icon inside Windows' own icon files, laid out like the emoji.
import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { systemIconCatalog, type IconCatalog } from "../lib/ipc";
import { appValue, folderIcons, resourceValue, systemValue } from "../state/folderIcons";
import { loadThumb } from "./Extras";

type Part = "apps" | "windows" | "shell" | "more";

const PARTS: readonly { id: Part; label: string; hint: string }[] = [
  { id: "apps", label: "Apps", hint: "The icons of the apps in your Start menu" },
  { id: "windows", label: "Windows", hint: "The colored icons of Documents, Downloads, 3D Objects and the other special folders, then the icons in Windows' own icon file (imageres.dll)" },
  { id: "shell", label: "Shell", hint: "Icons from the Windows shell (shell32.dll)" },
  { id: "more", label: "More", hint: "Icons from other Windows icon files" },
];

/** Which part holds the icon a folder already wears, so the tab opens where it is. */
function partOf(value: string | undefined): Part {
  if (value?.startsWith("app:")) return "apps";
  if (value?.startsWith("res:")) {
    const dll = value.split(":")[1];
    return dll === "imageres" ? "windows" : dll === "shell32" ? "shell" : "more";
  }
  // A special folder's icon is listed first in the Windows part.
  return value?.startsWith("sys:") ? "windows" : "apps";
}

/** Asked of Windows once per run: listing the Start menu takes a moment. */
let catalogPromise: Promise<IconCatalog> | null = null;
const loadCatalog = () => (catalogPromise ??= systemIconCatalog().catch((e: unknown) => {
  catalogPromise = null;
  throw e;
}));

/** One icon, fetched from Windows only once it scrolls into view. Nothing shows if Windows has no such icon. */
function LazyIcon(props: { source: string; size: number }) {
  let box!: HTMLSpanElement;
  const [url, setUrl] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal(false);
  onMount(() => {
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        void loadThumb(`${props.source}|icon|64`, props.source, 64, true).then((u) => (u ? setUrl(u) : setFailed(true)));
      },
      { rootMargin: "160px" },
    );
    io.observe(box);
    onCleanup(() => io.disconnect());
  });
  return (
    <span ref={box} class="win-icon" classList={{ failed: failed() }} style={{ width: `${props.size}px`, height: `${props.size}px` }}>
      <Show when={url()}>{(u) => <img src={u()} alt="" width={props.size} height={props.size} draggable={false} />}</Show>
    </span>
  );
}

const appSource = (id: string) => `shell:AppsFolder\\${id}`;
const resourceSource = (dll: string, index: number) => `res:${dll},${index}`;

export function WindowsIcons(props: { query: string; current: string | undefined; onPick: (value: string) => void }) {
  const [part, setPart] = createSignal<Part>(partOf(props.current));
  const [catalog] = createResource(loadCatalog);
  const q = () => props.query.trim().toLowerCase();
  const searching = () => q() !== "";
  const folders = () => folderIcons.styles().filter((s) => !q() || s.label.toLowerCase().includes(q()));
  const apps = () => (catalog()?.apps ?? []).filter((a) => !q() || a.label.toLowerCase().includes(q()));
  /** Every icon of the files that belong to a part. */
  const resources = (): { dll: string; index: number }[] => {
    const wanted = part() === "windows" ? ["imageres"] : part() === "shell" ? ["shell32"] : ["ddores", "moricons", "pifmgr"];
    return (catalog()?.resources ?? [])
      .filter((f) => wanted.includes(f.dll))
      .flatMap((f) => Array.from({ length: f.count }, (_, index) => ({ dll: f.dll, index })));
  };
  const showFolders = () => searching() || part() === "windows";
  const showApps = () => searching() || part() === "apps";
  const showResources = () => !searching() && (part() === "windows" || part() === "shell" || part() === "more");

  return (
    <div class="win-icons">
      <Show when={!searching()}>
        <div class="win-parts" role="tablist" aria-label="Kinds of Windows icons">
          <For each={PARTS}>
            {(p) => (
              <button class="win-part" classList={{ active: part() === p.id }} role="tab" aria-selected={part() === p.id} title={p.hint} onClick={() => setPart(p.id)}>
                {p.label}
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={showFolders() && folders().length > 0}>
        <Show when={searching()}><div class="win-heading">Folders</div></Show>
        <div class="sys-grid">
          <For each={folders()}>
            {(s) => (
              <button class="sys-cell" classList={{ chosen: props.current === systemValue(s.id) }} role="option" aria-selected={props.current === systemValue(s.id)} title={s.label} onClick={() => props.onPick(systemValue(s.id))}>
                <LazyIcon source={s.path} size={44} />
                <span class="sys-name">{s.label}</span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={showApps()}>
        <Show when={searching() && apps().length > 0}><div class="win-heading">Apps</div></Show>
        <div class="sys-grid">
          <For each={apps()}>
            {(a) => (
              <button class="sys-cell" classList={{ chosen: props.current === appValue(a.id) }} role="option" aria-selected={props.current === appValue(a.id)} title={a.label} onClick={() => props.onPick(appValue(a.id))}>
                <LazyIcon source={appSource(a.id)} size={44} />
                <span class="sys-name">{a.label}</span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={showResources()}>
        <div class="win-res-grid">
          <For each={resources()}>
            {(r) => (
              <button
                class="win-res"
                classList={{ chosen: props.current === resourceValue(r.dll, r.index) }}
                role="option"
                aria-selected={props.current === resourceValue(r.dll, r.index)}
                title={`${r.dll}.dll · icon ${r.index}`}
                onClick={() => props.onPick(resourceValue(r.dll, r.index))}
              >
                <LazyIcon source={resourceSource(r.dll, r.index)} size={40} />
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={catalog.loading && (showApps() || showResources())}>
        <div class="emoji-empty">Asking Windows for its icons…</div>
      </Show>
      <Show when={catalog.error && (showApps() || showResources())}>
        <div class="emoji-empty">Couldn't get the icon list from Windows</div>
      </Show>
      <Show when={!catalog.loading && !catalog.error && ((part() === "apps" && !searching() && apps().length === 0) || (searching() && folders().length === 0 && apps().length === 0))}>
        <div class="emoji-empty">{searching() ? "No Windows icon matches that" : "No apps found"}</div>
      </Show>
    </div>
  );
}
