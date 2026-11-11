// One shared tooltip bubble for the whole app, adapted from the CafeTako editor (transitions.dev tooltip).
// Native `title` attributes are hidden only while the bubble is open, then restored. Moving between
// neighbouring triggers tweens the single bubble instead of popping a second one; CSS owns every tween.
import { onCleanup, onMount } from "solid-js";
import { settings } from "../state/settings";

const SELECTOR = "[data-tooltip],[title]:not(iframe)";
const GAP = 8;
const MARGIN = 8;
const LEAVE_DELAY = 150;
const ID = "octo-tooltip";

/** Checks whether a tooltip gated by `data-tooltip-truncated` actually overflows. */
export function isTooltipTruncated(
  target: Pick<Element, "getAttribute" | "querySelectorAll"> &
    Partial<Pick<HTMLElement, "scrollWidth" | "clientWidth" | "scrollHeight" | "clientHeight">>,
): boolean {
  const sel = target.getAttribute("data-tooltip-truncated");
  if (sel === null || sel === "false") return true;
  const nodes =
    sel && sel !== "true"
      ? (Array.from(target.querySelectorAll(sel)) as Array<
          Partial<Pick<HTMLElement, "scrollWidth" | "clientWidth" | "scrollHeight" | "clientHeight">>
        >)
      : [target];
  return nodes.some((n) => (n.scrollWidth ?? 0) > (n.clientWidth ?? 0) + 1 || (n.scrollHeight ?? 0) > (n.clientHeight ?? 0) + 1);
}

export function TooltipLayer() {
  let tip!: HTMLSpanElement;
  let text!: HTMLSpanElement;

  onMount(() => {
    let current: Element | null = null;
    let nativeTitle: string | null = null;
    let hovered: Element | null = null;
    let focused: Element | null = null;
    let overTip = false;
    let dismissed: Element | null = null;
    let leaveTimer: number | undefined;
    const zoom = () => Math.max(0.1, settings.uiScale() / 100);

    const cancelLeave = () => window.clearTimeout(leaveTimer);
    const release = () => {
      if (!current) return;
      const rest = (current.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((v) => v && v !== ID);
      if (rest.length) current.setAttribute("aria-describedby", rest.join(" "));
      else current.removeAttribute("aria-describedby");
      if (nativeTitle !== null && !current.hasAttribute("title")) current.setAttribute("title", nativeTitle);
      current = null;
      nativeTitle = null;
    };
    const hide = () => {
      cancelLeave();
      release();
      tip.dataset.show = "false";
      tip.setAttribute("aria-hidden", "true");
    };

    const place = (target: Element) => {
      cancelLeave();
      if (!settings.tooltips()) return hide();
      const title = target === current ? nativeTitle : target.getAttribute("title");
      const label = target.getAttribute("data-tooltip") ?? title ?? "";
      if (!label || !isTooltipTruncated(target)) return hide();
      const showing = tip.dataset.show === "true";
      if (target !== current) {
        release();
        current = target;
        nativeTitle = target.getAttribute("title");
        if (target.hasAttribute("aria-label") || target.hasAttribute("aria-labelledby") || target.textContent?.trim()) {
          target.removeAttribute("title");
        }
      }
      const described = (target.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
      if (!described.includes(ID)) target.setAttribute("aria-describedby", [...described, ID].join(" "));
      text.textContent = label;

      // Measure the natural size (capped by CSS), then tween from the previous width.
      const z = zoom();
      const previousWidth = tip.style.width;
      tip.style.transition = "none";
      tip.style.width = "max-content";
      const width = tip.offsetWidth + 1;
      const height = tip.offsetHeight;
      tip.style.width = previousWidth;
      void tip.offsetWidth;
      if (showing) tip.style.transition = "";

      const r = target.getBoundingClientRect();
      const bw = width * z;
      const bh = height * z;
      const left = Math.min(Math.max(MARGIN, r.left + r.width / 2 - bw / 2), Math.max(MARGIN, innerWidth - bw - MARGIN));
      const above = r.top - bh - GAP >= MARGIN;
      const top = Math.max(MARGIN, Math.min(above ? r.top - bh - GAP : r.bottom + GAP, innerHeight - bh - MARGIN));
      tip.style.transformOrigin = above ? "50% 100%" : "50% 0";
      tip.style.width = `${width}px`;
      tip.style.setProperty("--tt-x", `${left / z}px`);
      tip.style.setProperty("--tt-y", `${top / z}px`);
      if (!showing) {
        void tip.offsetWidth; // snap the geometry while hidden so only the appear plays
        tip.style.transition = "";
      }
      tip.dataset.show = "true";
      tip.setAttribute("aria-hidden", "false");
    };

    const targetOf = (t: EventTarget | null) => {
      if (!(t instanceof Element)) return null;
      const match = t.closest(SELECTOR);
      return current?.contains(t) && (!match || match.contains(current)) ? current : match;
    };
    const update = () => {
      cancelLeave();
      if (overTip) return;
      const target = hovered ?? focused;
      if (target && target !== dismissed) {
        if (target !== current) place(target);
      } else {
        leaveTimer = window.setTimeout(hide, LEAVE_DELAY);
      }
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      overTip = e.target instanceof Node && tip.contains(e.target);
      if (!overTip) {
        hovered = targetOf(e.target);
        if (hovered !== dismissed) dismissed = null;
      }
      update();
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      overTip = e.relatedTarget instanceof Node && tip.contains(e.relatedTarget);
      if (!overTip) hovered = targetOf(e.relatedTarget);
      if (hovered !== dismissed) dismissed = null;
      update();
    };
    const onFocus = (e: FocusEvent) => {
      focused = e.target instanceof Element && e.target.matches(":focus-visible") ? targetOf(e.target) : null;
      if (focused) {
        hovered = null;
        overTip = false;
      }
      dismissed = null;
      update();
    };
    const onBlur = () => {
      focused = null;
      update();
    };
    const onGone = () => {
      dismissed = current;
      hovered = focused = null;
      overTip = false;
      hide();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onGone();

    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onLeave);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    document.addEventListener("pointerdown", onGone, true);
    document.addEventListener("scroll", onGone, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onGone);
    window.addEventListener("resize", onGone);
    onCleanup(() => {
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onLeave);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      document.removeEventListener("pointerdown", onGone, true);
      document.removeEventListener("scroll", onGone, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onGone);
      window.removeEventListener("resize", onGone);
      hide();
    });
  });

  return (
    <span ref={tip} id={ID} class="t-tt" role="tooltip" aria-hidden="true" data-show="false">
      <span ref={text} class="t-tt-text" />
    </span>
  );
}
