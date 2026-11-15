// "What's new" after an update: pick the changelog releases the user hasn't seen yet.

const parse = (v: string): number[] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** Negative when a < b, positive when a > b, 0 when equal or not comparable. */
export function compareVersions(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Splits a changelog into `## [version]` blocks (heading line included), newest first as written. */
export function splitReleases(md: string): { version: string; text: string }[] {
  const out: { version: string; text: string }[] = [];
  let cur: { version: string; lines: string[] } | null = null;
  for (const line of md.split(/\r?\n/)) {
    const m = /^##\s+\[([^\]]+)\]/.exec(line);
    if (m) {
      if (cur) out.push({ version: cur.version, text: cur.lines.join("\n").trim() });
      cur = { version: m[1], lines: [line] };
    } else if (cur) cur.lines.push(line);
  }
  if (cur) out.push({ version: cur.version, text: cur.lines.join("\n").trim() });
  return out;
}

/**
 * Changelog text to show for an update, or null when there's nothing to announce.
 * `lastSeen` is "" when unknown (first launch with this feature): only the current release is shown.
 * Releases newer than `lastSeen` up to `current` are included, newest first.
 */
export function whatsNewText(md: string, lastSeen: string, current: string): string | null {
  if (lastSeen && compareVersions(lastSeen, current) >= 0) return null;
  const picked = splitReleases(md).filter((r) => {
    if (compareVersions(r.version, current) > 0) return false;
    return lastSeen ? compareVersions(r.version, lastSeen) > 0 : r.version === current;
  });
  return picked.length ? picked.map((r) => r.text).join("\n\n") : null;
}
