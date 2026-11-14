import { describe, expect, it } from "vitest";
import { summonKeyOf } from "./summon";

describe("summonKeyOf", () => {
  it("keeps current choices", () => {
    expect(summonKeyOf("ctrlE")).toBe("ctrlE");
    expect(summonKeyOf("ctrlShiftAltE")).toBe("ctrlShiftAltE");
    expect(summonKeyOf("off")).toBe("off");
  });

  it("moves the old Ctrl+Alt+E choice to the new anywhere shortcut", () => {
    expect(summonKeyOf("ctrlAltE")).toBe("ctrlShiftAltE");
  });

  it("turns anything unknown off", () => {
    expect(summonKeyOf(undefined)).toBe("off");
    expect(summonKeyOf("ctrlZ")).toBe("off");
  });
});
