export type TooltipPart =
  | { kind: "text"; value: string }
  | { kind: "kbd"; value: string };

export interface ParsedTooltip {
  /**
   * - `hints`: a `·`-separated list of `Shortcut Label` pairs (e.g. status bar hints).
   * - `rich`: prose containing one or more inline keyboard shortcuts.
   * - `plain`: ordinary text with no recognized shortcuts.
   */
  mode: "hints" | "rich" | "plain";
  hints?: Array<{ keys: string; label: string }>;
  parts?: TooltipPart[];
}

const MOD_COMBO =
  "(?:Ctrl|Alt|Shift|Win|Meta|Cmd)(?:\\+(?:Ctrl|Alt|Shift|Win|Meta|Cmd|[A-Za-z0-9]+|[\\\\,.\\-+/\\[\\];'`=]))+";
const NAMED_KEY =
  "Enter|F1[0-2]|F[1-9]|Delete|Del|Backspace|Space|Tab|Esc|Escape|Insert|Home|End|PageUp|PageDown";
const SINGLE_PARENS_KEY = "[A-Z0-9+\\-]";

const HINT_ITEM_RE = new RegExp(`^(${MOD_COMBO}|${NAMED_KEY})\\s+(.+)$`);
const INLINE_RE = new RegExp(
  `(\\s*·\\s*)(${MOD_COMBO})$|\\s*\\((${MOD_COMBO}|${NAMED_KEY}|${SINGLE_PARENS_KEY})\\)|(${MOD_COMBO})`,
  "g",
);

/** Parses a tooltip string into structured hint pairs or inline shortcut segments. */
export function parseTooltip(raw: string): ParsedTooltip {
  const trimmed = raw.trim();
  if (!trimmed) return { mode: "plain" };

  // 1. Multi-item shortcut cheat sheet (e.g. StatusHints: "Enter Open · F2 Rename · Ctrl+C Copy")
  if (trimmed.includes("·")) {
    const segments = trimmed.split(/\s*·\s*/).filter(Boolean);
    if (segments.length >= 2) {
      const hints: Array<{ keys: string; label: string }> = [];
      let allMatch = true;
      for (const seg of segments) {
        const m = HINT_ITEM_RE.exec(seg);
        if (!m) {
          allMatch = false;
          break;
        }
        hints.push({ keys: m[1], label: m[2] });
      }
      if (allMatch) {
        return { mode: "hints", hints };
      }
    }
  }

  // 2. Inline shortcuts: trailing "· Ctrl+P", parenthesized "(Ctrl+T)" / "(Esc)" / "(I)", or bare "Ctrl+Shift+D"
  const parts: TooltipPart[] = [];
  let lastIndex = 0;
  let hasKbd = false;
  INLINE_RE.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(raw)) !== null) {
    const [full, _dotSep, trailingCombo, parensKey, bareCombo] = m;
    const key = trailingCombo ?? parensKey ?? bareCombo;
    if (!key) continue;

    hasKbd = true;
    if (m.index > lastIndex) {
      parts.push({ kind: "text", value: raw.slice(lastIndex, m.index) });
    }

    // For trailing " · Ctrl+," or parenthesized " (Ctrl+T)", replace separator/parens with a clean space.
    if (trailingCombo || (parensKey && full.startsWith(" "))) {
      parts.push({ kind: "text", value: " " });
    }
    parts.push({ kind: "kbd", value: key });
    lastIndex = m.index + full.length;
  }

  if (!hasKbd) return { mode: "plain" };
  if (lastIndex < raw.length) {
    parts.push({ kind: "text", value: raw.slice(lastIndex) });
  }
  return { mode: "rich", parts };
}
