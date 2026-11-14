// Shared footer tool buttons: live in the sidebar footer when wide enough, or in the status bar when narrow/collapsed.
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import * as A from "../actions";
import { batchActionFromPath, batchActionFromText, isBatchPath } from "../lib/customActions";
import { customActions } from "../state/customActions";
import { carriesPaths, dragRaw, dragState, isExternalDrag, onDragReset } from "../state/drag";
import { shelf } from "../state/shelf";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";
import { Glyph, IconBolt, IconDiskSpace, IconMop, IconTrash, MaterialIcon } from "./Icons";

export function FooterTools(props: { size: number }) {
  const [binDrag, setBinDrag] = createSignal(false);
  const [binHot, setBinHot] = createSignal(false);
  const [batDrag, setBatDrag] = createSignal(false);
  const [batHot, setBatHot] = createSignal(false);

  onMount(() => {
    const dragStart = (e: DragEvent) => {
      if (carriesPaths(e.dataTransfer) && !dragState.archive) {
        setBinDrag(true);
        if (dragState.paths.some(isBatchPath)) setBatDrag(true);
      }
    };
    const dragEnd = () => {
      setBinDrag(false);
      setBinHot(false);
      setBatDrag(false);
      setBatHot(false);
    };
    onCleanup(onDragReset(dragEnd));
    window.addEventListener("dragstart", dragStart);
    window.addEventListener("dragend", dragEnd);
    window.addEventListener("drop", dragEnd, true);
    onCleanup(() => {
      window.removeEventListener("dragstart", dragStart);
      window.removeEventListener("dragend", dragEnd);
      window.removeEventListener("drop", dragEnd, true);
    });
  });

  const activeDriveRoot = () => {
    const cur = workspace.activeTab()?.path() ?? "";
    const driveMatch = /^[a-z]:[\\/]/i.exec(cur);
    return driveMatch ? `${driveMatch[0].slice(0, 2)}\\` : "C:\\";
  };

  return (
    <>
      <button
        class="icon-btn foot-btn"
        data-shelf-toggle
        classList={{ on: shelf.open(), calling: shelf.dragging(), hot: shelf.dragging() && shelf.hot() }}
        onDragOver={(e) => {
          if (!shelf.dragging() || !carriesPaths(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          shelf.setHot(true);
        }}
        onDragLeave={() => shelf.setHot(false)}
        onDrop={(e) => {
          const raw = dragRaw(e.dataTransfer);
          if (!raw) return;
          e.preventDefault();
          shelf.add(JSON.parse(raw) as string[]);
        }}
        aria-label="Shelf"
        aria-pressed={shelf.open()}
        data-tooltip={shelf.open() ? "Hide shelf" : "Shelf · hold files here while you browse"}
        onClick={() => shelf.setOpen(!shelf.open())}
      >
        <Glyph code="E7B8" size={props.size} />
        <Show when={shelf.items().length > 0}>
          <span class="foot-badge">{shelf.items().length}</span>
        </Show>
      </button>
      <button
        class="icon-btn foot-btn bin-btn"
        classList={{ on: ui.recycleBinOpen(), calling: binDrag(), hot: binDrag() && binHot() }}
        onDragOver={(e) => {
          if (!binDrag() || !carriesPaths(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setBinHot(true);
        }}
        onDragLeave={() => setBinHot(false)}
        onDrop={(e) => {
          setBinHot(false);
          setBinDrag(false);
          const raw = dragRaw(e.dataTransfer);
          if (!raw || dragState.archive) return;
          e.preventDefault();
          A.recyclePaths(JSON.parse(raw) as string[]);
        }}
        aria-label="Recycle Bin"
        aria-pressed={ui.recycleBinOpen()}
        data-tooltip="Recycle Bin · drop items here to delete, or click to open"
        onClick={() => ui.setRecycleBinOpen(true)}
      >
        <IconTrash size={props.size} />
      </button>
      <button
        class="icon-btn foot-btn"
        classList={{ on: !!ui.diskSpaceRoot() }}
        aria-label="Disk space preview"
        aria-pressed={!!ui.diskSpaceRoot()}
        data-tooltip={`Disk space preview (${activeDriveRoot().replace(/\\$/, "")})`}
        onClick={() => ui.openDiskSpace(activeDriveRoot())}
      >
        <IconDiskSpace size={props.size} />
      </button>
      <button
        class="icon-btn foot-btn"
        classList={{ on: ui.systemCleanupOpen() }}
        aria-label="Free up space"
        aria-pressed={ui.systemCleanupOpen()}
        data-tooltip="Free up space · caches, Windows leftovers, Recycle Bin"
        onClick={() => ui.setSystemCleanupOpen(true)}
      >
        <IconMop size={props.size} />
      </button>
      <button
        class="icon-btn foot-btn"
        classList={{ on: ui.actionsEditorOpen(), calling: batDrag(), hot: batHot() }}
        onDragOver={(e) => {
          if (!((batDrag() && carriesPaths(e.dataTransfer)) || (isExternalDrag(e.dataTransfer) && e.dataTransfer?.types.includes("Files")))) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
          setBatHot(true);
        }}
        onDragLeave={() => setBatHot(false)}
        onDrop={(e) => {
          setBatHot(false);
          setBatDrag(false);
          const dt = e.dataTransfer;
          if (!dt) return;
          if (isExternalDrag(dt) && dt.files.length) {
            const batFiles = [...dt.files].filter((f) => isBatchPath(f.name));
            if (!batFiles.length) return;
            e.preventDefault();
            void Promise.all(
              batFiles.map(async (f) => {
                const nativePath = (f as File & { path?: string }).path;
                return nativePath ? batchActionFromPath(nativePath) : batchActionFromText(f.name, await f.text());
              }),
            ).then((candidates) => {
              const res = customActions.addBatchActions(candidates);
              ui.setActionsEditorOpen(true);
              if (res.added.length) ui.toast(`Added ${res.added.length} batch action${res.added.length === 1 ? "" : "s"}`);
              else if (res.existing.length) ui.toast(`"${res.existing[0].name}" is already in Custom actions`);
            });
          } else if (carriesPaths(dt)) {
            const raw = dragRaw(dt);
            const bats = (raw ? (JSON.parse(raw) as string[]) : []).filter(isBatchPath);
            if (!bats.length) return;
            e.preventDefault();
            const res = customActions.addBatchActions(bats.map(batchActionFromPath));
            ui.setActionsEditorOpen(true);
            if (res.added.length) ui.toast(`Added ${res.added.length} batch action${res.added.length === 1 ? "" : "s"}`);
            else if (res.existing.length) ui.toast(`"${res.existing[0].name}" is already in Custom actions`);
          }
        }}
        aria-label="Custom actions"
        aria-pressed={ui.actionsEditorOpen()}
        data-tooltip="Custom actions · drop .bat files here, or click to open"
        onClick={() => ui.setActionsEditorOpen(true)}
      >
        <IconBolt size={props.size} />
      </button>
      <button
        class="icon-btn foot-btn"
        classList={{ on: ui.rulesOpen() }}
        aria-label="Folder rules"
        aria-pressed={ui.rulesOpen()}
        data-tooltip="Folder rules · tidy old files, always previewed first"
        onClick={() => ui.setRulesOpen(true)}
      >
        <MaterialIcon name="rule" size={props.size} />
      </button>
      <button class="icon-btn foot-btn" aria-label="Settings" data-tooltip="Settings · Ctrl+," onClick={() => ui.openSettings()}>
        <Glyph code="E713" size={props.size} />
      </button>
    </>
  );
}
