// Small inline SVG icon set (currentColor, 16px grid).
import { Show, type JSX } from "solid-js";
import type { FileCategory } from "../lib/format";

type P = { size?: number; class?: string };
const svg = (p: P, children: JSX.Element) => (
  <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 16 16" fill="none" class={p.class} aria-hidden="true">
    {children}
  </svg>
);
const stroke = { stroke: "currentColor", "stroke-width": 1.4, "stroke-linecap": "round", "stroke-linejoin": "round" } as const;

export const IconBack = (p: P) => svg(p, <path d="M10 3 5 8l5 5" {...stroke} />);
export const IconForward = (p: P) => svg(p, <path d="m6 3 5 5-5 5" {...stroke} />);
export const IconUp = (p: P) => svg(p, <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" {...stroke} />);
export const IconRefresh = (p: P) => svg(p, <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" {...stroke} />);
export const IconPlus = (p: P) => svg(p, <path d="M8 3v10M3 8h10" {...stroke} />);
export const IconClose = (p: P) => svg(p, <path d="m4 4 8 8M12 4l-8 8" {...stroke} />);
export const IconChevron = (p: P) => svg(p, <path d="m6 4 4 4-4 4" {...stroke} />);
export const IconSearch = (p: P) => svg(p, <><circle cx="7" cy="7" r="4" {...stroke} /><path d="m10 10 3 3" {...stroke} /></>);
export const IconLayers = (p: P) => svg(p, <path d="M8 2 2 5l6 3 6-3-6-3ZM2 8l6 3 6-3M2 11l6 3 6-3" {...stroke} />);
export const IconSplitRow = (p: P) => svg(p, <><rect x="2" y="3" width="12" height="10" rx="1.5" {...stroke} /><path d="M8 3v10" {...stroke} /></>);
export const IconSplitCol = (p: P) => svg(p, <><rect x="2" y="3" width="12" height="10" rx="1.5" {...stroke} /><path d="M2 8h12" {...stroke} /></>);
export const IconEye = (p: P) => svg(p, <><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" {...stroke} /><circle cx="8" cy="8" r="2" {...stroke} /></>);
export const IconSidebar = (p: P) => svg(p, <><rect x="2" y="3" width="12" height="10" rx="1.5" {...stroke} /><path d="M6 3v10" {...stroke} /></>);
export const IconHome = (p: P) => svg(p, <path d="M2.5 7.5 8 3l5.5 4.5V13H10v-3H6v3H2.5Z" {...stroke} />);
export const IconStar = (p: P) => svg(p, <path d="m8 2.5 1.7 3.4 3.8.5-2.8 2.6.7 3.7L8 10.9l-3.4 1.8.7-3.7L2.5 6.4l3.8-.5Z" {...stroke} />);

export function IconDrive(p: P & { kind?: string }) {
  return svg(
    p,
    <>
      <rect x="2" y="5" width="12" height="7" rx="1.5" {...stroke} />
      <circle cx="11.5" cy="8.5" r="0.6" fill="currentColor" />
      {p.kind === "network" && <path d="M8 12v2M5 14h6" {...stroke} />}
      {p.kind === "removable" && <path d="M5 5V3h6v2" {...stroke} />}
    </>,
  );
}

/**
 * Folder or file glyph tinted by category. Everything reads props inside JSX
 * so the glyph updates when a recycled list row shows a different item.
 */
export function FileGlyph(p: { category: FileCategory; link?: boolean }) {
  return (
    <svg class={`glyph glyph-${p.category}`} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <Show
        when={p.category === "folder"}
        fallback={
          <>
            <path d="M4 1.5h5.2L12.5 4.8V13A1.5 1.5 0 0 1 11 14.5H4A1.5 1.5 0 0 1 2.5 13V3A1.5 1.5 0 0 1 4 1.5Z" fill="currentColor" opacity="0.9" />
            <path d="M9 1.5V5h3.5" fill="none" stroke="var(--bg)" stroke-width="1" opacity="0.5" />
          </>
        }
      >
        <path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3.2l1.5 1.5H13A1.5 1.5 0 0 1 14.5 6v5.5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5Z" fill="currentColor" />
        <Show when={p.link}>
          <path d="M5 10.5h3.5M7.2 9l1.5 1.5L7.2 12" stroke="var(--bg)" stroke-width="1.2" fill="none" />
        </Show>
      </Show>
    </svg>
  );
}
