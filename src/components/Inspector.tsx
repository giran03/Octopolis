// Side panel previewing the focused item: code, Markdown, images, SVG, PDF,
// audio with a waveform, video, 3D models, hex dumps and archive summaries.
import { createEffect, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { formatDate, formatSize } from "../lib/format";
import { errorText, previewFile, readBytes, thumbnail, type Preview } from "../lib/ipc";
import { baseOf, isDir } from "../lib/listing";
import { boundsOf, parseObj, parseStl, type Mesh } from "../lib/model3d";
import { extensionOf } from "../lib/paths";
import { settings } from "../state/settings";
import { workspace } from "../state/workspace";
import { IconClose } from "./Icons";

const DEBOUNCE_MS = 110;
/** Rendering more lines than this at once makes the panel sluggish. */
const MAX_CODE_LINES = 4000;
const MAX_DRAWN_TRIANGLES = 40_000;

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
  svg: "image/svg+xml", pdf: "application/pdf", mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", opus: "audio/ogg",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4", mkv: "video/x-matroska",
};

interface Target {
  readonly path: string;
  readonly name: string;
  readonly dir: boolean;
  readonly modified: number;
  readonly size: number | undefined;
}

function currentTarget(): Target | null {
  const tab = workspace.activeTab();
  if (!tab) return null;
  const l = tab.listing();
  const sel = [...tab.selection()];
  const entry = sel.length === 1 ? sel[0] : tab.view()[tab.focus()];
  if (entry === undefined || entry >= l.count) return null;
  const dir = isDir(l, entry);
  return {
    path: tab.pathOf(entry),
    name: baseOf(l.names[entry]),
    dir,
    modified: l.mtimes[entry],
    size: dir ? tab.dirSizes()?.get(l.names[entry].toLowerCase()) : l.sizes[entry],
  };
}

export function Inspector() {
  const [target, setTarget] = createSignal<Target | null>(null);
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [blobUrl, setBlobUrl] = createSignal<string | null>(null);
  const [bytes, setBytes] = createSignal<ArrayBuffer | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let token = 0;

  const release = () => {
    const u = blobUrl();
    if (u) URL.revokeObjectURL(u);
    setBlobUrl(null);
    setBytes(null);
  };
  onCleanup(() => {
    clearTimeout(timer);
    release();
  });

  async function load(t: Target) {
    const mine = ++token;
    release();
    setError(null);
    setPreview(null);
    if (t.dir) return;
    try {
      const p = await previewFile(t.path);
      if (mine !== token) return;
      setPreview(p);
      if (["image", "svg", "pdf", "audio", "video", "model"].includes(p.kind)) {
        const buf = await readBytes(t.path);
        if (mine !== token) return;
        setBytes(buf);
        const type = MIME[extensionOf(t.name)] ?? "application/octet-stream";
        setBlobUrl(URL.createObjectURL(new Blob([buf], { type })));
      }
    } catch (e) {
      if (mine === token) setError(errorText(e));
    }
  }

  // Follow the list focus, debounced so holding an arrow key stays smooth.
  createEffect(() => {
    const t = currentTarget();
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (t?.path !== target()?.path) {
        setTarget(t);
        if (t) void load(t);
      } else setTarget(t);
    }, DEBOUNCE_MS);
  });

  const onLinkClick = (e: MouseEvent) => {
    // Links in a previewed document must not navigate the app away.
    if ((e.target as HTMLElement).closest("a")) e.preventDefault();
  };

  return (
    <aside class="inspector" aria-label="Inspector">
      <header class="inspector-head">
        <span class="inspector-title" title={target()?.path}>{target()?.name ?? "Nothing selected"}</span>
        <button class="icon-btn" aria-label="Close inspector" title="Close (Ctrl+I)" onClick={settings.toggleInspector}>
          <IconClose size={13} />
        </button>
      </header>
      <Show when={target()}>
        {(t) => (
          <div class="inspector-meta">
            <span>{t().size !== undefined ? formatSize(t().size!) : t().dir ? "Folder" : formatSize(preview()?.size ?? 0)}</span>
            <span>{formatDate(t().modified)}</span>
          </div>
        )}
      </Show>
      <div class="inspector-body" onClick={onLinkClick}>
        <Show when={error()}>{(e) => <p class="error-text">{e()}</p>}</Show>
        <Show when={target()?.dir && target()} keyed>
          {(t) => <ThumbImage path={t.path} />}
        </Show>
        <Show when={preview()} keyed>
          {(p) => (
            <Switch>
              <Match when={p.kind === "code" && p.lines}>{(lines) => <CodeView lines={lines()} />}</Match>
              <Match when={p.kind === "markdown" && p.html}>{(html) => <article class="md" innerHTML={html()} />}</Match>
              <Match when={(p.kind === "text" || p.kind === "code") && p.text !== null}>
                <pre class="plain">{p.text}</pre>
              </Match>
              <Match when={p.kind === "binary" && p.hex}>{(hex) => <pre class="plain hex">{hex()}</pre>}</Match>
              <Match when={(p.kind === "image" || p.kind === "svg") && blobUrl()}>{(u) => <img class="preview-img" src={u()} alt={target()?.name} />}</Match>
              <Match when={p.kind === "pdf" && blobUrl()}>{(u) => <iframe class="preview-pdf" src={u()} title="PDF preview" />}</Match>
              <Match when={p.kind === "video" && blobUrl()}>{(u) => <video class="preview-img" src={u()} controls />}</Match>
              <Match when={p.kind === "audio" && blobUrl()}>{(u) => <AudioView url={u()} data={bytes()} />}</Match>
              <Match when={p.kind === "model" && bytes()}>{(b) => <ModelView data={b()} name={target()?.name ?? ""} />}</Match>
              <Match when={p.kind === "archive"}>
                <p class="muted">Archive with {(p.entries ?? 0).toLocaleString()} items. Open it to browse inside.</p>
              </Match>
            </Switch>
          )}
        </Show>
        <Show when={preview()?.truncated}>
          <p class="muted small">Showing the start of this file.</p>
        </Show>
        <Show when={Object.keys(preview()?.tags ?? {}).length > 0}>
          <dl class="tags">
            <For each={Object.entries(preview()!.tags)}>
              {([k, v]) => (
                <>
                  <dt>{k.split(":")[1]}</dt>
                  <dd>{v}</dd>
                </>
              )}
            </For>
          </dl>
        </Show>
      </div>
    </aside>
  );
}

function CodeView(props: { lines: string[] }) {
  const shown = () => props.lines.slice(0, MAX_CODE_LINES);
  return (
    <div class="code">
      <For each={shown()}>{(html) => <div class="code-line" innerHTML={html || " "} />}</For>
      <Show when={props.lines.length > MAX_CODE_LINES}>
        <div class="muted small">{(props.lines.length - MAX_CODE_LINES).toLocaleString()} more lines not shown</div>
      </Show>
    </div>
  );
}

function ThumbImage(props: { path: string }) {
  const [url, setUrl] = createSignal<string | null>(null);
  let alive = true;
  thumbnail(props.path, 256, false).then(
    (b) => alive && setUrl(URL.createObjectURL(new Blob([b], { type: "image/png" }))),
    () => undefined,
  );
  onCleanup(() => {
    alive = false;
    const u = url();
    if (u) URL.revokeObjectURL(u);
  });
  return <Show when={url()}>{(u) => <img class="preview-thumb" src={u()} alt="" />}</Show>;
}

function AudioView(props: { url: string; data: ArrayBuffer | null }) {
  let canvas!: HTMLCanvasElement;
  onMount(async () => {
    if (!props.data) return;
    const ctx = new AudioContext();
    try {
      const audio = await ctx.decodeAudioData(props.data.slice(0));
      const samples = audio.getChannelData(0);
      const g = canvas.getContext("2d")!;
      const { width, height } = canvas;
      g.fillStyle = getComputedStyle(canvas).color;
      const step = Math.max(1, Math.floor(samples.length / width));
      for (let x = 0; x < width; x++) {
        let peak = 0;
        for (let i = x * step; i < (x + 1) * step && i < samples.length; i += Math.max(1, step >> 4)) peak = Math.max(peak, Math.abs(samples[i]));
        const h = Math.max(1, peak * height);
        g.fillRect(x, (height - h) / 2, 1, h);
      }
    } catch {
      // Formats the browser can't decode still play or show nothing.
    } finally {
      void ctx.close();
    }
  });
  return (
    <div class="audio">
      <canvas ref={canvas} class="wave" width="700" height="120" />
      <audio src={props.url} controls />
    </div>
  );
}

/** Software flat-shaded preview: drag to rotate, wheel to zoom. */
function ModelView(props: { data: ArrayBuffer; name: string }) {
  let canvas!: HTMLCanvasElement;
  const [info, setInfo] = createSignal("");
  let mesh: Mesh | null = null;
  let yaw = 0.6;
  let pitch = -0.4;
  let zoom = 1;

  function draw() {
    if (!mesh) return;
    const g = canvas.getContext("2d")!;
    const { width: W, height: H } = canvas;
    g.clearRect(0, 0, W, H);
    const { center, radius } = boundsOf(mesh);
    const scale = (Math.min(W, H) * 0.45 * zoom) / radius;
    const [cy, sy, cp, sp] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch)];
    const p = mesh.positions;
    const stride = Math.max(1, Math.ceil(mesh.triangles / MAX_DRAWN_TRIANGLES));
    const tris: { z: number; pts: number[]; shade: number }[] = [];
    for (let t = 0; t < mesh.triangles; t += stride) {
      const v: number[][] = [];
      for (let k = 0; k < 3; k++) {
        const i = t * 9 + k * 3;
        const x0 = p[i] - center[0], y0 = p[i + 1] - center[1], z0 = p[i + 2] - center[2];
        const x1 = cy * x0 + sy * z0, z1 = -sy * x0 + cy * z0;
        const y2 = cp * y0 - sp * z1, z2 = sp * y0 + cp * z1;
        v.push([x1, y2, z2]);
      }
      const a = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
      const b = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
      const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      tris.push({
        z: (v[0][2] + v[1][2] + v[2][2]) / 3,
        pts: v.flatMap(([x, y]) => [W / 2 + x * scale, H / 2 - y * scale]),
        shade: 0.3 + 0.7 * Math.abs(n[2] / len),
      });
    }
    tris.sort((m, q) => m.z - q.z);
    for (const t of tris) {
      const c = Math.round(120 * t.shade + 60);
      g.fillStyle = g.strokeStyle = `rgb(${c - 30} ${c} ${Math.min(255, c + 60)})`;
      g.beginPath();
      g.moveTo(t.pts[0], t.pts[1]);
      g.lineTo(t.pts[2], t.pts[3]);
      g.lineTo(t.pts[4], t.pts[5]);
      g.closePath();
      g.fill();
      g.stroke();
    }
  }

  onMount(() => {
    try {
      mesh = extensionOf(props.name) === "stl" ? parseStl(props.data) : parseObj(new TextDecoder().decode(props.data));
      setInfo(`${mesh.triangles.toLocaleString()} triangles`);
      draw();
    } catch (e) {
      setInfo(errorText(e));
    }
  });

  return (
    <div class="model">
      <canvas
        ref={canvas}
        width="700"
        height="500"
        onPointerDown={(e) => {
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          let [lx, ly] = [e.clientX, e.clientY];
          const move = (m: PointerEvent) => {
            yaw += (m.clientX - lx) * 0.01;
            pitch += (m.clientY - ly) * 0.01;
            [lx, ly] = [m.clientX, m.clientY];
            draw();
          };
          const up = () => {
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", up);
          };
          el.addEventListener("pointermove", move);
          el.addEventListener("pointerup", up);
        }}
        onWheel={(e) => {
          e.preventDefault();
          zoom = Math.min(8, Math.max(0.2, zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
          draw();
        }}
      />
      <p class="muted small">{info()} · drag to rotate, scroll to zoom</p>
    </div>
  );
}
