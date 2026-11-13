import { describe, expect, it } from "vitest";
import { ago, calculate, convertUnits, evalExpression, expandTyped, formatNumber, parseQuery, parseUseDb, recentIds, recordUse, splitLabel, splitTyped, useBoost, wrapIndex } from "./paletteLogic";

describe("parseQuery", () => {
  it("reads the mode from the first character", () => {
    expect(parseQuery(">copy")).toEqual({ mode: "commands", query: "copy" });
    expect(parseQuery("/logs")).toEqual({ mode: "search", query: "logs" });
    expect(parseQuery("@docs")).toEqual({ mode: "tabs", query: "docs" });
    expect(parseQuery("#work")).toEqual({ mode: "pins", query: "work" });
    expect(parseQuery("!dir")).toEqual({ mode: "shell", query: "dir" });
    expect(parseQuery("?")).toEqual({ mode: "help", query: "" });
    expect(parseQuery(";sync")).toEqual({ mode: "guide", query: "sync" });
    expect(parseQuery("C:\\Users")).toEqual({ mode: "go", query: "C:\\Users" });
    expect(parseQuery("")).toEqual({ mode: "go", query: "" });
  });
});

describe("calculator", () => {
  it("evaluates arithmetic with precedence, powers and functions", () => {
    expect(evalExpression("12*8")).toBe(96);
    expect(evalExpression("2+3*4")).toBe(14);
    expect(evalExpression("(2+3)*4")).toBe(20);
    expect(evalExpression("2^3^2")).toBe(512);
    expect(evalExpression("-5 + 2")).toBe(-3);
    expect(evalExpression("sqrt(16)+1")).toBe(5);
    expect(evalExpression("10 % 4")).toBe(2);
    expect(evalExpression("1,5*2")).toBe(3);
    expect(evalExpression("pi*2")).toBeCloseTo(6.283185, 5);
  });

  it("does not treat names, numbers or broken input as a sum", () => {
    for (const s of ["2024", "documents", "1/0", "2+", "(1", "abc(2)", "C:\\x", "", "1 2", "alert(1)"]) expect(evalExpression(s)).toBeNull();
  });

  it("formats results", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(1 / 3)).toBe("0.3333333333");
  });
});

describe("unit conversion", () => {
  it("converts sizes like Windows (1 KB = 1024 bytes), lengths, time and temperature", () => {
    expect(convertUnits("5 mb in kb")).toBe("5,120 KB");
    expect(convertUnits("2 gb to mb")).toBe("2,048 MB");
    expect(convertUnits("1,5 km in m")).toBe("1,500 m");
    expect(convertUnits("2 h in min")).toBe("120 min");
    expect(convertUnits("100 c to f")).toBe("212 °F");
    expect(convertUnits("5 apples in kb")).toBeNull();
    expect(convertUnits("5 mb in km")).toBeNull();
    expect(convertUnits("hello")).toBeNull();
  });

  it("calculate prefers a conversion, then a sum", () => {
    expect(calculate("5 mb in kb")?.result).toBe("5,120 KB");
    expect(calculate("12*8")).toEqual({ result: "96", copy: "96" });
    expect(calculate("projects")).toBeNull();
  });
});

describe("remembered use", () => {
  it("counts uses, boosts recent and frequent commands, and lists the latest", () => {
    let db = recordUse({}, "a", 1000);
    db = recordUse(db, "a", 2000);
    db = recordUse(db, "b", 3000);
    expect(db.a.n).toBe(2);
    expect(recentIds(db, 5)).toEqual(["b", "a"]);
    expect(useBoost(undefined, 5000)).toBe(0);
    expect(useBoost(db.a, 5000)).toBeGreaterThan(useBoost(db.b, 5000) - 1);
    expect(useBoost(db.a, 5000)).toBeGreaterThan(useBoost(db.a, 5000 + 40 * 86_400_000));
  });

  it("caps the list and drops bad saved data", () => {
    let db = {};
    for (let i = 0; i < 320; i++) db = recordUse(db, `c${i}`, i);
    expect(Object.keys(db).length).toBe(300);
    expect(db).not.toHaveProperty("c0");
    expect(parseUseDb({ a: { n: 2, last: 5 }, b: { n: "x" }, c: null })).toEqual({ a: { n: 2, last: 5 } });
    expect(parseUseDb(null)).toEqual({});
  });
});

describe("paths", () => {
  it("splits typed text into the folder to list and the part being typed", () => {
    expect(splitTyped("C:\\Users\\Jo")).toEqual({ parent: "C:\\Users", partial: "Jo" });
    expect(splitTyped("C:\\Us")).toEqual({ parent: "C:\\", partial: "Us" });
    expect(splitTyped("C:/Users/")).toEqual({ parent: "C:\\Users", partial: "" });
    expect(splitTyped("docs")).toEqual({ parent: "", partial: "docs" });
  });

  it("expands ~ and %VARIABLES%", () => {
    expect(expandTyped("~\\Desktop", "C:\\Users\\me")).toBe("C:\\Users\\me\\Desktop");
    expect(expandTyped("%TEMP%\\x", null, { TEMP: "C:\\tmp" })).toBe("C:\\tmp\\x");
    expect(expandTyped("%NOPE%", null)).toBe("%NOPE%");
    expect(expandTyped("~x", "C:\\h")).toBe("~x");
  });

  it("splits a path into a dim folder part and a name, and words times", () => {
    expect(splitLabel("C:\\Users\\me\\Docs")).toEqual({ dir: "C:\\Users\\me\\", name: "Docs" });
    expect(splitLabel("C:\\")).toEqual({ dir: "", name: "C:\\" });
    expect(ago(0, 30_000)).toBe("just now");
    expect(ago(0, 5 * 60_000)).toBe("5 min ago");
    expect(ago(0, 3 * 3_600_000)).toBe("3 h ago");
    expect(wrapIndex(-1, 4)).toBe(3);
    expect(wrapIndex(4, 4)).toBe(0);
    expect(wrapIndex(1, 0)).toBe(0);
  });
});
