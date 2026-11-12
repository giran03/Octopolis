# Octopolis logo: usage guide

**Idea:** a 3x3 city grid whose centre is the head. Eight blocks (octo) around one hub (polis).

## Files
| File | Use |
|---|---|
| `symbol.svg` | Master, on light backgrounds |
| `symbol-reversed.svg` | On dark backgrounds |
| `symbol-small.svg` | Below 32 px (wider gaps) |
| `symbol-black.svg` / `symbol-white.svg` | One-colour: print, stamps, embroidery |
| `horizontal*.svg`, `stacked*.svg` | Symbol + wordmark lockups |
| `wordmark*.svg` | Wordmark alone |
| `app-icon.svg`, `favicon.svg`, `favicon.ico`, `png/` | App icon and web icons |

## Colour
| Name | HEX | RGB | Use |
|---|---|---|---|
| Ink | `#11131A` | 17 19 26 | Tiles, wordmark, app-icon tile |
| Octo Blue | `#3D63F0` | 61 99 240 | Centre disc on light (matches the app's light accent) |
| Octo Blue (dark) | `#6D8CFF` | 109 140 255 | Centre disc on dark (matches the dark accent) |
| White | `#FFFFFF` | 255 255 255 | Tiles and wordmark on dark |

CMYK and Pantone values are not set: have a printer match them from the HEX values.

## Rules
- **Clear space:** at least the width of one tile (64 units of 256) on all sides.
- **Minimum size:** symbol 16 px (use `symbol-small.svg` under 32 px); full lockup 96 px wide.
- **Wordmark:** lowercase only, never retyped in another font.
- **One colour:** use the black or white files. The blue disc becomes the same colour as the tiles.
- **Don't:** rotate, recolour the tiles, add shadows or gradients, stretch, put the colour mark on busy photos, or change the disc size.

## Open items
- Wordmark letters are strokes (monoline, 16 units, round caps). Expand to outlines before sending to print.
- No trademark or reverse-image search has been done.
- `src-tauri/icons/` still holds the old icons. Generate the new set from `app-icon.svg` when approved.
