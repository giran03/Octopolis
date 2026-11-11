import { describe, expect, it } from "vitest";
import { inferPathIsDir } from "../lib/format";

describe("inferPathIsDir", () => {
  it("treats drives, trailing slashes, and plain folder names as directories", () => {
    expect(inferPathIsDir("X:\\")).toBe(true);
    expect(inferPathIsDir("C:\\Users\\guill")).toBe(true);
    expect(inferPathIsDir("X:\\_DEV\\Vibe Projects\\Octopolis\\")).toBe(true);
    expect(inferPathIsDir("X:\\repo\\.git")).toBe(true);
    expect(inferPathIsDir("X:\\releases\\v1.2")).toBe(true);
  });

  it("recognizes file paths by extension while honoring known directory overrides", () => {
    expect(inferPathIsDir("I:\\valorant-win64-shipping.exe")).toBe(false);
    expect(inferPathIsDir("X:\\assets\\poster.png")).toBe(false);
    expect(inferPathIsDir("C:\\src\\index.ts")).toBe(false);
    expect(inferPathIsDir("C:\\archives\\bundle.zip")).toBe(false);
    expect(inferPathIsDir("C:\\folders\\my.app.ts", new Set(["c:\\folders\\my.app.ts"]))).toBe(true);
  });
});
