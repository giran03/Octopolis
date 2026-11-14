import { describe, expect, it } from "vitest";
import { contrastRatio, derivePalette, fullTokens, mixColors, parseColor, parseThemes, randomPalette, sanitizeThemes, themeChoices, themeToJson, themeVars, themeWarnings, TOKEN_INFO, toHex, uniqueThemeName } from "./themeTools";
import { BUILT_IN_THEMES, isColor, MEDIA_TAG_TOKENS, mediaTagLabel, mediaTagToken, mediaTagVar, parseTheme, THEME_FAMILIES, THEME_TOKENS } from "./themes";
const luminanceOf = (c: string) => { const p = parseColor(c)!; const l = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * l(p.r) + 0.7152 * l(p.g) + 0.0722 * l(p.b); };

describe("colors", () => {
  it("reads hex, rgb and hsl", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(toHex("rgb(255, 0, 0)")).toBe("#ff0000");
    expect(toHex("hsl(120, 100%, 50%)")).toBe("#00ff00");
    expect(parseColor("#00000080")?.a).toBeCloseTo(0.5, 1);
    expect(parseColor("url(x)")).toBeNull();
    expect(toHex("nope", "#123456")).toBe("#123456");
  });
  it("mixes and measures contrast", () => {
    expect(mixColors("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
  });
});

describe("palettes", () => {
  it("derives every token from three colors, all valid colors", () => {
    for (const [bg, text, accent] of [["#101216", "#e3e6ed", "#6d8cff"], ["#f6f7f9", "#1b1f27", "#3d63f0"]]) {
      const p = derivePalette(bg, text, accent);
      expect(Object.keys(p).sort()).toEqual([...THEME_TOKENS].sort());
      for (const v of Object.values(p)) expect(isColor(v)).toBe(true);
      expect(themeWarnings(p)).toEqual([]);
    }
  });
  it("keeps random palettes readable in both styles", () => {
    for (let i = 0; i < 40; i++) for (const dark of [true, false]) {
      const r = randomPalette(dark);
      expect(r.scheme).toBe(dark ? "dark" : "light");
      expect(contrastRatio(r.tokens.text, r.tokens.bg)).toBeGreaterThan(7);
    }
  });
  it("warns about unreadable colors", () => {
    const bad = { ...fullTokens({ tokens: {} }), text: "#101216" };
    expect(themeWarnings(bad).length).toBeGreaterThan(0);
  });
});

describe("sharing", () => {
  it("round-trips through JSON with every token", () => {
    const t = parseTheme(JSON.stringify({ name: "Dusk", scheme: "light", tokens: { bg: "#fff" } }));
    const back = parseTheme(themeToJson(t));
    expect(back.name).toBe("Dusk");
    expect(back.scheme).toBe("light");
    expect(Object.keys(back.tokens).length).toBe(THEME_TOKENS.length);
  });
  it("makes names unique and never clashes with a built-in", () => {
    expect(uniqueThemeName("Dusk", ["dusk"])).toBe("Dusk 2");
    expect(uniqueThemeName("", [])).toBe("Custom");
    const list = sanitizeThemes([{ name: "Midnight", tokens: { bg: "#000" } }, { name: "X", tokens: { bg: "#111" } }, { name: "x", tokens: { bg: "#222" } }, { nope: 1 }, "junk"]);
    expect(list.map((t) => t.name)).toEqual(["Midnight 2", "X", "x 2"]);
    expect(BUILT_IN_THEMES.length).toBeGreaterThan(0);
  });
  it("imports one theme or a list, and explains failures", () => {
    expect(parseThemes('{"name":"A","tokens":{"bg":"#000"}}')).toHaveLength(1);
    expect(parseThemes('[{"name":"A","tokens":{"bg":"#000"}},{"name":"B","tokens":{"bg":"#111"}}]')).toHaveLength(2);
    expect(() => parseThemes("[]")).toThrow();
    expect(() => parseThemes("{")).toThrow("valid JSON");
    expect(() => parseThemes('{"tokens":{"bg":"url(x)"}}')).toThrow("not a color");
  });
});

describe("built-in themes", () => {
  const dark = ["Midnight", "Graphite", "OLED Black", "Dune", "Forest", "High contrast", "Mono Slate", "Neon Nights", "Electric Lime", "Dusk"];
  it("has unique names, a family each, and every family is used", () => {
    const names = BUILT_IN_THEMES.map((t) => t.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(BUILT_IN_THEMES.every((t) => t.family)).toBe(true);
    for (const f of THEME_FAMILIES) expect(BUILT_IN_THEMES.some((t) => t.family === f.id)).toBe(true);
    for (const t of BUILT_IN_THEMES) expect(t.scheme).toBe(dark.includes(t.name) ? "dark" : "light");
  });
  it("keeps text readable in every theme", () => {
    for (const t of BUILT_IN_THEMES) {
      const k = fullTokens(t);
      for (const v of Object.values(k)) expect(isColor(v), t.name).toBe(true);
      // Accents may sit just under 3:1 in the neon themes, by design; everything else must pass.
      const warnings = themeWarnings(k).filter((w) => !(t.family === "vibrant" && w.startsWith("The accent")));
      expect(warnings, t.name).toEqual([]);
    }
  });
  it("gives the high-contrast themes AAA text", () => {
    for (const t of BUILT_IN_THEMES.filter((x) => x.family === "contrast")) {
      const k = fullTokens(t);
      expect(contrastRatio(k.text, k.bg), t.name).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(k["text-muted"], k.surface), t.name).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(k.accent, k.bg), t.name).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("keeps OLED Black truly black", () => {
    const k = fullTokens(BUILT_IN_THEMES.find((t) => t.name === "OLED Black")!);
    expect(k.bg).toBe("#000000");
    for (const key of ["surface", "surface-2", "surface-3"] as const) expect(luminanceOf(k[key])).toBeLessThan(0.02);
  });
  it("lists choices by family with a preview each", () => {
    const list = themeChoices([{ name: "Mine", scheme: "dark", tokens: { bg: "#111" } }], { system: true });
    expect(list[0].value).toBe("System");
    expect(list.every((c) => c.swatch.startsWith("linear-gradient"))).toBe(true);
    expect(list.at(-1)).toMatchObject({ value: "Mine", group: "Your themes" });
    expect(themeChoices([], { scheme: "light" }).every((c) => BUILT_IN_THEMES.find((t) => t.name === c.value)?.scheme === "light")).toBe(true);
  });
});

describe("media tag tokens", () => {
  it("maps filenames and extensions to distinct tag tokens and CSS variables", () => {
    expect(mediaTagLabel("photo.JPG")).toBe("JPG");
    expect(mediaTagLabel("noext")).toBe("");
    expect(mediaTagToken("photo.JPG")).toBe("tag-jpg");
    expect(mediaTagToken("photo.jpeg")).toBe("tag-jpg");
    expect(mediaTagToken("shot.png")).toBe("tag-png");
    expect(mediaTagToken("loop.gif")).toBe("tag-gif");
    expect(mediaTagToken("hero.webp")).toBe("tag-webp");
    expect(mediaTagToken("icon.svg")).toBe("tag-svg");
    expect(mediaTagToken("pic.avif")).toBe("tag-avif");
    expect(mediaTagToken("clip.mp4")).toBe("tag-mp4");
    expect(mediaTagToken("reel.mov")).toBe("tag-mov");
    expect(mediaTagToken("vid.webm")).toBe("tag-webm");
    expect(mediaTagToken("movie.mkv")).toBe("tag-mkv");
    expect(mediaTagToken("unknown.xyz")).toBe("tag-other");
    expect(mediaTagVar("photo.JPG")).toBe("var(--tag-jpg)");
    expect(mediaTagVar("mp4")).toBe("var(--tag-mp4)");
  });

  it("defines distinct tag colors in every built-in theme and exposes all tokens in Theme Factory", () => {
    const exposed = TOKEN_INFO.flatMap((g) => g.items.map((i) => i.token));
    expect(exposed.sort()).toEqual([...THEME_TOKENS].sort());
    for (const t of BUILT_IN_THEMES) {
      const k = fullTokens(t);
      const vars = themeVars(t);
      for (const tag of MEDIA_TAG_TOKENS) {
        expect(isColor(k[tag]), `${t.name}:${tag}`).toBe(true);
        expect(vars[`--${tag}`]).toBe(k[tag]);
      }
      const core = [k["tag-jpg"], k["tag-png"], k["tag-gif"], k["tag-mp4"]];
      expect(new Set(core).size, t.name).toBe(core.length);
    }
  });
});
