// The window's side of a caught Win+E (WE-03, WE-04): claim the request, open
// This PC, and acknowledge "shown" once the window has painted. A request the
// catcher already cancelled (it timed out and File Explorer was used) is not opened.

export interface WinESteps {
  /** `false` when the request was cancelled. */
  readonly claim: (id: number) => Promise<boolean>;
  readonly open: () => Promise<void>;
  /** Resolves once the window has painted the result. */
  readonly painted: () => Promise<void>;
  readonly shown: (id: number) => Promise<void>;
}

/** Handles request `id`. `true` when it was opened. */
export async function handleWinE(id: number, steps: WinESteps): Promise<boolean> {
  if (!(await steps.claim(id).catch(() => false))) return false;
  await steps.open();
  await steps.painted();
  await steps.shown(id);
  return true;
}

/** Two animation frames: the browser only runs them for a visible page, after painting. */
export const afterPaint = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
