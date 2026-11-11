// Quick access folders and drives.
import { createResource, For, onCleanup, onMount, Show } from "solid-js";
import { formatSize } from "../lib/format";
import { knownFolders, listDrives, type Drive } from "../lib/ipc";
import { samePath } from "../lib/paths";
import { workspace } from "../state/workspace";
import { IconDrive, IconHome, IconStar } from "./Icons";

export function Sidebar() {
  const [folders] = createResource(knownFolders);
  const [drives, { refetch }] = createResource(listDrives);

  onMount(() => {
    // Drives come and go (USB sticks); recheck when the window regains focus.
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    onCleanup(() => window.removeEventListener("focus", onFocus));
  });

  const current = () => workspace.activeTab()?.path() ?? "";
  const go = (path: string) => void workspace.activeTab()?.navigate(path);

  return (
    <nav class="sidebar" aria-label="Places">
      <div class="side-heading">Quick access</div>
      <For each={folders() ?? []}>
        {(f) => (
          <button class="side-item" classList={{ current: samePath(f.path, current()) }} onClick={() => go(f.path)} title={f.path}>
            {f.id === "home" ? <IconHome /> : <IconStar />}
            <span>{f.label}</span>
          </button>
        )}
      </For>
      <div class="side-heading">Drives</div>
      <For each={drives() ?? []}>{(d) => <DriveItem drive={d} current={current()} onOpen={go} />}</For>
    </nav>
  );
}

function DriveItem(props: { drive: Drive; current: string; onOpen: (p: string) => void }) {
  const d = () => props.drive;
  const letter = () => d().root.replace(/\\$/, "");
  const used = () => (d().totalBytes ? 1 - d().freeBytes / d().totalBytes : 0);
  const active = () => props.current.toLowerCase().startsWith(d().root.toLowerCase());
  return (
    <button class="side-item drive" classList={{ current: active() }} onClick={() => props.onOpen(d().root)} title={`${d().label || "Local Disk"} (${letter()}) · ${d().fileSystem}`}>
      <IconDrive kind={d().kind} />
      <span class="drive-text">
        <span>
          {d().label || (d().kind === "removable" ? "USB drive" : "Local Disk")} ({letter()})
        </span>
        <Show when={d().totalBytes > 0}>
          <span class="usage" classList={{ full: used() > 0.9 }}>
            <span style={{ width: `${used() * 100}%` }} />
          </span>
          <span class="drive-free">{formatSize(d().freeBytes)} free of {formatSize(d().totalBytes)}</span>
        </Show>
      </span>
    </button>
  );
}
