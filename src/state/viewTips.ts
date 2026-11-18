// A one-line hint the first time each unusual view is shown.
import { loadJson, saveJson } from "./settings";
import { ui } from "./ui";

const KEY = "octopolis.viewTips.v1";

const TIPS: Readonly<Record<string, string>> = {
  bento: "Bento: pictures keep their shape. Hover or select one to enlarge it; Ctrl + wheel changes the row height.",
  columns: "Columns: click a folder to open it to the right. The path is shown as a chain of columns.",
  content: "Content: one row per item with its type, size and date under the name. Ctrl + wheel zooms.",
  tiles: "Tiles: Ctrl + wheel zooms. Press F2 to rename the selected item.",
  list: "List: items flow down, then across. Scroll sideways with the wheel.",
};

/** Shows the hint for `mode` once, ever. */
export function showViewTip(mode: string) {
  const tip = TIPS[mode];
  if (!tip) return;
  const seen = loadJson<string[]>(KEY, []);
  if (seen.includes(mode)) return;
  saveJson(KEY, [...seen, mode]);
  ui.toast(tip, undefined, 7000);
}
