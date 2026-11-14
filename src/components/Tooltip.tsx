// One shared tooltip bubble for the whole app, adapted from the CafeTako editor (transitions.dev tooltip).
// Native `title` attributes are hidden only while the bubble is open, then restored. Moving between
// neighbouring triggers tweens the single bubble instead of popping a second one; CSS owns every tween.
import { onCleanup, onMount } from "solid-js";
import { parseTooltip } from "../lib/tooltip";
import { settings } from "../state/settings";

const SELECTOR = "[data-tooltip],[data-octo-title],[title]:not(iframe)";
const TITLE_ATTR = "data-octo-title";
const TITLE_ARIA_ATTR = "data-octo-title-aria";

function stripNativeTitle(el: Element) {
  if (el.tagName === "IFRAME" || !el.hasAttribute("title")) return;
  const title = el.getAttribute("title");
  el.removeAttribute("title");
  if (title) {
    el.setAttribute(TITLE_ATTR, title);
    const hasName = el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") || Boolean(el.textContent?.trim());
    if (!hasName || el.hasAttribute(TITLE_ARIA_ATTR)) {
      el.setAttribute("aria-label", title);
      el.setAttribute(TITLE_ARIA_ATTR, "");
    }
  } else {
    el.removeAttribute(TITLE_ATTR);
    if (el.hasAttribute(TITLE_ARIA_ATTR)) {
      el.removeAttribute("aria-label");
      el.removeAttribute(TITLE_ARIA_ATTR);
    }
  }
}
const GAP = 8;
const MARGIN = 8;
const LEAVE_DELAY = 150;
const ID = "octo-tooltip";

function renderTooltipContent(el: HTMLSpanElement, tipEl: HTMLSpanElement, label: string) {
  const parsed = parseTooltip(label);
  tipEl.dataset.mode = parsed.mode;
  if (parsed.mode === "plain") {
    el.textContent = label;
    return;
  }
  el.textContent = "";
  if (parsed.mode === "hints" && parsed.hints) {
    const grid = document.createElement("span");
    grid.className = "t-tt-hints";
    for (const h of parsed.hints) {
      const item = document.createElement("span");
      item.className = "t-tt-hint";
      const kbd = document.createElement("kbd");
      kbd.className = "t-tt-kbd";
      kbd.textContent = h.keys;
      const lbl = document.createElement("span");
      lbl.className = "t-tt-hint-label";
      lbl.textContent = h.label;
      item.append(kbd, lbl);
      grid.append(item);
    }
    el.append(grid);
    return;
  }
  if (parsed.parts) {
    for (const part of parsed.parts) {
      if (part.kind === "kbd") {
        const kbd = document.createElement("kbd");
        kbd.className = "t-tt-kbd";
        kbd.textContent = part.value;
        el.append(kbd);
      } else {
        el.append(document.createTextNode(part.value));
      }
    }
  }
}

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
    let hovered: Element | null = null;
    let focused: Element | null = null;
    let overTip = false;
    let dismissed: Element | null = null;
    let pending: Element | null = null;
    let showTimer: number | undefined;
    let leaveTimer: number | undefined;
    const zoom = () => Math.max(0.1, settings.uiScale() / 100);

    document.querySelectorAll("[title]:not(iframe)").forEach(stripNativeTitle);
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes") {
          if (m.target instanceof Element && m.target.hasAttribute("title")) stripNativeTitle(m.target);
        } else {
          for (const node of m.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.hasAttribute("title")) stripNativeTitle(node);
            node.querySelectorAll("[title]:not(iframe)").forEach(stripNativeTitle);
          }
        }
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["title"],
    });

    const cancelLeave = () => window.clearTimeout(leaveTimer);
    const cancelShow = () => {
      window.clearTimeout(showTimer);
      pending = null;
    };
    const release = () => {
      if (!current) return;
      const rest = (current.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((v) => v && v !== ID);
      if (rest.length) current.setAttribute("aria-describedby", rest.join(" "));
      else current.removeAttribute("aria-describedby");
      current = null;
    };
    const hide = () => {
      cancelShow();
      cancelLeave();
      release();
      tip.dataset.show = "false";
      tip.setAttribute("aria-hidden", "true");
    };

    const place = (target: Element) => {
      cancelLeave();
      if (!settings.tooltips()) return hide();
      if (target.hasAttribute("title")) stripNativeTitle(target);
      const label = target.getAttribute("data-tooltip") ?? target.getAttribute(TITLE_ATTR) ?? "";
      if (!label || !isTooltipTruncated(target)) return hide();
      if (target !== current) {
        release();
        current = target;
      }
      const described = (target.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
      if (!described.includes(ID)) target.setAttribute("aria-describedby", [...described, ID].join(" "));
      renderTooltipContent(text, tip, label);

      // Measure the natural size (capped by CSS) and snap position before showing.
      const z = zoom();
      tip.style.transition = "none";
      tip.style.width = "max-content";
      const width = tip.offsetWidth + 1;
      const height = tip.offsetHeight;

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
      void tip.offsetWidth;
      tip.style.transition = "";
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
        if (target === current) return cancelShow();
        const delay = settings.tooltipDelayMs();
        if (tip.dataset.show === "true" || delay <= 0) {
          cancelShow();
          place(target);
        } else if (pending !== target) {
          cancelShow();
          pending = target;
          showTimer = window.setTimeout(() => {
            pending = null;
            if ((hovered ?? focused) === target && target !== dismissed) place(target);
          }, delay);
        }
      } else {
        cancelShow();
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

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onLeave, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    document.addEventListener("pointerdown", onGone, true);
    document.addEventListener("scroll", onGone, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onGone);
    window.addEventListener("resize", onGone);
    onCleanup(() => {
      observer.disconnect();
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onLeave, true);
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
