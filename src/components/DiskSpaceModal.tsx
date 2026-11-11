// Lightweight disk space sunburst preview: renders cached/indexed folder sizes immediately and supports optional on-demand drive scanning.
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { formatSize } from "../lib/format";
import { cancelDiskSpace, diskSpaceTree, errorText, listDrives, scanDiskSpace, type Drive, type SpaceNode, type SpaceTree } from "../lib/ipc";
import { buildSunburstArcs, findSpaceTrail, sectorColor, SUNBURST_HUB_R, type SunburstArc } from "../lib/sunburst";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";
import { IconClose, IconDiskSpace, IconRefresh } from "./Icons";
import { Select, type Option } from "./Select";

const ALL_DRIVES = "__all__";
const driveRootKey = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
const driveLabel = (d: Drive) => `${d.label || (d.kind === "removable" ? "USB drive" : "Local Disk")} (${d.root.replace(/\\$/, "")})`;

function combineAllDrives(list: readonly Drive[], perDrive: ReadonlyMap<string, SpaceNode>): { root: SpaceNode; indexedBytes: number } {
  let totalBytes = 0;
  let totalFiles = 0;
  let indexedBytes = 0;
  let anyCached = false;
  const children: SpaceNode[] = [];
  for (const d of list) {
    const cached = perDrive.get(driveRootKey(d.root));
    const used = d.totalBytes > 0 ? Math.max(0, d.totalBytes - d.freeBytes) : 0;
    const bytes = Math.max(used, cached?.bytes ?? 0);
    if (bytes <= 0) continue;
    totalBytes += bytes;
    totalFiles += cached?.files ?? 0;
    indexedBytes += cached?.bytes ?? 0;
    if (cached?.cached) anyCached = true;
    children.push({
      name: driveLabel(d),
      path: d.root,
      bytes,
      files: cached?.files ?? 0,
      cached: cached?.cached ?? true,
      children: cached?.children ?? [],
    });
  }
  children.sort((a, b) => b.bytes - a.bytes);
  return {
    root: { name: "All drives", path: ALL_DRIVES, bytes: totalBytes, files: totalFiles, cached: anyCached, children },
    indexedBytes,
  };
}

export function DiskSpaceModal(props: { root: string }) {
  const [driveRoot, setDriveRoot] = createSignal(props.root);
  const [drives] = createResource(() => listDrives().catch(() => [] as Drive[]));
  const [tree, setTree] = createSignal<SpaceTree | null>(null);
  const [indexedTotal, setIndexedTotal] = createSignal(0);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [zoomPath, setZoomPath] = createSignal(props.root);
  const [hoveredId, setHoveredId] = createSignal<string | null>(null);
  let loadGen = 0;
  let scanAborted = false;
  const perDriveCache = new Map<string, SpaceNode>();

  const stopScan = () => {
    scanAborted = true;
    void cancelDiskSpace().catch(() => undefined);
    setTree((t) => (t?.scanning ? { ...t, scanning: false } : t));
  };

  const loadCached = async (root: string, list: readonly Drive[]) => {
    const gen = ++loadGen;
    scanAborted = true;
    void cancelDiskSpace().catch(() => undefined);
    setLoading(true);
    setError(null);
    setHoveredId(null);
    setZoomPath(root);
    try {
      if (root === ALL_DRIVES) {
        if (list.length === 0) return;
        const entries = await Promise.all(
          list.map(async (d) => [driveRootKey(d.root), (await diskSpaceTree(d.root)).root] as const),
        );
        if (gen !== loadGen) return;
        perDriveCache.clear();
        for (const [k, node] of entries) perDriveCache.set(k, node);
        const combined = combineAllDrives(list, perDriveCache);
        setTree({ root: combined.root, scanning: false, scanned: 0, total: 0 });
        setIndexedTotal(combined.indexedBytes);
      } else {
        const t = await diskSpaceTree(root);
        if (gen !== loadGen) return;
        setTree(t);
        setIndexedTotal(t.root.bytes);
      }
    } catch (e) {
      if (gen !== loadGen) return;
      setError(errorText(e));
    } finally {
      if (gen === loadGen) setLoading(false);
    }
  };

  const startScan = async () => {
    const root = driveRoot();
    const gen = ++loadGen;
    scanAborted = false;
    setError(null);
    try {
      if (root === ALL_DRIVES) {
        const list = drives() ?? [];
        const t = trail();
        // If zoomed inside a specific drive while in All drives mode, scan just that drive.
        const targets = t.length >= 2 ? list.filter((d) => driveRootKey(d.root) === driveRootKey(t[1].path)) : list;
        for (let i = 0; i < targets.length; i++) {
          if (gen !== loadGen || scanAborted) break;
          const d = targets[i];
          await scanDiskSpace(d.root, (update) => {
            if (gen !== loadGen || scanAborted) return;
            perDriveCache.set(driveRootKey(d.root), update.root);
            const combined = combineAllDrives(list, perDriveCache);
            setIndexedTotal(combined.indexedBytes);
            setTree({
              root: combined.root,
              scanning: true,
              scanned: targets.length > 1 ? i + (update.total > 0 ? update.scanned / update.total : 0) : update.scanned,
              total: targets.length > 1 ? targets.length : update.total,
            });
          });
        }
        if (gen === loadGen) setTree((cur) => (cur ? { ...cur, scanning: false } : cur));
      } else {
        await scanDiskSpace(root, (update) => {
          if (gen !== loadGen || scanAborted) return;
          setTree(update);
          setIndexedTotal(update.root.bytes);
        });
      }
    } catch (e) {
      if (gen === loadGen) setError(errorText(e));
    }
  };

  createEffect(() => {
    const root = driveRoot();
    const list = drives() ?? [];
    if (root === ALL_DRIVES && drives.loading) return;
    void loadCached(root, list);
  });

  onCleanup(() => {
    loadGen++;
    stopScan();
  });

  let dialogEl!: HTMLDivElement;
  onMount(() => dialogEl.focus());

  const currentDrive = createMemo(() => {
    const list = drives() ?? [];
    if (list.length === 0) return null;
    const root = driveRoot();
    if (root === ALL_DRIVES) {
      const t = trail();
      if (t.length >= 2) {
        const key = driveRootKey(t[1].path);
        const match = list.find((d) => driveRootKey(d.root) === key);
        if (match) return match;
      }
      return {
        root: ALL_DRIVES,
        label: "All drives",
        fileSystem: "",
        kind: "fixed" as const,
        totalBytes: list.reduce((s, d) => s + d.totalBytes, 0),
        freeBytes: list.reduce((s, d) => s + d.freeBytes, 0),
      };
    }
    const key = driveRootKey(root);
    return list.find((d) => driveRootKey(d.root) === key) ?? null;
  });

  const trail = createMemo<SpaceNode[]>(() => {
    const rootNode = tree()?.root;
    if (!rootNode) return [];
    return findSpaceTrail(rootNode, zoomPath());
  });

  const focused = createMemo<SpaceNode | null>(() => {
    const t = trail();
    return t.length ? t[t.length - 1] : null;
  });

  const arcs = createMemo<SunburstArc[]>(() => {
    const node = focused();
    return node ? buildSunburstArcs(node) : [];
  });

  const hoveredArc = createMemo(() => {
    const id = hoveredId();
    return id ? arcs().find((a) => a.id === id) ?? null : null;
  });

  const hoveredRowPath = createMemo(() => hoveredArc()?.node.path ?? null);

  const driveUsedBytes = () => {
    const d = currentDrive();
    return d && d.totalBytes > 0 ? Math.max(0, d.totalBytes - d.freeBytes) : 0;
  };
  const driveUsedRatio = () => {
    const d = currentDrive();
    return d && d.totalBytes > 0 ? Math.min(1, Math.max(0, (d.totalBytes - d.freeBytes) / d.totalBytes)) : 0;
  };

  const scanning = () => tree()?.scanning ?? false;
  const cachedTotal = () => indexedTotal();
  const totalCapacity = () => (drives() ?? []).reduce((s, d) => s + d.totalBytes, 0);

  const driveOptions = createMemo<Option<string>[]>(() => [
    {
      value: ALL_DRIVES,
      label: `All drives${totalCapacity() > 0 ? ` · ${formatSize(totalCapacity())}` : ""}`,
    },
    ...(drives() ?? []).map((d) => ({
      value: d.root,
      label: `${driveLabel(d)}${d.totalBytes > 0 ? ` · ${formatSize(d.totalBytes)}` : ""}`,
    })),
  ]);

  const openFolder = (path: string) => {
    if (!path || path === ALL_DRIVES) return;
    stopScan();
    ui.closeDiskSpace();
    void workspace.activeTab()?.navigate(path);
  };

  const canGoUp = () => trail().length > 1 || (driveRoot() !== ALL_DRIVES && (drives() ?? []).length > 1);
  const upLabel = () => (trail().length > 1 ? "↑ Go up" : "↑ All drives");

  const zoomUp = () => {
    const t = trail();
    if (t.length > 1) {
      setHoveredId(null);
      setZoomPath(t[t.length - 2].path);
    } else if (driveRoot() !== ALL_DRIVES && (drives() ?? []).length > 1) {
      setDriveRoot(ALL_DRIVES);
    }
  };

  const drillInto = (node: SpaceNode) => {
    if (!node.path) return;
    if (node.children.length > 0) {
      setHoveredId(null);
      setZoomPath(node.path);
    } else if (driveRoot() === ALL_DRIVES && (drives() ?? []).some((d) => driveRootKey(d.root) === driveRootKey(node.path))) {
      setDriveRoot(node.path);
    }
  };

  const close = () => {
    stopScan();
    ui.closeDiskSpace();
  };

  const readoutNode = () => hoveredArc()?.node ?? focused();
  const readoutShareView = () => {
    const a = hoveredArc();
    if (a) return a.shareOfRoot;
    return focused() ? 1 : 0;
  };
  const readoutShareDrive = () => {
    const used = driveUsedBytes();
    const bytes = readoutNode()?.bytes ?? 0;
    return used > 0 ? Math.min(1, bytes / used) : 0;
  };

  const ringCircumference = 2 * Math.PI * 36;

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={dialogEl}
        class="dialog space-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Disk space preview"
        tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") close();
          else if (e.key === "Backspace" && canGoUp()) zoomUp();
        }}
      >
        <header class="space-head">
          <div class="space-head-left">
            <IconDiskSpace size={18} class="space-title-icon" />
            <h2 class="space-title">Disk space</h2>
            <Show when={(drives() ?? []).length > 0}>
              <Select
                class="space-drive-select"
                label="Drive"
                value={driveRoot()}
                options={driveOptions()}
                onChange={setDriveRoot}
              />
            </Show>
          </div>

          <nav class="space-crumbs" aria-label="Zoom path">
            <Show when={driveRoot() !== ALL_DRIVES && (drives() ?? []).length > 1}>
              <button class="space-crumb" onClick={() => setDriveRoot(ALL_DRIVES)}>
                All drives
              </button>
              <span class="space-crumb-sep" aria-hidden="true">/</span>
            </Show>
            <For each={trail()}>
              {(node, i) => (
                <>
                  <Show when={i() > 0}>
                    <span class="space-crumb-sep" aria-hidden="true">/</span>
                  </Show>
                  <button
                    class="space-crumb"
                    classList={{ current: i() === trail().length - 1 }}
                    disabled={i() === trail().length - 1}
                    onClick={() => {
                      setHoveredId(null);
                      setZoomPath(node.path);
                    }}
                  >
                    {node.name}
                  </button>
                </>
              )}
            </For>
          </nav>

          <div class="space-head-actions">
            <Show
              when={!scanning()}
              fallback={
                <>
                  <span class="space-status num">
                    Scanning {Math.floor(tree()!.scanned)}/{tree()!.total}
                  </span>
                  <button class="btn small" onClick={stopScan}>
                    Stop
                  </button>
                </>
              }
            >
              <Show when={cachedTotal() > 0}>
                <span class="space-badge">{focused()?.cached ? "Cached" : "Indexed"}</span>
              </Show>
              <button class="btn small" onClick={() => void startScan()} data-tooltip="Scan folders on this drive to refresh sizes">
                <IconRefresh size={12} /> {driveRoot() === ALL_DRIVES && trail().length < 2 ? "Scan all" : cachedTotal() > 0 ? "Rescan" : "Scan drive"}
              </button>
            </Show>
            <button class="icon-btn" aria-label="Close" onClick={close}>
              <IconClose size={14} />
            </button>
          </div>
        </header>

        <div class="space-body">
          <div class="space-stage">
            <Show when={!error()} fallback={<p class="error-text">{error()}</p>}>
              <Show
                when={!loading() && (tree()?.root.bytes ?? 0) > 0}
                fallback={
                  <div class="space-empty">
                    <Show
                      when={!loading() && !scanning()}
                      fallback={<p class="muted">{scanning() ? "Scanning drive folders…" : "Reading cached sizes…"}</p>}
                    >
                      <IconDiskSpace size={34} class="space-empty-icon" />
                      <p class="space-empty-title">No cached sizes for this drive yet</p>
                      <p class="muted small">Browse folders to build the cache automatically, or scan the drive now.</p>
                      <button class="btn primary" onClick={() => void startScan()}>
                        Scan drive
                      </button>
                    </Show>
                  </div>
                }
              >
                <div class="space-chart-wrap">
                  <svg class="space-svg" viewBox="-250 -250 500 500" role="img" aria-label={`Disk space chart for ${focused()?.name ?? driveRoot()}`}>
                    <For each={arcs()}>
                      {(arc) => {
                        const isHot = () => hoveredId() === arc.id;
                        const canZoom = () => !!arc.node.path && arc.node.children.length > 0;
                        return (
                          <g
                            class="space-arc-group"
                            classList={{ hot: isHot(), clickable: !!arc.node.path }}
                            data-tooltip={`${arc.node.name} — ${formatSize(arc.node.bytes)} (${(arc.shareOfRoot * 100).toFixed(1)}%)${canZoom() ? " · Click to zoom, double-click to open" : ""}`}
                            onMouseEnter={() => setHoveredId(arc.id)}
                            onMouseLeave={() => hoveredId() === arc.id && setHoveredId(null)}
                            onClick={() => drillInto(arc.node)}
                            onDblClick={() => openFolder(arc.node.path)}
                          >
                            <path d={arc.pathD} fill={arc.color} class="space-arc" />
                            <Show when={arc.showLabel}>
                              <text
                                class="space-arc-label"
                                x={arc.labelX}
                                y={arc.labelY}
                                transform={`rotate(${arc.labelDeg.toFixed(1)} ${arc.labelX.toFixed(1)} ${arc.labelY.toFixed(1)})`}
                              >
                                {arc.label}
                              </text>
                            </Show>
                          </g>
                        );
                      }}
                    </For>
                    <g
                      class="space-hub"
                      classList={{ clickable: canGoUp() }}
                      data-tooltip={canGoUp() ? (trail().length > 1 ? "Go up one folder (Backspace)" : "View all drives (Backspace)") : undefined}
                      onClick={zoomUp}
                      onMouseEnter={() => setHoveredId(null)}
                    >
                      <circle cx="0" cy="0" r={SUNBURST_HUB_R} />
                      <text class="space-hub-name" y={canGoUp() ? -10 : -4}>
                        {focused()?.name}
                      </text>
                      <text class="space-hub-size num" y={canGoUp() ? 8 : 14}>
                        {formatSize(focused()?.bytes ?? 0)}
                      </text>
                      <Show when={canGoUp()}>
                        <text class="space-hub-up" y="25">
                          {upLabel()}
                        </text>
                      </Show>
                    </g>
                  </svg>
                </div>

                <Show when={readoutNode()}>
                  {(node) => (
                    <div class="space-readout">
                      <div class="space-readout-main">
                        <span class="space-readout-name">{node().path || node().name}</span>
                        <span class="space-readout-stats num muted">
                          {formatSize(node().bytes)} · {(readoutShareView() * 100).toFixed(1)}% of view
                          <Show when={driveUsedBytes() > 0}> · {(readoutShareDrive() * 100).toFixed(1)}% of used</Show>
                          {" · "}
                          {node().files.toLocaleString()} files
                        </span>
                      </div>
                      <Show when={node().path && node().path !== ALL_DRIVES}>
                        <button class="btn small" onClick={() => openFolder(node().path)}>
                          Open folder
                        </button>
                      </Show>
                    </div>
                  )}
                </Show>
              </Show>
            </Show>
          </div>

          <aside class="space-rail" aria-label="Drive details">
            <Show when={currentDrive()}>
              {(d) => (
                <section class="space-usage">
                  <div class="space-gauge-row">
                    <svg class="space-gauge" viewBox="0 0 92 92" aria-hidden="true">
                      <circle class="space-gauge-track" cx="46" cy="46" r="36" />
                      <circle
                        class="space-gauge-fill"
                        classList={{ full: driveUsedRatio() > 0.9 }}
                        cx="46"
                        cy="46"
                        r="36"
                        stroke-dasharray={String(ringCircumference)}
                        stroke-dashoffset={ringCircumference * (1 - driveUsedRatio())}
                      />
                      <text class="space-gauge-pct num" x="46" y="45">
                        {Math.round(driveUsedRatio() * 100)}%
                      </text>
                      <text class="space-gauge-sub" x="46" y="59">
                        used
                      </text>
                    </svg>
                    <dl class="space-kv">
                      <div>
                        <dt>Used</dt>
                        <dd class="num">{formatSize(driveUsedBytes())}</dd>
                      </div>
                      <div>
                        <dt>Free</dt>
                        <dd class="num">{formatSize(d().freeBytes)}</dd>
                      </div>
                      <div>
                        <dt>Capacity</dt>
                        <dd class="num">{formatSize(d().totalBytes)}</dd>
                      </div>
                      <div>
                        <dt>Indexed</dt>
                        <dd class="num">{formatSize(cachedTotal())}</dd>
                      </div>
                    </dl>
                  </div>
                </section>
              )}
            </Show>

            <section class="space-list-section">
              <div class="space-list-head">
                <span>{focused()?.path === ALL_DRIVES ? "Drives" : `Folders in ${focused()?.name ?? driveRoot()}`}</span>
                <span class="muted small num">{focused()?.children.length ?? 0}</span>
              </div>
              <div class="space-list">
                <For each={focused()?.children ?? []}>
                  {(child, idx) => {
                    const isOther = () => child.name === "Other" && child.path === "";
                    const pct = () => {
                      const total = focused()?.bytes ?? 0;
                      return total > 0 ? (child.bytes / total) * 100 : 0;
                    };
                    const arcMatch = () => arcs().find((a) => a.depth === 1 && a.node === child);
                    const isHot = () => (hoveredRowPath() && child.path === hoveredRowPath()) || (arcMatch() && hoveredId() === arcMatch()!.id);
                    return (
                      <button
                        class="space-row"
                        classList={{ hot: !!isHot() }}
                        disabled={isOther()}
                        onMouseEnter={() => arcMatch() && setHoveredId(arcMatch()!.id)}
                        onMouseLeave={() => arcMatch() && hoveredId() === arcMatch()!.id && setHoveredId(null)}
                        onClick={() => drillInto(child)}
                        onDblClick={() => openFolder(child.path)}
                        data-tooltip={child.path || undefined}
                        data-tooltip-truncated=".space-row-name"
                      >
                        <span class="space-dot" style={{ background: sectorColor(idx(), 1, isOther()) }} />
                        <span class="space-row-body">
                          <span class="space-row-top">
                            <span class="space-row-name">{child.name}</span>
                            <span class="space-row-size num">{formatSize(child.bytes)}</span>
                          </span>
                          <span class="space-row-bar">
                            <span style={{ width: `${Math.min(100, pct()).toFixed(1)}%`, background: sectorColor(idx(), 1, isOther()) }} />
                          </span>
                        </span>
                        <span class="space-row-pct num muted">{pct().toFixed(0)}%</span>
                      </button>
                    );
                  }}
                </For>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
