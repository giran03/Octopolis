// "All drives" overview (Devices and drives): shows fixed drives, USB sticks, optical discs, network drives, and WSL distros.
import { createResource, For, onCleanup, onMount, Show } from "solid-js";
import * as A from "../actions";
import { formatSize } from "../lib/format";
import { disconnectNetworkDrive, errorText, knownFolders, listDrives, mapNetworkDrive, wslDistros, type Drive } from "../lib/ipc";
import { baseName } from "../lib/paths";
import type { TabModel } from "../state/tab";
import { ui, type MenuEntry } from "../state/ui";
import { Glyph, IconDiskSpace, IconDrive, PathIcon } from "./Icons";

const ejectable = (d: Drive) => d.kind === "removable" || d.kind === "optical";

const kindBadge = (kind: Drive["kind"]) =>
  kind === "removable" ? "USB" : kind === "network" ? "Network" : kind === "optical" ? "Disc" : "";

export function DrivesView(props: { tab: TabModel }) {
  const [drives, { refetch: refetchDrives }] = createResource(() => listDrives().catch(() => [] as Drive[]));
  const [distros, { refetch: refetchDistros }] = createResource(() => wslDistros().catch(() => [] as string[]));
  const [folders] = createResource(() => knownFolders().catch(() => []));

  const refreshAll = () => {
    void refetchDrives();
    void refetchDistros();
  };

  onMount(() => {
    window.addEventListener("focus", refreshAll);
    onCleanup(() => window.removeEventListener("focus", refreshAll));
  });

  const home = () => folders()?.find((f) => f.id === "home")?.path ?? "C:\\";

  const openPath = (path: string, e?: MouseEvent) => {
    if (e && (e.ctrlKey || e.metaKey)) {
      A.openInNewTab(path, false);
      return;
    }
    void props.tab.navigate(path);
  };

  const onMiddle = (path: string) => (e: MouseEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    A.openInNewTab(path, false);
  };

  const openDriveMenu = (d: Drive, e: MouseEvent) => {
    e.preventDefault();
    const letter = d.root.replace(/\\$/, "");
    const entries: MenuEntry[] = [
      { label: "Open", run: () => void props.tab.navigate(d.root) },
      { label: "Open in new tab", run: () => A.openInNewTab(d.root, false) },
      "separator",
      { label: "Disk space preview", run: () => ui.openDiskSpace(d.root) },
      ...(ejectable(d)
        ? [
            "separator" as const,
            {
              label: "Eject",
              run: () => void A.ejectDriveSafely(d.root, home(), refreshAll),
            },
          ]
        : []),
      ...(d.kind === "network"
        ? [
            "separator" as const,
            {
              label: "Disconnect",
              run: () =>
                void disconnectNetworkDrive(d.root)
                  .then(refreshAll)
                  .catch((err) => ui.toast(`Couldn't disconnect ${letter}: ${errorText(err)}`)),
            },
          ]
        : []),
    ];
    ui.openMenu(e.clientX, e.clientY, entries);
  };

  return (
    <div class="drives-view" tabindex="0">
      <div class="drives-section">
        <div class="drives-head">
          <h2 class="drives-title">Devices and drives</h2>
          <span class="drives-count muted small">{drives()?.length ?? 0}</span>
          <button class="btn small" onClick={() => void mapNetworkDrive().then(refreshAll).catch((e) => ui.toast(errorText(e)))}>
            <Glyph code="E710" size={12} /> Map network drive
          </button>
          <button class="btn small" onClick={refreshAll}>
            <Glyph code="E72C" size={12} /> Refresh
          </button>
          <span class="drives-spacer" />
          <button class="btn small" onClick={() => ui.openDiskSpace("__all__")}>
            <IconDiskSpace size={14} /> Disk space preview
          </button>
        </div>
        <div class="drives-grid">
          <For each={drives() ?? []} fallback={<p class="muted">No drives found.</p>}>
            {(d) => {
              const letter = d.root.replace(/\\$/, "");
              const label = d.label || (d.kind === "removable" ? "USB drive" : d.kind === "optical" ? "Optical drive" : d.kind === "network" ? "Network drive" : "Local Disk");
              const used = d.totalBytes > 0 ? Math.max(0, Math.min(1, 1 - d.freeBytes / d.totalBytes)) : 0;
              const badge = kindBadge(d.kind);
              return (
                <button
                  class="drive-card"
                  onClick={(e) => openPath(d.root, e)}
                  onMouseDown={onMiddle(d.root)}
                  onContextMenu={(e) => openDriveMenu(d, e)}
                >
                  <span class="drive-card-icon">
                    <PathIcon path={d.root} name={letter} isDir exact size={38} fallback={<IconDrive kind={d.kind} size={38} />} />
                  </span>
                  <span class="drive-card-body">
                    <span class="drive-card-top">
                      <span class="drive-card-name">{label} ({letter})</span>
                      <Show when={badge}>
                        <span class="drive-card-badge">{badge}</span>
                      </Show>
                    </span>
                    <Show
                      when={d.totalBytes > 0}
                      fallback={
                        <span class="drive-card-meta muted small">
                          {d.kind === "optical" ? "No disc inserted" : d.fileSystem || "Ready"}
                        </span>
                      }
                    >
                      <span class="drives-bar" aria-hidden="true">
                        <span
                          class="drives-bar-fill"
                          classList={{ warn: used > 0.85 && used <= 0.9, full: used > 0.9 }}
                          style={{ width: `${used * 100}%` }}
                        />
                      </span>
                      <span class="drive-card-meta muted small">
                        {formatSize(d.freeBytes)} free of {formatSize(d.totalBytes)}
                        <Show when={d.fileSystem}>
                          <span> · {d.fileSystem}</span>
                        </Show>
                      </span>
                    </Show>
                  </span>
                </button>
              );
            }}
          </For>
        </div>
      </div>

      <Show when={(distros() ?? []).length > 0}>
        <div class="drives-section">
          <div class="drives-head">
            <h2 class="drives-title">Linux (WSL)</h2>
            <span class="drives-count muted small">{distros()!.length}</span>
          </div>
          <div class="drives-grid">
            <For each={distros() ?? []}>
              {(root) => (
                <button
                  class="drive-card"
                  onClick={(e) => openPath(root, e)}
                  onMouseDown={onMiddle(root)}
                >
                  <span class="drive-card-icon">
                    <Glyph code="E756" size={30} />
                  </span>
                  <span class="drive-card-body">
                    <span class="drive-card-top">
                      <span class="drive-card-name">{baseName(root)}</span>
                      <span class="drive-card-badge">WSL</span>
                    </span>
                    <span class="drive-card-meta muted small">{root}</span>
                  </span>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
