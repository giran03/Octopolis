// Octopolis guide runtime. Plain JavaScript, no libraries. The motion patterns (shared-observer reveal, sliding
// tab indicator, copy pop, key-cap press, spotlight, scroll progress) are our own originals.
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = document.documentElement;
  root.classList.add("js");
  const DATA = JSON.parse($("#guide-data").textContent);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage can be blocked */ } },
  };
  const session = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const osReduce = matchMedia("(prefers-reduced-motion: reduce)");
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };

  // ---------- motion preference: the app's setting wins, then the system's ----------
  let payload = window.__OCTOPOLIS__ || null;
  const reduced = () => root.dataset.motion === "reduce";
  function applyMotion() {
    const pref = payload && payload.motion;
    root.dataset.motion = pref === "reduce" ? "reduce" : pref === "full" ? "full" : osReduce.matches ? "reduce" : "full";
  }
  osReduce.addEventListener("change", applyMotion);

  // ---------- theme: follows the app (guide-theme.js), or a theme picked here ----------
  const VAR_OK = /^--(bg|surface|surface-2|surface-3|border|border-strong|text|text-muted|text-faint|accent|accent-soft|accent-strong|danger|ok|g-folder)$/;
  const VAL_OK = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\)|color-mix\(in srgb, [^;{}]{1,80}\))$/i;
  const FONT_OK = /^[\w \-,."']{1,200}$/;
  let setVars = [];
  function varsFromTokens(t) {
    const v = { "--accent-soft": `color-mix(in srgb, ${t.accent} 18%, transparent)`, "--accent-strong": `color-mix(in srgb, ${t.accent} 30%, transparent)` };
    for (const [k, val] of Object.entries(t)) v["--" + k] = val;
    return v;
  }
  function paint(scheme, vars) {
    for (const k of setVars) root.style.removeProperty(k);
    setVars = [];
    if (!vars) {
      delete root.dataset.theme;
      root.style.removeProperty("color-scheme");
      return;
    }
    root.dataset.theme = scheme === "light" ? "light" : "dark";
    root.style.colorScheme = root.dataset.theme;
    for (const [k, v] of Object.entries(vars)) {
      if (!VAR_OK.test(k) || typeof v !== "string" || !VAL_OK.test(v.trim())) continue;
      root.style.setProperty(k, v.trim());
      setVars.push(k);
    }
  }
  // The app's muted and faint text and its accent are made for chrome, not for reading paragraphs: in a few themes they
  // fall under 4.5:1. The guide nudges them toward the text color just enough, so it stays readable in every theme.
  function parseColor(c) {
    c = (c || "").trim();
    let m = /^#([0-9a-f]{3,8})$/i.exec(c);
    if (m) {
      let hx = m[1];
      if (hx.length < 6) hx = hx.split("").map((x) => x + x).join("");
      return [0, 2, 4].map((i) => parseInt(hx.slice(i, i + 2), 16));
    }
    m = /^rgba?\(([^)]+)\)/i.exec(c);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map((x) => (x.endsWith("%") ? parseFloat(x) * 2.55 : parseFloat(x)));
      return p.length === 3 && p.every(Number.isFinite) ? p : null;
    }
    m = /^hsla?\(([^)]+)\)/i.exec(c);
    if (m) {
      const [hh, ss, ll] = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
      if (![hh, ss, ll].every(Number.isFinite)) return null;
      const s1 = ss / 100, l1 = ll / 100, a = s1 * Math.min(l1, 1 - l1);
      const k = (n) => (n + hh / 30) % 12;
      return [0, 8, 4].map((n) => Math.round(255 * (l1 - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))));
    }
    return null;
  }
  const lum = (rgb) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const mixRgb = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const toHex = (rgb) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
  function readable(fg, backs, toward) {
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const c = mixRgb(fg, toward, t);
      if (backs.every((b) => ratio(c, b) >= 4.5)) return c;
    }
    return toward;
  }
  function adjustReadable() {
    const cs = getComputedStyle(root);
    const get = (n) => parseColor(cs.getPropertyValue(n));
    const text = get("--text");
    const backs = ["--bg", "--surface", "--surface-2"].map(get);
    if (!text || backs.some((b) => !b)) return;
    for (const [from, to] of [["--text-muted", "--text-muted"], ["--text-faint", "--text-faint"], ["--accent", "--link"]]) {
      const fg = get(from);
      if (!fg) continue;
      root.style.setProperty(to, toHex(readable(fg, backs, text)));
      if (!setVars.includes(to)) setVars.push(to);
    }
  }
  const choiceKey = "octopolis.guide.theme";
  const customThemes = () => (payload && Array.isArray(payload.themes) ? payload.themes : []);
  const findTheme = (name) => DATA.themes.find((t) => t.name === name) || customThemes().find((t) => t && t.name === name);
  const syncChip = $("#sync");
  const picker = $("#theme-pick");

  function applyTheme() {
    applyMotion();
    const choice = store.get(choiceKey) || "app";
    const font = payload && payload.font;
    if (font && FONT_OK.test(font)) root.style.setProperty("--font", font);
    else root.style.removeProperty("--font");
    if (choice === "app" || !findTheme(choice)) {
      if (payload && payload.vars) paint(payload.scheme, payload.vars);
      else paint(null, null);
      syncChip.classList.toggle("off", !payload);
      $("span", syncChip).textContent = payload ? `Synced with Octopolis · ${payload.name}` : "Not connected to the app";
    } else {
      const t = findTheme(choice);
      paint(t.scheme, varsFromTokens(t.tokens));
      syncChip.classList.add("off");
      $("span", syncChip).textContent = `Theme: ${t.name}`;
    }
    adjustReadable();
    $$(".theme").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.name === choice)));
    if (picker) picker.value = findTheme(choice) || choice === "app" ? choice : "app";
  }
  function buildPicker() {
    picker.replaceChildren(h("option", { value: "app", text: "Match Octopolis" }));
    const groups = new Map();
    for (const t of DATA.themes) {
      const g = (DATA.families.find((f) => f.id === t.family) || { title: "Built-in" }).title;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    for (const [title, list] of groups) picker.append(h("optgroup", { label: title }, list.map((t) => h("option", { value: t.name, text: t.name }))));
    const mine = customThemes().filter((t) => t && typeof t.name === "string" && t.tokens);
    if (mine.length) picker.append(h("optgroup", { label: "Your themes" }, mine.map((t) => h("option", { value: t.name, text: t.name }))));
    picker.addEventListener("change", () => {
      store.set(choiceKey, picker.value);
      applyTheme();
    });
  }
  // Picks up the app's latest theme: the app rewrites guide-theme.js when it changes; reload it when this tab regains focus.
  let lastPull = 0;
  function pull() {
    const now = Date.now();
    if (now - lastPull < 800) return;
    lastPull = now;
    const s = document.createElement("script");
    s.src = "guide-theme.js?t=" + now;
    s.onload = () => {
      s.remove();
      if (window.__OCTOPOLIS__) {
        payload = window.__OCTOPOLIS__;
        buildPicker();
        applyTheme();
      }
    };
    s.onerror = () => s.remove();
    document.head.append(s);
  }
  addEventListener("focus", pull);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && pull());

  // ---------- helpers: copy, key caps, segmented tabs ----------
  async function copyText(text, el) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = h("textarea", { style: "position:fixed;opacity:0" });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* nothing more to try */ }
      ta.remove();
    }
    if (el) {
      el.classList.remove("pop");
      void el.offsetWidth;
      el.classList.add("pop");
    }
  }
  const KEY_NAMES = { arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", escape: "Esc", delete: "Del", backspace: "Backspace", enter: "Enter", browserback: "Browser back", browserforward: "Browser forward", pageup: "PgUp", pagedown: "PgDn", " ": "Space", space: "Space" };
  const keyName = (k) => KEY_NAMES[k] || (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1));
  // `vim`: letters are case-sensitive there, so a lone letter is shown as typed (Shift+G is G).
  function keycaps(combo, vim) {
    const steps = combo.split(" ").map((step) => {
      const parts = step.split("+").filter(Boolean);
      const out = h("span", { class: "keys" });
      parts.forEach((p, i) => {
        if (i) out.append(h("span", { class: "plus", text: "+" }));
        out.append(h("kbd", { text: vim && p.length === 1 && /[a-z]/.test(p) ? (parts[i - 1] === "shift" ? p.toUpperCase() : p) : keyName(p) }));
      });
      return out;
    });
    const wrap = h("span", { class: "keys" });
    steps.forEach((s, i) => {
      if (i) wrap.append(h("span", { class: "plus", text: "then" }));
      wrap.append(s);
    });
    return wrap;
  }
  // Writes `Ctrl+Shift+P` style text from `<kbd-keys>` placeholders in the content.
  $$("[data-keys]").forEach((el) => el.replaceChildren(keycaps(el.dataset.keys)));

  function seg(container, items, onChange, current) {
    container.classList.add("seg");
    container.setAttribute("role", "tablist");
    const ind = h("span", { class: "ind", "aria-hidden": "true" });
    container.replaceChildren(ind);
    const buttons = items.map((it) => {
      const b = h("button", { type: "button", role: "tab", "aria-selected": "false", "data-id": it.id, text: it.label });
      b.addEventListener("click", () => select(it.id, true));
      container.append(b);
      return b;
    });
    const place = () => {
      const on = buttons.find((b) => b.getAttribute("aria-selected") === "true");
      if (!on) return;
      ind.style.width = on.offsetWidth + "px";
      ind.style.transform = `translateX(${on.offsetLeft - 3}px)`;
      ind.style.left = "3px";
    };
    function select(id, fire) {
      buttons.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.id === id)));
      place();
      if (fire) onChange(id);
    }
    container.addEventListener("keydown", (e) => {
      const i = buttons.findIndex((b) => b.getAttribute("aria-selected") === "true");
      const n = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : null;
      if (n === null) return;
      e.preventDefault();
      const b = buttons[(n + buttons.length) % buttons.length];
      b.focus();
      select(b.dataset.id, true);
    });
    new ResizeObserver(place).observe(container);
    select(current || items[0].id, false);
    return { select: (id) => select(id, false), place };
  }

  // ---------- code blocks and copy chips ----------
  $$("pre").forEach((pre) => {
    const b = h("button", { class: "copy", type: "button", text: "Copy", "aria-label": "Copy to the clipboard" });
    b.addEventListener("click", () => {
      copyText(pre.textContent.replace(/\s+$/, ""), b);
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = "Copy"), 1400);
    });
    pre.append(b);
  });
  $$("code[data-copy]").forEach((c) => {
    c.title = "Click to copy";
    c.addEventListener("click", () => copyText(c.dataset.copy || c.textContent, c));
  });

  // ---------- reveal on scroll: one shared observer, content stays visible without it ----------
  const revealTargets = [];
  $$("main .sec").forEach((sec) => {
    [...sec.children].forEach((el, i) => {
      el.dataset.reveal = "";
      el.style.setProperty("--i", String(Math.min(i, 4)));
      revealTargets.push(el);
    });
    $$(".cards, .stats, .themes", sec).forEach((grid) => [...grid.children].forEach((c, i) => {
      c.dataset.reveal = "";
      c.style.setProperty("--i", String(Math.min(i, 9)));
      revealTargets.push(c);
    }));
  });
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-in");
        io.unobserve(e.target);
        if (e.target.querySelector("[data-count]")) countUp(e.target);
      }
    }, { threshold: 0.08, rootMargin: "0px 0px -8% 0px" });
    revealTargets.forEach((t) => io.observe(t));
  } else {
    revealTargets.forEach((t) => { t.classList.add("is-in"); countUp(t); });
  }

  // ---------- count-up (our own rAF, ease-out-expo) ----------
  function countUp(host) {
    $$("[data-count]", host).forEach((el) => {
      const to = Number(el.dataset.count);
      const suffix = el.dataset.suffix || "";
      if (reduced() || !Number.isFinite(to)) {
        el.textContent = to.toLocaleString("en-US") + suffix;
        return;
      }
      const t0 = performance.now();
      const dur = 1100;
      const step = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        const e = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
        el.textContent = Math.round(to * e).toLocaleString("en-US") + suffix;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }
  $$("[data-from]").forEach((el) => {
    const src = el.dataset.from;
    el.dataset.count = String(src === "commands" ? DATA.commands.length : src === "themes" ? DATA.themes.length : src === "modes" ? DATA.modes.length : 0);
  });

  // ---------- spotlight on cards ----------
  document.addEventListener("pointermove", (e) => {
    const card = e.target.closest && e.target.closest(".card");
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty("--mx", e.clientX - r.left + "px");
    card.style.setProperty("--my", e.clientY - r.top + "px");
  }, { passive: true });

  // ---------- navigation: scrollspy with a sliding highlight ----------
  const navLinks = $$(".nav-list a");
  const pill = $(".nav-pill");
  const sections = navLinks.map((a) => $(a.getAttribute("href"))).filter(Boolean);
  let activeId = "";
  function placePill(a) {
    if (!a) return;
    pill.style.opacity = "1";
    pill.style.height = a.offsetHeight + "px";
    pill.style.transform = `translateY(${a.offsetTop}px)`;
    const nav = $("#nav");
    const top = a.offsetTop, bottom = top + a.offsetHeight;
    if (top < nav.scrollTop + 20) nav.scrollTo({ top: Math.max(0, top - 60), behavior: reduced() ? "auto" : "smooth" });
    else if (bottom > nav.scrollTop + nav.clientHeight - 20) nav.scrollTo({ top: bottom - nav.clientHeight + 60, behavior: reduced() ? "auto" : "smooth" });
  }
  let ticking = false;
  function spy() {
    ticking = false;
    const y = 90;
    let cur = sections[0];
    for (const s of sections) if (s.getBoundingClientRect().top <= y) cur = s;
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) cur = sections[sections.length - 1];
    if (cur && cur.id !== activeId) {
      activeId = cur.id;
      navLinks.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + activeId));
      placePill(navLinks.find((a) => a.getAttribute("href") === "#" + activeId));
    }
    $("#totop").classList.toggle("show", scrollY > 700);
    if (!CSS.supports("animation-timeline: scroll()")) {
      const max = document.documentElement.scrollHeight - innerHeight;
      $(".progress").style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
    }
  }
  addEventListener("scroll", () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(spy);
    }
  }, { passive: true });
  addEventListener("resize", () => placePill(navLinks.find((a) => a.classList.contains("on"))));
  $("#totop").addEventListener("click", () => scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" }));
  $("#menu").addEventListener("click", () => document.body.toggleAttribute("data-nav"));
  navLinks.forEach((a) => a.addEventListener("click", () => document.body.removeAttribute("data-nav")));

  // Heading links
  $$("main h2[id], main h3[id]").forEach((hd) => {
    const a = h("a", { class: "hash", href: "#" + hd.id, "aria-label": "Link to this heading", text: "#" });
    hd.append(a);
  });

  // ---------- keyboard reference (generated from the app's own command list) ----------
  function buildShortcuts() {
    const host = $("#shortcut-table");
    if (!host) return;
    const cats = ["All", ...new Set(DATA.commands.map((c) => c.category))];
    let cat = "All";
    let q = "";
    let onlyKeys = true;
    const tabs = h("div");
    const input = h("input", { class: "field", type: "search", placeholder: "Filter commands or keys…", "aria-label": "Filter shortcuts" });
    const only = h("label", { class: "small muted" }, h("input", { type: "checkbox", checked: true }), " Only commands with a shortcut");
    const body = h("tbody");
    const count = h("p", { class: "muted small" });
    host.append(h("div", { class: "toolbar" }, tabs), h("div", { class: "toolbar" }, input, only), count,
      h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, h("th", { text: "Command" }), h("th", { text: "Shortcut" }), h("th", { text: "Vim layer" }))), body)));
    const render = () => {
      const needle = q.toLowerCase();
      const rows = DATA.commands.filter((c) => {
        if (cat !== "All" && c.category !== cat) return false;
        if (onlyKeys && !c.keys.length && !c.vimKeys.length) return false;
        if (!needle) return true;
        return (c.title + " " + c.category + " " + c.keys.join(" ") + " " + c.vimKeys.join(" ")).toLowerCase().includes(needle);
      });
      body.replaceChildren(...rows.map((c) => h("tr", { id: "cmd-" + c.id.replace(/[^\w]+/g, "-") },
        h("td", null, h("b", { text: c.title }), " ", h("span", { class: "muted small", text: c.category })),
        h("td", { class: "k" }, c.keys.length ? c.keys.map((k, i) => h("span", null, i ? h("span", { class: "muted small", text: "  or  " }) : null, keycaps(k))) : h("span", { class: "muted", text: "—" })),
        h("td", { class: "k" }, c.vimKeys.length ? c.vimKeys.map((k, i) => h("span", null, i ? " " : null, keycaps(k, true))) : h("span", { class: "muted", text: "—" })))));
      count.textContent = `${rows.length} of ${DATA.commands.length} commands. Rebind any of them in Settings › Shortcuts.`;
    };
    seg(tabs, cats.map((c) => ({ id: c, label: c })), (id) => { cat = id; render(); });
    input.addEventListener("input", () => { q = input.value.trim(); render(); });
    $("input", only).addEventListener("change", (e) => { onlyKeys = e.target.checked; render(); });
    host.filterFor = (text) => { input.value = text; q = text; onlyKeys = false; $("input", only).checked = false; render(); };
    render();
  }

  // ---------- themes gallery ----------
  function buildThemes() {
    const host = $("#theme-gallery");
    if (!host) return;
    const miniVars = (t) => `--t-bg:${t.tokens.bg};--t-surface:${t.tokens.surface};--t-border:${t.tokens.border};--t-text:${t.tokens.text};--t-text-faint:${t.tokens["text-faint"]};--t-accent:${t.tokens.accent};--t-folder:${t.tokens["g-folder"]}`;
    for (const fam of DATA.families) {
      const list = DATA.themes.filter((t) => t.family === fam.id);
      if (!list.length) continue;
      host.append(h("div", { class: "fam", text: fam.title + " · " + fam.hint }));
      host.append(h("div", { class: "themes" }, list.map((t) => {
        const b = h("button", { type: "button", class: "theme", "data-name": t.name, "aria-pressed": "false", style: miniVars(t), title: `Preview ${t.name} in this guide` },
          h("div", { class: "mini" }, h("div", { class: "sb" }, h("i", { class: "on" }), h("i"), h("i"), h("i")), h("div", { class: "mn" }, h("i", { class: "f" }), h("i", { class: "t" }), h("i", { class: "t" }), h("i", { class: "t" }))),
          h("div", { class: "lbl" }, h("b", { text: t.name }), h("small", { text: t.scheme })));
        b.addEventListener("click", () => { store.set(choiceKey, t.name); applyTheme(); });
        return b;
      })));
    }
  }

  // ---------- changelog (generated from CHANGELOG.md) ----------
  function buildChangelog() {
    const host = $("#changelog-list");
    if (!host) return;
    const types = ["All", ...new Set(DATA.changelog.flatMap((r) => r.sections.map((s) => s.type)))];
    let type = "All";
    let q = "";
    const tabs = h("div");
    const input = h("input", { class: "field", type: "search", placeholder: "Search the changelog…", "aria-label": "Search the changelog" });
    const list = h("div");
    host.append(h("div", { class: "toolbar" }, tabs, input), list);
    const render = () => {
      const needle = q.toLowerCase();
      list.replaceChildren(...DATA.changelog.map((rel, ri) => {
        const entries = rel.sections.flatMap((s) => s.entries.map((e) => ({ ...e, type: s.type })))
          .filter((e) => (type === "All" || e.type === type) && (!needle || (e.title + " " + e.body).toLowerCase().includes(needle)));
        if (!entries.length) return null;
        const d = h("details", { class: "rel", id: "v" + rel.version.replace(/[^\w.]+/g, "-") }, h("summary", null,
          h("span", { text: "Version " + rel.version }), rel.version === DATA.version ? h("span", { class: "badge", text: "This build" }) : null,
          h("span", { class: "muted small", text: rel.date }), h("span", { class: "count", text: entries.length + (entries.length === 1 ? " change" : " changes") })),
          h("ul", { class: "entries" }, entries.map((e) => h("li", { class: "entry " + e.type.toLowerCase() },
            h("b", null, h("span", { class: "type", text: e.type }), e.title), e.body ? h("p", { text: e.body }) : null))));
        if (ri === 0 || needle) d.open = true;
        return d;
      }).filter(Boolean));
      if (!list.children.length) list.append(h("p", { class: "muted", text: "Nothing matches." }));
    };
    seg(tabs, types.map((t) => ({ id: t, label: t })), (id) => { type = id; render(); });
    input.addEventListener("input", () => { q = input.value.trim(); render(); });
    render();
  }

  // ---------- demo: the command palette typing through its modes ----------
  function buildPaletteDemo() {
    const host = $("#demo-palette");
    if (!host) return;
    const scenes = [
      { id: "go", label: "Go to", chip: "Go to", plain: true, text: "doc", rows: [["C:\\Users\\you\\Documents", "3 h ago"], ["C:\\Work\\docs", "2 d ago"], ["Documents.zip", "In this folder"]] },
      { id: "calc", label: "Calculator", chip: "Go to", plain: true, text: "5 mb in kb", rows: [["= 5,120 KB", "Enter copies"], ["Search subfolders for \"5 mb in kb\"", ""]] },
      { id: "cmd", label: "Commands", chip: "Commands", text: ">refr", rows: [["Navigate: Refresh", "F5  Ctrl+R"], ["View: Show or hide files Git ignores", ""], ["Search: Filter this folder", "Ctrl+F"]] },
      { id: "tab", label: "Tabs", chip: "Tabs", text: "@photos", rows: [["D:\\Pictures\\Photos", "Pane 2 · current"], ["D:\\Backup\\Photos 2024", "Pane 1"]] },
      { id: "pin", label: "Pinned", chip: "Pinned", text: "#work", rows: [["C:\\Work", "Work"], ["C:\\Work\\Clients", "Clients"]] },
      { id: "sh", label: "Shell", chip: "Shell", text: "!git status", rows: [["cmd: git status", "C:\\Projects\\app"], ["PowerShell: git status", "C:\\Projects\\app"]] },
      { id: "path", label: "Path", chip: "Path", text: "C:\\Us", rows: [["Open C:\\Us", ""], ["C:\\Users\\you", "3 min ago"], ["C:\\Users\\Public", ""]] },
    ];
    const tabs = h("div");
    const typed = h("span");
    const chip = h("span", { class: "chip plain" });
    const list = h("div", { class: "pal-list" });
    host.append(tabs, h("div", { style: "height:14px" }), h("div", { class: "pal", "aria-live": "off" }, h("div", { class: "pal-in" }, chip, h("span", null, typed, h("span", { class: "caret" }))), list,
      h("div", { class: "pal-foot" }, h("span", null, h("kbd", { text: "Enter" }), " Open"), h("span", null, h("kbd", { text: "Tab" }), " Complete"), h("span", null, h("kbd", { text: "Ctrl+D" }), " Pin"))));
    let timer = 0, run = 0, auto = true, idx = 0, visible = false;
    const ctl = seg(tabs, scenes.map((s) => ({ id: s.id, label: s.label })), (id) => { auto = false; play(scenes.findIndex((s) => s.id === id)); });
    function show(s) {
      chip.textContent = s.chip;
      chip.classList.toggle("plain", !!s.plain);
      list.replaceChildren(...s.rows.map((r, i) => h("div", { class: "pal-row" + (i === 0 ? " hot" : ""), style: `--i:${i}` }, h("span", { text: r[0] }), h("small", { text: r[1] }))));
    }
    function play(i) {
      idx = i;
      const s = scenes[i];
      const my = ++run;
      clearTimeout(timer);
      ctl.select(s.id);
      typed.textContent = "";
      list.replaceChildren();
      if (reduced()) { typed.textContent = s.text; show(s); return; }
      let n = 0;
      const tick = () => {
        if (my !== run) return;
        typed.textContent = s.text.slice(0, ++n);
        if (n < s.text.length) timer = setTimeout(tick, 70);
        else { show(s); if (auto && visible) timer = setTimeout(() => play((idx + 1) % scenes.length), 3200); }
      };
      timer = setTimeout(tick, 250);
    }
    new IntersectionObserver((es) => {
      visible = es[0].isIntersecting;
      if (visible && auto) play(idx);
      if (!visible) { run++; clearTimeout(timer); }
    }, { threshold: 0.3 }).observe(host);
    play(0);
  }

  // ---------- demo: one folder, many views (positions glide between layouts) ----------
  function buildViewsDemo() {
    const host = $("#demo-views");
    if (!host) return;
    const items = [
      ["Beach.jpg", 1.5, "--g-image"], ["Notes.txt", 0.8, "--g-doc"], ["Trip.mp4", 1.78, "--g-video"], ["Song.mp3", 1, "--g-audio"], ["Portrait.png", 0.7, "--g-image"],
      ["Budget.xlsx", 1.2, "--g-doc"], ["Sunset.jpg", 1.6, "--g-image"], ["main.rs", 1, "--g-code"], ["Cat.jpg", 1.1, "--g-image"], ["Clip.mov", 1.78, "--g-video"],
      ["Wide.png", 2.1, "--g-image"], ["Plan.md", 0.9, "--g-doc"],
    ];
    const grid = h("div", { class: "vgrid", "data-mode": "bento" }, items.map(([name, ar, tint], i) => h("div", { class: "vi", style: `--ar:${ar};--tint:var(${tint})` },
      h("span", { class: "th" }), h("span", { class: "nm", text: name }), h("span", { class: "meta", text: `${(i + 2) * 37} KB` }))));
    const tabs = h("div");
    host.append(tabs, h("div", { style: "height:14px" }), h("div", { class: "win" }, h("div", { class: "win-bar" }, h("i"), h("i"), h("i"), h("span", { text: "  C:\\Users\\you\\Pictures" })), grid));
    const modes = [["bento", "Bento"], ["icons", "Icons"], ["tiles", "Tiles"], ["details", "Details"], ["list", "List"]];
    seg(tabs, modes.map(([id, label]) => ({ id, label })), (id) => {
      const els = [...grid.children];
      const before = els.map((e) => e.getBoundingClientRect());
      grid.dataset.mode = id;
      if (reduced() || !els[0].animate) return;
      els.forEach((e, i) => {
        const a = before[i], b = e.getBoundingClientRect();
        const dx = a.left - b.left, dy = a.top - b.top;
        if (!dx && !dy) return;
        e.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 520, easing: "cubic-bezier(.22,1,.36,1)" });
      });
    }, "bento");
  }

  // ---------- search over the whole guide ----------
  function buildSearch() {
    const dlg = $("#search-dialog");
    const input = $("input", dlg);
    const out = $(".results", dlg);
    const index = [];
    $$("main .sec").forEach((sec) => {
      const title = sec.dataset.title || sec.id;
      index.push({ title, kind: "Section", text: sec.textContent.replace(/\s+/g, " "), go: () => jump("#" + sec.id) });
      $$("h3[id]", sec).forEach((h3) => {
        const parts = [];
        for (let n = h3.nextElementSibling; n && !/^H[23]$/.test(n.tagName); n = n.nextElementSibling) parts.push(n.textContent);
        index.push({ title: h3.textContent.replace(/#$/, "").trim(), kind: title, text: parts.join(" ").replace(/\s+/g, " "), go: () => jump("#" + h3.id) });
      });
    });
    DATA.commands.forEach((c) => index.push({
      title: c.title, kind: "Shortcut · " + c.category, text: c.keys.concat(c.vimKeys).join(" "),
      go: () => { const t = $("#shortcut-table"); t && t.filterFor && t.filterFor(c.title); jump("#shortcuts"); },
    }));
    DATA.changelog.forEach((r) => r.sections.forEach((s) => s.entries.forEach((e) => index.push({
      title: e.title, kind: "Changelog · " + r.version, text: e.body, go: () => jump("#changelog"),
    }))));
    let hits = [], hot = 0;
    const jump = (hash) => {
      close();
      const el = $(hash);
      if (el) el.scrollIntoView({ behavior: reduced() ? "auto" : "smooth" });
      history.replaceState(null, "", hash);
    };
    const open = () => { dlg.setAttribute("data-open", ""); input.value = ""; render(); input.focus(); };
    const close = () => dlg.removeAttribute("data-open");
    function snippet(text, words) {
      const low = text.toLowerCase();
      const at = words.map((w) => low.indexOf(w)).filter((n) => n >= 0).sort((a, b) => a - b)[0];
      if (at === undefined) return text.slice(0, 110);
      const from = Math.max(0, at - 40);
      return (from ? "…" : "") + text.slice(from, from + 130) + "…";
    }
    function render() {
      const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) {
        hits = index.filter((i) => i.kind === "Section").map((i) => ({ i, s: 0 }));
      } else {
        hits = index.map((i) => {
          const t = i.title.toLowerCase(), b = i.text.toLowerCase();
          let s = 0;
          for (const w of words) {
            if (t.includes(w)) s += t.startsWith(w) ? 9 : 5;
            else if (b.includes(w)) s += 1 + Math.min(5, b.split(w).length - 2) * 0.4;
            else return null;
          }
          return { i, s };
        }).filter(Boolean).sort((a, b) => b.s - a.s).slice(0, 40);
      }
      hot = 0;
      out.replaceChildren(...(hits.length ? hits.map(({ i }, n) => {
        const a = h("a", { class: "hit" + (n === 0 ? " hot" : ""), href: "#" }, h("em", { text: i.kind }), h("b", { text: i.title }), words.length ? h("small", { text: snippet(i.text, words) }) : null);
        a.addEventListener("click", (e) => { e.preventDefault(); i.go(); });
        return a;
      }) : [h("div", { class: "nores", text: "Nothing found. Try fewer words." })]));
    }
    const mark = () => [...out.children].forEach((c, n) => { c.classList.toggle("hot", n === hot); if (n === hot) c.scrollIntoView({ block: "nearest" }); });
    input.addEventListener("input", render);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowDown") { hot = Math.min(hot + 1, hits.length - 1); mark(); }
      else if (e.key === "ArrowUp") { hot = Math.max(hot - 1, 0); mark(); }
      else if (e.key === "Enter" && hits[hot]) hits[hot].i.go();
      else return;
      e.preventDefault();
    });
    dlg.addEventListener("mousedown", (e) => e.target === dlg && close());
    $("#open-search").addEventListener("click", open);
    return (q) => { open(); input.value = q; render(); };
    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); open(); }
      else if (e.key === "/" && !typing) { e.preventDefault(); open(); }
    });
  }

  // ---------- start ----------
  buildPicker();
  buildThemes();
  buildShortcuts();
  buildChangelog();
  buildPaletteDemo();
  buildViewsDemo();
  const searchFor = buildSearch();
  applyTheme();
  root.classList.remove("pending");
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("ready")));
  spy();
  // Open on the section the app asked for (once per opening, so a refocus doesn't scroll again).
  const want = payload && payload.section;
  const stamp = payload && String(payload.openedAt || "");
  if (location.hash && $(location.hash)) {
    requestAnimationFrame(() => $(location.hash).scrollIntoView({ behavior: "instant" }));
  } else if (want && stamp && session.get("octopolis.guide.opened") !== stamp && $("#" + CSS.escape(want))) {
    session.set("octopolis.guide.opened", stamp);
    requestAnimationFrame(() => $("#" + CSS.escape(want)).scrollIntoView({ behavior: "instant" }));
  }
  // A search typed in the app's palette opens the guide's search with the same words (once per opening).
  const q = payload && typeof payload.search === "string" ? payload.search.trim() : "";
  if (q && stamp && session.get("octopolis.guide.searched") !== stamp) {
    session.set("octopolis.guide.searched", stamp);
    searchFor(q);
  }
  addEventListener("load", () => placePill(navLinks.find((a) => a.classList.contains("on"))));
})();
