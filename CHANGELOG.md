# Changelog

## [0.1.1] - 2026-11-14

### Added

- **Movable & customizable Details columns**: Drag column headers directly in Details view to reorder them, auto-size one or all columns to fit, or open **Customize columns…** (header context menu or Command Palette) to toggle columns, drag/step reorder them, and adjust per-column widths.
- **PowerBar Settings search & `/` filter hints**: Search and jump straight to Settings tabs/rows from the Command Palette, and use `/` filter mode with clean, non-overlapping filter examples.
- **Runnable script & installer actions**: Run `.bat`/`.cmd` scripts directly and use **Run** / **Install** context menu actions on executables and installers.
- **Welcome wizard re-run**: Added a **Run wizard** button under **Settings > About > Help** to re-launch the first-run setup tour anytime.
- **Bento layout customization & media tags**: Added **Hide file names** and **Show tags** toggles under **Settings > Appearance > Bento layout** (both enabled by default). Non-folder Bento cards display colorized top-right media extension tags (`JPG`, `PNG`, `GIF`, `WEBP`, `SVG`, `AVIF`, `MP4`, `MOV`, `WEBM`, `MKV`, etc.) synced across all built-in themes and customizable in the Theme Factory.
- **Toolbar Sort & Group menu**: Added a **Sort & group** button beside the **View** button in the pane toolbar with **Sort by** (`Name`, `Date modified`, `Type`, `Size`, plus `Relevance` when searching), **Ascending / Descending** direction toggles, **Group by** (`None`, `Type`, `Date modified`, `Size`, `Name`), and **Reset to default**.
- **Custom actions Run button**: Added a **Run** icon button to each row in **Custom actions** to run it directly on the active explorer selection or focused item, and defaulted **Start in folder** on new actions to the active, focused explorer folder.
- **Drag & drop `.bat` / `.cmd` to Custom actions**: Dragging `.bat` or `.cmd` files onto the **Custom actions** footer button or into the **Custom actions** dialog adds them as runnable actions (with console output enabled, working folder set to the script's directory, row highlight, and a quick **Run** toast action).
- **Window corners setting**: Added **Window corners** (`Default`, `Square`, `Small`, `Rounded`) under **Settings > Appearance > Size and density** to customize the main window's corner roundedness.
- **Tooltip delay setting**: Added a **Tooltip delay** slider (`Instant` to `5.0 s`, defaulting to `0.7 s`) under **Settings > Appearance > Motion and help**.
- **Folder rules scheduling & presets**: Added per-rule schedules with one-click presets (`Manual`, `On startup`, `Every 15 min`, `Every hour`, `Every 6 hours`, `Daily 09:00`, `Weekly`, `Monthly`), custom intervals (`Every N minutes/hours/days`), bounded run limits (**Forever**, **N runs**, or **For duration** in hours/days), and **Run automatically** vs **Notify & preview** modes.
- **Type-ahead jump indicator**: Added a transient `Jump:` pill with match count (`index/total`) in the status bar when cycling or typing to jump to items.
- **All drives overview**: Added **All drives** as the first item in the sidebar **Drives** section, opening a **Devices and drives** grid view showing all local, USB/removable, optical, network drives, and WSL distros with usage bars, free/total capacity, and context actions.
- **Window buttons style**: Added **Window buttons** (`macOS` traffic lights or `Windows` controls, defaulting to `macOS`) under **Settings > Appearance > Size and density**.

### Changed

- **Responsive sidebar & density**: Sidebar footer tool icons automatically anchor to the left side of the status bar when the sidebar is narrow or collapsed; dragging the sidebar below ~100 px smoothly snaps it collapsed (and dragging back out re-opens it); **Compact** density defaults the sidebar to `150 px`.
- **Accent color dot**: Styled the **Accent color** preview in **Settings > Appearance** as a circular dot that reflects the active theme's default accent when set to **Theme default**.
- **Edit rule modal**: Re-styled the **Edit rule** dialog with grouped section cards, aligned labels and controls, and a clearer live rule summary card.
- **Settings > Appearance**: Moved **Shortcut hints in the status bar** into its own row under **Motion and help**, and added spacing between the **New theme…** and **Import file…** buttons under **Your themes**.
- **Shortcut tooltips**: Stylized tooltips containing keyboard shortcuts (including status bar hint tooltips) with inline `<kbd>` keycaps and wrapped key-action chips so shortcuts stay paired with their labels.
- **Checkboxes**: Replaced all native `<input type="checkbox">` controls across dialogs, Cleanup, Duplicates, Tags, Properties, Rules, Custom actions, and Terminal with the animated CafeTako Site Builder checkbox element (`data-ui="checkbox"`).
- **Shortcuts settings sections**: Grouped **Settings > Shortcuts** into categorized sections (`Navigate`, `File`, `Tabs`, `Panes`, `View`, `Search`, `List`, `App`, `Actions`) with icons, descriptions, command counts, and category filter chips.

### Fixed

- **Native browser shortcuts & tooltips**: Disabled native WebView2 browser shortcuts (such as `Ctrl+P` print) and prevented unstyled native `title` tooltips from flashing or appearing over Octopolis's styled tooltip layer.
- **Tag modal row icon hover**: Added contrasting hover backgrounds for row icon buttons in the **Tags** modal so their hover animations remain visible over hovered rows.
- **Letter-press cycling**: Pressing the same letter key repeatedly (such as `G`) now cycles cleanly through every matching folder and file in order instead of treating repeated presses as a multi-letter prefix.
- **Toolbar icon alignment**: Centered icons inside toolbar `.icon-btn` buttons (including the **View** and **Sort & group** buttons).

## [0.1.0] - 2026-11-13

### Added

- **Offline guide (`F1`)**: A full guide to Octopolis that opens in your browser and works offline. Press `F1` (or use **Settings > About**, the Welcome tour, or `?` in the palette) and it opens on the section matching what you have open. It includes animated demos, a searchable keyboard reference, a theme gallery, and this changelog, wearing the same theme, accent, font, and animation setting as the app. Search it with `/` or `Ctrl+K`, or type `;` in the command palette.
- **Command palette (`Ctrl+P`)**: Mode prefixes (`>` commands, `/` search subfolders, `@` open tabs, `#` pinned folders, `!` shell command, `?` help), fuzzy file matching, path completion (`~` and `%VAR%`), and inline math/unit calculation (`12*8`, `5 mb in kb`). Keys: `Ctrl+N`/`P` or `Ctrl+J`/`K`, `PageUp`/`PageDown`, `Home`/`End`, `Tab` completes, `Shift+Enter` new tab, `Ctrl+Enter` other pane, `Alt+Enter` Properties, `Alt+Shift+Enter` Explorer, `Ctrl+C` copy path, `Ctrl+D` pin, `Shift+Delete` forget. Reopening within 10 seconds keeps what you typed.
- **Full-width responsive cells**: Icon, tile, and list views stretch their cells to share the full width when resizing the window.
- **Auto view (on by default)**: Each folder opens in the view that suits what it holds (Bento for pictures/videos, rows for music, tiles for folders of folders, details for everything else and repositories). A manually picked view sticks to that folder; **Auto** in the View menu (`Ctrl+Shift+0`) hands it back. Toggleable under **Settings > General**.
- **Bento view (`Ctrl+Shift+9`)**: Pictures keep their aspect ratio and fill every row; hovered or selected items grow while neighbours give way, and `Ctrl+wheel` adjusts row height.
- **Custom folder icons**: Right-click menu shows the active emoji or Windows icon kind and marks **Reset icon** as Default. **Change icon** includes a **Windows** tab with special folders, Start menu app icons, and system icon files loaded on scroll.
- **Explorer-style views & zoom slider**: Toolbar **View** menu with Extra large, Large, Medium, and Small icons, List, Details, Tiles, Content, and Columns, plus a smooth zoom slider, `Ctrl+wheel` zoom, `Ctrl+Shift+1`–`8` shortcuts, per-folder view memory, marquee box selection, and drag-and-drop.
- **Batch file opening & properties**: Text files open together in your editor, other files open in one batch (asking above 10, max 50), and Properties loads in one call.
- **Native drag-and-drop out**: Drag selected files out to File Explorer, browser upload boxes, or chat/mail apps as real files.
- **Web & app drop support**: Drag files or file links from web pages or other apps onto a folder to save or copy them safely without overwriting.
- **Custom actions**: Searchable manager in the sidebar footer with per-action enable switches, duplicate, JSON import/export, 20 built-in presets, `cmd` / `PowerShell` / admin / confirmation / per-item / working-folder options, command palette & shortcut integration, live preview, missing-program warnings, and placeholders (`{path}`, `{paths}`, `{dir}`, `{parent}`, `{name}`, `{stem}`, `{ext}`, `{pslist}`, `{list}`, `{pickfolder}`, `{prompt:Label}`).
- **12 built-in themes & gallery**: Six families (`light`, `dark`, `high contrast`, `minimal`, `vibrant`, `pastel`), including **OLED Black** and light high contrast, with per-family gallery cards and separate light/dark **Follow Windows** themes.
- **Theme creator (Theme Factory)**: Create, edit, duplicate, delete, and import/export custom themes with a live mock-up, 3-color auto-shading, random palette generator, contrast warnings, and per-color undo.
- **Settings window (`Ctrl+,`)**: General, Appearance, Shortcuts, Advanced, Updates, and About tabs covering startup folder, folder sizes, thumbnails, delete confirmation, terminal shell, themes, accent, text size, density, animations, tooltips, sidebar/shelf options, custom shortcuts, backup/restore, and reset.
- **In-app updater**: Updates tab and About page with automatic background checks, SHA-256 verification, and silent install from GitHub Releases.
- **Sidebar & Shelf**: Collapsible sidebar sections, pinned and recent folders, resizable sidebar, and a Shelf that opens automatically while dragging files.
- **Custom title bar**: Window controls, go-to pill, and icon-font glyphs throughout.
- **High-speed directory listing**: Smooth browsing in folders with `100,000+` items.
- **Details list**: `Name`, `Date modified`, `Type`, and `Size` columns with natural number sorting and folders always on top.
- **Tabs & split panes**: Multi-tab panes, side-by-side or stacked splits, and draggable dividers.
- **Path bar (`Ctrl+L`)**: Clickable breadcrumbs, path suggestions as you type, and support for `~`, `%USERPROFILE%`, and file paths.
- **History navigation**: Back, forward, and up navigation returning focus to the folder you came from.
- **Quick filter (`Ctrl+F`)**: Narrow the current folder by name as you type.
- **Sidebar Quick access & drives**: Pinned folders and drives with free space indicators.
- **Clipboard & file transfers**: Copy, cut, paste, and drag-and-drop between panes (`Ctrl` to force copy) with a progress tray and Cancel button.
- **Delete & Recycle Bin**: Move to Recycle Bin or delete permanently (`Shift+Delete`) with confirmation, plus a built-in Recycle Bin window to search, restore, purge, or empty.
- **Inline rename (`F2`) & New folder (`Ctrl+Shift+N`)**: Quick creation and renaming directly in the list.
- **Live folder watching**: Automatic updates when files change outside Octopolis.
- **Context menu**: Type-to-filter right-click menu with pinned actions, **Copy path**, **Show in Explorer**, and link to the classic Windows menu.
- **Keyboard navigation**: Type-to-find and shortcuts for tabs (`Ctrl+T`, `Ctrl+W`, `Ctrl+Tab`) and panes (`Ctrl+\`, `F6`, `Tab`).
- **View toggles**: Show/hide hidden files (`Ctrl+H`) and toggle sidebar (`Ctrl+B`).
- **System theme sync**: Light and dark themes that follow Windows automatically.
- **Subfolder search (`Ctrl+Shift+F`)**: Fuzzy matching ranked by relevance, with filters (`ext:pdf,docx`, `size:>100mb`, `dm:today`, `dm:week`, `dm:2026-01-01..2026-03-31`, `re:`, `type:file`, `type:dir`, and `content:` inside files).
- **Flat view (`Ctrl+Shift+E`)**: List every file across subfolders in one sortable view.
- **Shortcuts editor (`Ctrl+K Ctrl+S`)**: Customize any shortcut, including two-step chords.
- **Optional Vim keys**: `h`, `j`, `k`, `l`, `gg`, `G`, `yy`, `dd`, `p`, `v` for visual selection, `/` to filter.
- **Reopen closed tab (`Ctrl+Shift+T`)**: Restore the last closed tab.
- **Inspector panel (`Ctrl+I` or `Space`)**: Syntax-highlighted code, Markdown, images, SVG, PDF, video, audio with waveform, 3D models (`OBJ`, `STL`), hex dumps, and folder thumbnails; plus **Quick look** (`Shift+Space`).
- **Archive browsing & compression**: Browse `.zip`, `.7z`, and `.tar` archives like folders, preview/copy items out, and compress files to `.zip`, `.7z`, or `.tar.gz` with progress and cancel.
- **Windows shell icons**: Native file icons in the list.
- **Batch rename (`F2` on multi-selection)**: Numbering, dates, photo/music tags, regex find/replace, editable name list, and conflict detection.
- **Lock inspector ("What is locking this?")**: Shows processes holding a file open with an option to end them.
- **Undo & redo (`Ctrl+Z`, `Ctrl+Y`)**: Supports moves, renames, copies, new folders, and Recycle Bin deletes.
- **Transfer queue**: Pause/resume, optional checksum verification, and speed limiting.
- **Folder sizes (`Ctrl+Shift+S`) & disk space treemap (`Ctrl+Shift+M`)**: Proportional size bars and interactive treemap.
- **Git integration**: Status badges, status bar branch indicator, optional last commit column, stage/unstage/discard, inspector diffs, and hide git-ignored files.
- **Built-in terminal (`Ctrl+``)**: Follows the active folder and syncs the file list when you `cd`.
- **Grid (`Ctrl+2`) & Column view (`Ctrl+3`)**: Thumbnail grid and macOS-style Miller columns.
- **Session restore**: *"Where I left off"* restores every pane and tab from your last session, plus workspace save/reopen and tab pinning/coloring.
- **Multi-selection tools**: Invert selection (`Ctrl+Shift+I`), select by pattern (`Ctrl+Shift+A`, e.g. `*.jpg; IMG_*` or `re:`), select same type, and multi-item Inspector summary.
- **New file templates (`Ctrl+Alt+N`)**: New text, Markdown, empty, or custom template files; **Copy as** formats (`Ctrl+Alt+C`), **Open with…**, **Run as administrator** (`Ctrl+Shift+Enter`), and USB **Eject**.
- **Conflict resolution**: Replace, Replace if newer, Skip, or Keep both (per item or for all).
- **Default file manager & single-instance**: Optional File Explorer replacement (`Win+E`), context-menu integration, notification area mode (`Ctrl+Q` to quit), and global summon shortcut (`Ctrl+E` / `Ctrl+Alt+E`).
- **Symlinks, long paths & OneDrive**: Copy/create symbolic links, junctions, and hard links; full `>260`-character path support; OneDrive online-only status badges and pin/free-up actions.
- **Properties (`Alt+Enter`)**: Size on disk, editable dates/attributes, hard links, alternate streams, and `SHA-256` / `MD5` / `BLAKE3` checksums.
- **Tools & cleanup**: Duplicate finder, folder compare mode, file tags & color labels (`Ctrl+Shift+G`, searchable with `tag:`), saved searches, Cleanup assistant, network drive mapping, and WSL distro browsing.
- **Font, table & text previews**: Font previews with install button; CSV/TSV/JSONL sortable table previews (up to `10,000` rows); text encoding/line-ending info and **Open in editor** (`Ctrl+Shift+O`).
- **Background transfer polish**: Windows notifications for long operations (`>10s`) and wake-lock while copying or moving.
- **Diagnostics log**: Logs startup times and errors with file and folder names removed (**Settings > Advanced > Open log folder**).
- **Faster startup**: The inspector and terminal load on demand the first time you open them.
- **Accessibility & contrast**: Screen readers hear the file list as a grid with selected rows and operation announcements, with Windows contrast theme support.
- **Free up space (sidebar broom button)**: Safely preview and remove caches, Windows Update leftovers, browser caches, developer caches, and Recycle Bin items.
- **Editor preferences (Settings > General > Editor)**: Pick an installed or custom editor, choose whether double-clicking text/code files opens it, and open folders in your editor or terminal from the right-click menu.
- **Icon customization (Settings > Appearance > Icons)**: Material Symbols with style (`Outlined`, `Rounded`, `Sharp`), weight, size, filled icons, presets, and interface font choice.
- **Settings search & outline**: Search across every settings tab with an outline of the current tab's sections.
- **Navigation & transfer polish**: Hide file extensions (**Settings > General**), taskbar progress for copies and moves, **Copy to… / Move to…** folder picker, and Back/Forward history lists on right-click.
- **Operations history & empty states**: Recent file operations list, friendlier empty/access-denied/missing-folder states, and a short first-run welcome.
- **Folder rules**: Tidy folders by moving old files or sending them to the Recycle Bin with live previews, undo support, filtering, on/off switches, duplicate, JSON import/export, 12 built-in presets, size and age bounds, destination placeholders (`{year}`, `{month}`, `{ext}`), **Run all enabled**, last-run tracking, and command palette integration.
- **Image tools**: Duplicate finder can search for similar pictures; resize or convert images from the right-click menu.
- **Office document previews**: Word, PowerPoint, Excel, and OpenDocument files preview as text.
- **Group by**: Group items by type, date modified, size, or first letter (remembered per folder) via the background menu or command palette.
- **Pane swapping & synchronized browsing**: Swap panes and keep navigation synchronized across two panes from the status bar.
- **Flexible pane splits**: Drag files, folders, or tabs to any pane edge to split (up to 6 panes) with animated layout transitions, or move tabs to a new pane on the right or below.
- **Folder move confirmation**: Optional confirmation before moving a folder into another folder (**Settings > General**, off by default).
- **Custom density slider**: Exact row-height slider (`18–40 px`) alongside `Compact`, `Normal`, and `Comfortable` presets.
- **Google Fonts (Settings > Appearance)**: Curated interface font list with on-demand download, offline saving, and uninstaller cleanup option.
- **Column view polish**: Smooth browsing in folders of any size, synced sort/filter, `Left`/`Right` folder navigation, keyboard shortcuts, and right-click menu.
