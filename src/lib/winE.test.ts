import { describe, expect, it } from "vitest";
import app from "../App.tsx?raw";
import { handleWinE, type WinESteps } from "./winE";

function steps(claimed: boolean) {
  const log: string[] = [];
  const s: WinESteps = {
    claim: async (id) => {
      log.push(`claim ${id}`);
      return claimed;
    },
    open: async () => void log.push("open"),
    painted: async () => void log.push("painted"),
    shown: async (id) => void log.push(`shown ${id}`),
  };
  return { s, log };
}

describe("handleWinE", () => {
  it("opens This PC, then acknowledges once painted", async () => {
    const { s, log } = steps(true);
    expect(await handleWinE(7, s)).toBe(true);
    expect(log).toEqual(["claim 7", "open", "painted", "shown 7"]);
  });

  it("doesn't open a request that was cancelled by its timeout", async () => {
    const { s, log } = steps(false);
    expect(await handleWinE(8, s)).toBe(false);
    expect(log).toEqual(["claim 8"]);
  });

  it("treats a failed claim as cancelled", async () => {
    const { s, log } = steps(true);
    expect(await handleWinE(9, { ...s, claim: () => Promise.reject(new Error("gone")) })).toBe(false);
    expect(log).toEqual([]);
  });
});

describe("start-up", () => {
  it("never waits on Win+E or explorer-mode calls", () => {
    const awaited = app.split("\n").filter((l) => /\bawait\b/.test(l));
    expect(awaited.length).toBeGreaterThan(0);
    for (const line of awaited) expect(line).not.toMatch(/winE|explorerMode|winECatch|helper/i);
    // The page says it is ready without waiting for the answer.
    expect(app).toContain("void winEReady()");
  });
});
