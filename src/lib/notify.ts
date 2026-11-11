// When a finished job deserves a Windows notification, and what it says.

/** Jobs shorter than this finish while you're still looking. */
export const NOTIFY_AFTER_MS = 10_000;
const NOTIFIED_KINDS = new Set(["copy", "move", "compress", "remove"]);

export interface FinishedJob {
  readonly kind: string;
  readonly label: string;
  readonly elapsedMs: number;
  readonly errors: number;
  readonly cancelled: boolean;
}

/** The notification for a job, or null when none is wanted. */
export function finishNotice(job: FinishedJob, opts: { enabled: boolean; focused: boolean }): { title: string; body: string } | null {
  if (!opts.enabled || opts.focused || job.cancelled || job.elapsedMs < NOTIFY_AFTER_MS || !NOTIFIED_KINDS.has(job.kind)) return null;
  // "Copying 3 items" → "3 items"
  const what = job.label.replace(/^\S+\s+/, "");
  if (job.errors > 0) return { title: "Finished with problems", body: `${what}: ${job.errors} ${job.errors === 1 ? "item" : "items"} couldn't be done` };
  const done = { copy: "Copied", move: "Moved", compress: "Compressed", remove: "Deleted" }[job.kind] ?? "Done";
  return { title: `${done} ${what}`, body: "Finished in Octopolis" };
}
