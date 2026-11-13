// Zoomable, pannable inspector viewer for raster images, animated GIFs and SVGs
// with vertical centering, cursor-anchored wheel zoom, minimap navigator and metadata sheet.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { formatDate, formatSize } from "../lib/format";
import {
  clampPan,
  computeFitScale,
  formatAspectRatio,
  isOverflowing,
  MAX_ZOOM,
  MIN_ZOOM,
  minimapGeometry,
  panForMinimapFraction,
  stepZoomScale,
  zoomAround,
  type Pan,
  type Size2D,
} from "../lib/imageView";
import { thumbnail } from "../lib/ipc";
import { extensionOf } from "../lib/paths";
import { IconFit, IconInfo, IconZoomIn, IconZoomOut } from "./Icons";

export interface ImageViewerTarget {
  readonly path: string;
  readonly name: string;
  readonly modified: number;
  readonly size: number;
}

export function ImageViewer(props: {
  url: string;
  target: ImageViewerTarget;
  isSvg: boolean;
  details: readonly [string, string][];
  showInfo?: boolean;
  onToggleInfo?: () => void;
}) {
  let stageRef!: HTMLDivElement;
  let imgRef!: HTMLImageElement;

  const [viewSize, setViewSize] = createSignal<Size2D>({ w: 0, h: 0 });
  const [imgSize, setImgSize] = createSignal<Size2D>({ w: 0, h: 0 });
  const [mode, setMode] = createSignal<"fit" | "custom">("fit");
  const [customScale, setCustomScale] = createSignal(1);
  const [pan, setPan] = createSignal<Pan>({ x: 0, y: 0 });
  const [dragging, setDragging] = createSignal(false);
  const [localInfo, setLocalInfo] = createSignal(false);
  // If the page can't decode the bytes (an odd PNG, a mislabelled file), Windows' own decoder gets one try.
  const [src, setSrc] = createSignal(props.url);
  const [failed, setFailed] = createSignal(false);
  let triedFallback = false;
  let ownUrl: string | null = null;
  const dropOwnUrl = () => {
    if (ownUrl) URL.revokeObjectURL(ownUrl);
    ownUrl = null;
  };
  onCleanup(dropOwnUrl);
  const onImageError = () => {
    if (triedFallback || props.isSvg) return setFailed(true);
    triedFallback = true;
    const forPath = props.target.path;
    thumbnail(forPath, 2048, false).then(
      (b) => {
        if (forPath !== props.target.path) return;
        dropOwnUrl();
        ownUrl = URL.createObjectURL(new Blob([b], { type: "image/png" }));
        setSrc(ownUrl);
      },
      () => forPath === props.target.path && setFailed(true),
    );
  };
  const showInfo = () => props.showInfo ?? localInfo();
  const toggleInfo = () => (props.onToggleInfo ? props.onToggleInfo() : setLocalInfo((v) => !v));

  onMount(() => {
    const measure = () => setViewSize({ w: stageRef.clientWidth, h: stageRef.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stageRef);
    onCleanup(() => ro.disconnect());
  });

  // Reset viewport framing whenever a new image URL loads, preserving the Info drawer preference.
  createEffect(
    on(
      () => props.url,
      () => {
        dropOwnUrl();
        triedFallback = false;
        setFailed(false);
        setSrc(props.url);
        setImgSize({ w: 0, h: 0 });
        setMode("fit");
        setCustomScale(1);
        setPan({ x: 0, y: 0 });
        setDragging(false);
      },
    ),
  );

  const fitScale = createMemo(() => computeFitScale(viewSize(), imgSize(), props.isSvg));
  const effectiveScale = () => (mode() === "fit" ? fitScale() : customScale());
  const clampedPan = createMemo(() =>
    mode() === "fit" ? { x: 0, y: 0 } : clampPan(pan(), viewSize(), imgSize(), effectiveScale()),
  );
  const overflowing = () => imgSize().w > 0 && isOverflowing(viewSize(), imgSize(), effectiveScale());
  const minimap = createMemo(() => minimapGeometry(viewSize(), imgSize(), effectiveScale(), clampedPan()));
  const zoomPct = () => Math.round(effectiveScale() * 100);
  const isAtOneToOne = () => mode() === "custom" && Math.abs(effectiveScale() - 1) < 0.01;

  const setFit = () => {
    setMode("fit");
    setPan({ x: 0, y: 0 });
  };

  const applyScale = (nextScale: number, anchor: Pan = { x: 0, y: 0 }) => {
    if (imgSize().w <= 0) return;
    const res = zoomAround(clampedPan(), effectiveScale(), nextScale, anchor, viewSize(), imgSize());
    setMode("custom");
    setCustomScale(res.scale);
    setPan(res.pan);
  };

  const zoomStep = (dir: 1 | -1) => applyScale(stepZoomScale(effectiveScale(), dir));

  const toggleActualSize = () => {
    if (isAtOneToOne()) setFit();
    else applyScale(1);
  };

  const onImageLoad = () => {
    const w = imgRef.naturalWidth || imgRef.clientWidth || 300;
    const h = imgRef.naturalHeight || imgRef.clientHeight || 300;
    setImgSize({ w, h });
  };

  const onWheel = (e: WheelEvent) => {
    if (imgSize().w <= 0) return;
    e.preventDefault();
    const factor = Math.max(0.75, Math.min(1.35, Math.pow(1.0018, -e.deltaY)));
    const r = stageRef.getBoundingClientRect();
    const anchor = { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
    applyScale(effectiveScale() * factor, anchor);
  };

  const onStagePointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !overflowing()) return;
    if ((e.target as HTMLElement).closest(".img-nav")) return;
    e.preventDefault();
    stageRef.focus();
    stageRef.setPointerCapture(e.pointerId);
    setDragging(true);
    let [lx, ly] = [e.clientX, e.clientY];
    let current = clampedPan();
    const move = (m: PointerEvent) => {
      current = clampPan(
        { x: current.x + (m.clientX - lx), y: current.y + (m.clientY - ly) },
        viewSize(),
        imgSize(),
        effectiveScale(),
      );
      [lx, ly] = [m.clientX, m.clientY];
      setPan(current);
    };
    const up = () => {
      setDragging(false);
      stageRef.removeEventListener("pointermove", move);
      stageRef.removeEventListener("pointerup", up);
      stageRef.removeEventListener("pointercancel", up);
    };
    stageRef.addEventListener("pointermove", move);
    stageRef.addEventListener("pointerup", up);
    stageRef.addEventListener("pointercancel", up);
  };

  const onStageDblClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(".img-nav") || imgSize().w <= 0) return;
    const r = stageRef.getBoundingClientRect();
    const anchor = { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
    if (mode() === "fit") {
      const targetScale = fitScale() < 0.95 ? 1 : 2;
      applyScale(targetScale, anchor);
    } else {
      setFit();
    }
  };

  const onMinimapPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || imgSize().w <= 0) return;
    e.preventDefault();
    e.stopPropagation();
    const nav = e.currentTarget as HTMLDivElement;
    nav.setPointerCapture(e.pointerId);
    const jumpTo = (clientX: number, clientY: number) => {
      const r = nav.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const fx = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      const fy = Math.max(0, Math.min(1, (clientY - r.top) / r.height));
      setMode("custom");
      setCustomScale(effectiveScale());
      setPan(panForMinimapFraction(fx, fy, viewSize(), imgSize(), effectiveScale()));
    };
    jumpTo(e.clientX, e.clientY);
    const move = (m: PointerEvent) => jumpTo(m.clientX, m.clientY);
    const up = () => {
      nav.removeEventListener("pointermove", move);
      nav.removeEventListener("pointerup", up);
      nav.removeEventListener("pointercancel", up);
    };
    nav.addEventListener("pointermove", move);
    nav.addEventListener("pointerup", up);
    nav.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      e.stopPropagation();
      zoomStep(1);
    } else if (e.key === "-") {
      e.preventDefault();
      e.stopPropagation();
      zoomStep(-1);
    } else if (e.key === "0") {
      e.preventDefault();
      e.stopPropagation();
      setFit();
    } else if (e.key === "1") {
      e.preventDefault();
      e.stopPropagation();
      toggleActualSize();
    } else if (e.key === "i" || e.key === "I") {
      e.preventDefault();
      e.stopPropagation();
      toggleInfo();
    }
  };

  const metadataRows = createMemo(() => {
    const rows: [string, string][] = [];
    const { w, h } = imgSize();
    if (w > 0 && h > 0) {
      const mp = (w * h) / 1_000_000;
      rows.push(["Dimensions", `${w.toLocaleString()} × ${h.toLocaleString()} px${mp >= 0.1 ? ` (${mp.toFixed(1)} MP)` : ""}`]);
      rows.push(["Aspect ratio", formatAspectRatio(w, h)]);
    }
    const ext = extensionOf(props.target.name).toUpperCase();
    if (ext) rows.push(["Format", ext]);
    rows.push(["File size", formatSize(props.target.size)]);
    rows.push(["Modified", formatDate(props.target.modified)]);
    for (const [k, v] of props.details) rows.push([k, v]);
    rows.push(["Path", props.target.path]);
    return rows;
  });

  return (
    <div class="image-viewer">
      <div class="inspector-media-bar">
        <div class="media-btn-group" role="group" aria-label="Image zoom controls">
          <button
            class="media-ctrl-btn"
            aria-label="Zoom out"
            data-tooltip="Zoom out (-)"
            disabled={effectiveScale() <= MIN_ZOOM + 0.001}
            onClick={() => zoomStep(-1)}
          >
            <IconZoomOut size={13} />
          </button>
          <button
            class="media-ctrl-btn media-zoom-readout num"
            classList={{ on: isAtOneToOne() }}
            aria-label="Actual size 100%"
            data-tooltip={isAtOneToOne() ? "Return to fit (0)" : "Actual size 100% (1)"}
            onClick={toggleActualSize}
          >
            {zoomPct()}%
          </button>
          <button
            class="media-ctrl-btn"
            aria-label="Zoom in"
            data-tooltip="Zoom in (+)"
            disabled={effectiveScale() >= MAX_ZOOM - 0.001}
            onClick={() => zoomStep(1)}
          >
            <IconZoomIn size={13} />
          </button>
          <span class="media-sep" aria-hidden="true" />
          <button
            class="media-ctrl-btn media-ctrl-text"
            classList={{ on: mode() === "fit" }}
            aria-pressed={mode() === "fit"}
            data-tooltip="Fit to inspector (0)"
            onClick={setFit}
          >
            <IconFit size={13} />
            <span>Fit</span>
          </button>
        </div>

        <div class="media-btn-group" role="group" aria-label="Image info controls">
          <button
            class="media-ctrl-btn media-ctrl-text"
            classList={{ on: showInfo() }}
            aria-pressed={showInfo()}
            data-tooltip="Detailed image info & EXIF (I)"
            onClick={toggleInfo}
          >
            <IconInfo size={13} />
            <span>Info</span>
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        class="image-stage"
        classList={{ "can-pan": overflowing(), dragging: dragging() }}
        tabIndex={0}
        onWheel={onWheel}
        onPointerDown={onStagePointerDown}
        onDblClick={onStageDblClick}
        onKeyDown={onKeyDown}
      >
        <Show when={failed()}>
          <p class="muted small preview-img-failed">This image can't be shown here. Double-click the file to open it in your image viewer.</p>
        </Show>
        <img
          ref={imgRef}
          class="preview-img-zoom"
          classList={{ pixelated: effectiveScale() >= 4 && !props.isSvg, settled: imgSize().w > 0 }}
          hidden={failed()}
          src={src()}
          alt={props.target.name}
          draggable={false}
          onLoad={onImageLoad}
          onError={onImageError}
          style={
            imgSize().w > 0
              ? {
                  width: `${imgSize().w}px`,
                  height: `${imgSize().h}px`,
                  transform: `translate3d(${clampedPan().x}px, ${clampedPan().y}px, 0) scale(${effectiveScale()})`,
                }
              : undefined
          }
        />

        <Show when={overflowing()}>
          <div
            class="img-nav"
            role="presentation"
            style={{ width: `${minimap().box.w}px`, height: `${minimap().box.h}px` }}
            onPointerDown={onMinimapPointerDown}
          >
            <img class="img-nav-thumb" src={src()} alt="" draggable={false} />
            <div
              class="img-nav-rect"
              style={{
                left: `${(minimap().rect.left * 100).toFixed(2)}%`,
                top: `${(minimap().rect.top * 100).toFixed(2)}%`,
                width: `${(minimap().rect.width * 100).toFixed(2)}%`,
                height: `${(minimap().rect.height * 100).toFixed(2)}%`,
              }}
            />
          </div>
        </Show>
      </div>

      <Show when={showInfo()}>
        <div class="img-details-panel" role="region" aria-label="Image details">
          <dl class="tags img-details-grid">
            <For each={metadataRows()}>
              {([k, v]) => (
                <>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </>
              )}
            </For>
          </dl>
        </div>
      </Show>
    </div>
  );
}
