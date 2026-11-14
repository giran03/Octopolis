import type { SummonKey } from "./ipc";

/**
 * The saved summon shortcut. "ctrlAltE" was the earlier name of the anywhere shortcut; it moved to
 * Ctrl+Shift+Alt+E because Ctrl+Alt is what AltGr sends, so Ctrl+Alt+E took AltGr+E (€) away.
 */
export function summonKeyOf(saved: unknown): SummonKey {
  if (saved === "ctrlE" || saved === "ctrlShiftAltE") return saved;
  if (saved === "ctrlAltE") return "ctrlShiftAltE";
  return "off";
}
