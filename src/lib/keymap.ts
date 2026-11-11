// Key names, chord sequences ("ctrl+k ctrl+s") and a matcher for them.

export interface KeyLike {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey?: boolean;
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock"]);
const NAMED: Record<string, string> = { " ": "space", "+": "plus" };

/**
 * Normalizes a key event to "ctrl+alt+shift+key". Returns null for a bare
 * modifier press. Letters are lower-case with an explicit "shift+".
 */
export function eventToKey(e: KeyLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  let key: string;
  if (e.code === "Backslash" || e.code === "IntlBackslash") key = "\\";
  else if (e.code?.startsWith("Key") && e.code.length === 4) key = e.code.slice(3).toLowerCase();
  else if (e.code?.startsWith("Digit") && e.code.length === 6) key = e.code.slice(5);
  else key = NAMED[e.key] ?? e.key.toLowerCase();
  const mods = [e.ctrlKey || e.metaKey ? "ctrl" : "", e.altKey ? "alt" : "", e.shiftKey ? "shift" : ""].filter(Boolean);
  return [...mods, key].join("+");
}

/** "ctrl+shift+\\" → "Ctrl+Shift+\" for display. */
export function formatKeys(seq: string): string {
  return seq
    .split(" ")
    .map((k) =>
      k
        .split("+")
        .map((p) => (p.length === 1 ? p.toUpperCase() : p === "arrowup" ? "↑" : p === "arrowdown" ? "↓" : p === "arrowleft" ? "←" : p === "arrowright" ? "→" : p[0].toUpperCase() + p.slice(1)))
        .join("+"),
    )
    .join(" ");
}

export type MatchResult = { readonly type: "run"; readonly id: string } | { readonly type: "pending" } | { readonly type: "none" };

/** Matches keys (one at a time) against sequences of one or more chords. */
export class ChordMatcher {
  private readonly seqs = new Map<string, string>();
  private readonly prefixes = new Set<string>();
  private buffer: string[] = [];

  constructor(bindings: Iterable<readonly [seq: string, id: string]>) {
    for (const [seq, id] of bindings) {
      const parts = seq.trim().split(/\s+/);
      this.seqs.set(parts.join(" "), id);
      for (let i = 1; i < parts.length; i++) this.prefixes.add(parts.slice(0, i).join(" "));
    }
  }

  get pending(): boolean {
    return this.buffer.length > 0;
  }

  reset() {
    this.buffer = [];
  }

  feed(key: string): MatchResult {
    this.buffer.push(key);
    const seq = this.buffer.join(" ");
    const id = this.seqs.get(seq);
    if (id !== undefined && !this.prefixes.has(seq)) {
      this.buffer = [];
      return { type: "run", id };
    }
    if (this.prefixes.has(seq)) return { type: "pending" };
    if (id !== undefined) {
      this.buffer = [];
      return { type: "run", id };
    }
    // A broken chord: let its last key start fresh.
    const retry = this.buffer.length > 1;
    this.buffer = [];
    return retry ? this.feed(key) : { type: "none" };
  }
}
