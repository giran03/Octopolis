// Command palette (Ctrl+P). Plain text jumps to folders, files here and a calculator; a first character picks
// another mode: ">" commands, "/" search, "@" tabs, "#" pinned, "!" shell, ";" guide, "?" help. Ctrl+Shift+P opens commands.
import { createEffect, createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js";
import * as A from "../actions";
import { allCommands, commandById, type Command } from "../commands";
import { inferPathIsDir, formatSize } from "../lib/format";
import { fuzzyRank, type FuzzyMatch } from "../lib/fuzzy";
import { errorText, knownFolders, listDrives, resolvePath, revealInExplorer, runCustomAction, type Drive, type KnownFolder } from "../lib/ipc";
import { formatKeys } from "../lib/keymap";
import { isDir } from "../lib/listing";
import { ago, calculate, expandTyped, MODE_LABELS, MODE_PREFIXES, parseQuery, splitLabel, splitTyped, wrapIndex, type PaletteMode } from "../lib/paletteLogic";
import { baseName, isRoot, joinPath } from "../lib/paths";
import { isPinned } from "../lib/sidebar";
import { recentVisits } from "../lib/frecency";
import { history } from "../state/history";
import { keybindings } from "../state/keybindings";
import type { TabModel } from "../state/tab";
import { guide } from "../state/guide";
import { paletteUse } from "../state/paletteUse";
import { sidebar } from "../state/sidebar";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";
import { IconDrive, IconPin, IconSearch, MaterialIcon, PathIcon, PlaceGlyph, TypeIcon } from "./Icons";
import { subfolders } from "./Pane";

const MAX_ROWS = 80;
const MAX_FILES = 25;
const FILE_SCAN_LIMIT = 8000;
const PAGE = 8;
/** A closed palette reopens with the same text if it comes back this soon. */
const REMEMBER_MS = 10_000;

/** What the user last typed and when, so a quick reopen carries on where they left off. */
const last = { text: "", at: 0 };

/** Commands that need something selected; with nothing selected they are shown muted, with the reason. */
const NEEDS_SELECTION = new Set([
  "file.open", "file.rename", "file.copy", "file.cut", "file.delete", "file.deletePermanently", "file.batchRename",
  "git.stage", "git.unstage", "git.discard", "file.tags", "file.whoLocks", "file.compress", "file.compressAs",
  "file.extract", "file.edit", "file.openWith", "file.runAsAdmin", "file.selectSameType",
]);

interface Row {
  readonly key: string;
  readonly label: string;
  /** Muted folder part at the start of `label`, in characters. */
  readonly dimUntil?: number;
  readonly icon?: () => JSX.Element;
  readonly hint?: string;
  /** Shortcut shown as a key cap. */
  readonly keys?: string;
  readonly group?: string;
  readonly match?: FuzzyMatch;
  /** Why the row cannot run right now. */
  readonly disabled?: string;
  readonly pinned?: boolean;
  /** The path a folder row stands for (pinning, copying, opening elsewhere). */
  readonly path?: string;
  readonly folder?: boolean;
  /** Text Tab puts in the box. */
  readonly complete?: string;
  /** What Ctrl+C copies. */
  readonly copy?: string;
  readonly forgettable?: boolean;
  readonly enterLabel?: string;
  readonly newTab?: () => void;
  readonly second?: () => void;
  readonly secondLabel?: string;
  readonly props?: () => void;
  readonly reveal?: () => void;
  readonly assignShortcut?: () => void;
  readonly run: () => void;
}

function Highlight(props: { text: string; positions?: readonly number[]; dimUntil?: number }): JSX.Element {
  const marks = () => new Set(props.positions ?? []);
  return (
    <span>
      <For each={[...props.text]}>
        {(ch, i) => (marks().has(i()) ? <mark>{ch}</mark> : i() < (props.dimUntil ?? 0) ? <span class="palette-dim">{ch}</span> : ch)}
      </For>
    </span>
  );
}

const looksLikePath = (s: string) => /^([a-z]:|\\\\|~|%)/i.test(s.trim());
const dimOf = (path: string) => splitLabel(path).dir.length;

const PLACEHOLDERS: Record<PaletteMode, string> = {
  go: "Go to folder, open a file here, type a path, or 12*8 · ? for help",
  commands: "Type a command",
  search: "Search subfolders of this folder for…",
  tabs: "Jump to an open tab",
  pins: "Jump to a pinned folder",
  shell: "Run a command in this folder (cmd)",
  guide: "Search the Octopolis guide for…",
  help: "Pick a prefix",
};

export function Palette() {
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  const pointer = { x: -1, y: -1 };
  const remembered = ui.palette() === "go" && last.text && Date.now() - last.at < REMEMBER_MS ? last.text : "";
  const [text, setText] = createSignal(ui.palette() === "commands" ? ">" : remembered);
  const [hot, setHot] = createSignal(0);
  const [places] = createResource(async () => {
    const [folders, drives] = await Promise.all([knownFolders().catch(() => []), listDrives().catch(() => [])]);
    return { folders, drives };
  });

  const parsed = createMemo(() => parseQuery(text()));
  const tab = () => workspace.activeTab();
  const home = () => places()?.folders.find((f) => f.id === "home")?.path ?? null;

  const placeLookups = createMemo(() => {
    const folders = new Map<string, KnownFolder>();
    const drives = new Map<string, Drive>();
    const dirs = new Set<string>();
    for (const f of places()?.folders ?? []) {
      const k = f.path.toLowerCase();
      folders.set(k, f);
      dirs.add(k);
    }
    for (const d of places()?.drives ?? []) {
      const k = d.root.toLowerCase();
      drives.set(k, d);
      drives.set(k.replace(/\\$/, ""), d);
      dirs.add(k);
    }
    for (const t of workspace.allTabs()) dirs.add(t.path().toLowerCase());
    return { folders, drives, dirs };
  });

  const driveHint = (d: Drive) => `${d.label ? `${d.label} · ` : ""}${formatSize(d.freeBytes)} free of ${formatSize(d.totalBytes)}`;

  const iconForPath = (raw: string): JSX.Element => {
    const norm = raw.trim().replace(/\//g, "\\");
    const lower = norm.toLowerCase();
    const { folders, drives, dirs } = placeLookups();
    const drive = drives.get(lower);
    if (drive) {
      const letter = drive.root.replace(/\\$/, "");
      return <PathIcon path={drive.root} name={letter} isDir exact size={16} fallback={<IconDrive kind={drive.kind} size={16} />} />;
    }
    const known = folders.get(lower);
    if (known) {
      return <PathIcon path={known.path} name={known.label} isDir exact size={16} fallback={<PlaceGlyph id={known.id} size={16} />} />;
    }
    if (isRoot(norm)) {
      const root = norm.endsWith("\\") ? norm : `${norm}\\`;
      return <PathIcon path={root} name={baseName(root)} isDir exact size={16} fallback={<IconDrive size={16} />} />;
    }
    return <TypeIcon path={norm} name={baseName(norm)} isDir={inferPathIsDir(norm, dirs)} size={16} />;
  };

  /** Closes the palette; a row that ran forgets the typed text, so the next open starts clean. */
  const finish = (ran = true) => {
    if (ran) last.text = "";
    ui.closePalette();
  };

  const go = (path: string, select?: string | null) => {
    finish();
    void tab()?.navigate(path, select ? [select] : undefined);
  };
  const inNewTab = (path: string) => {
    finish();
    workspace.newTab(workspace.activePaneId(), path);
  };
  /** The next pane (a new one beside this one when there is only one). */
  const inOtherPane = (path: string) => {
    finish();
    if (workspace.paneCount() < 2) workspace.split("row");
    else {
      const ids = workspace.paneIds();
      workspace.focusPane(ids[wrapIndex(ids.indexOf(workspace.activePaneId()) + 1, ids.length)]);
    }
    void workspace.activeTab()?.navigate(path);
  };

  const lastVisited = createMemo(() => {
    const m = new Map<string, number>();
    for (const v of recentVisits(history.db(), 2000)) m.set(v.path.replace(/\\+$/, "").toLowerCase(), v.last);
    return m;
  });

  /** A row that opens a folder, with every way of opening it. */
  const folderRow = (path: string, extra: Partial<Row> = {}): Row => {
    const known = lastVisited().get(path.replace(/\\+$/, "").toLowerCase());
    const drive = placeLookups().drives.get(path.toLowerCase());
    return {
      key: `dir:${path}`,
      label: path,
      dimUntil: dimOf(path),
      icon: () => iconForPath(path),
      hint: drive ? driveHint(drive) : known ? ago(known, Date.now()) : undefined,
      pinned: isPinned(sidebar.pins(), path),
      path,
      folder: true,
      complete: `${path.replace(/\\+$/, "")}\\`,
      copy: path,
      enterLabel: "Open",
      newTab: () => inNewTab(path),
      second: () => inOtherPane(path),
      secondLabel: workspace.paneCount() > 1 ? "Other pane" : "Split",
      props: () => {
        finish();
        ui.setPropertiesPaths([path]);
      },
      reveal: () => {
        finish();
        revealInExplorer(path).catch((e) => ui.toast(errorText(e)));
      },
      run: () => go(path),
      ...extra,
    };
  };

  const selectionCount = () => tab()?.selection().size ?? 0;

  const commandRow = (item: Command, match?: FuzzyMatch, group?: string): Row => {
    const disabled = item.when && !item.when() ? "Not available right now" : NEEDS_SELECTION.has(item.id) && selectionCount() === 0 ? "Select something first" : undefined;
    return {
      key: item.id,
      label: `${item.category}: ${item.title}`,
      hint: disabled,
      keys: keybindings.keysFor(item).map(formatKeys).join("  ") || undefined,
      group,
      match,
      disabled,
      enterLabel: "Run",
      assignShortcut: () => {
        finish();
        ui.openShortcutsFor(item.id, `${item.category} ${item.title}`);
      },
      run: () => {
        paletteUse.record(item.id);
        finish();
        item.run();
      },
    };
  };

  const commandRows = (q: string): Row[] => {
    const all = allCommands().filter((c) => !c.hidden);
    const sel = selectionCount() > 0;
    if (!q.trim()) {
      const out: Row[] = [];
      const seen = new Set<string>();
      const add = (c: Command | undefined, group: string) => {
        if (!c || c.hidden || seen.has(c.id)) return;
        seen.add(c.id);
        out.push(commandRow(c, undefined, group));
      };
      paletteUse.recent(5).forEach((id) => add(commandById(id), "Recent"));
      if (sel) all.filter((c) => NEEDS_SELECTION.has(c.id)).forEach((c) => add(c, `For the ${selectionCount()} selected`));
      all.forEach((c) => add(c, "All commands"));
      return out;
    }
    const scored = (c: Command) => paletteUse.boost(c.id) + (sel && NEEDS_SELECTION.has(c.id) ? 4 : 0) - ((c.when && !c.when()) || (!sel && NEEDS_SELECTION.has(c.id)) ? 100 : 0);
    return fuzzyRank(q, all, (c: Command) => `${c.category}: ${c.title}`, scored).map(({ item, match }) => commandRow(item, match));
  };

  // Subfolders of the folder being typed, for completing a path.
  const typed = createMemo(() => {
    const p = parsed();
    if (p.mode !== "go" || !looksLikePath(p.query)) return null;
    const home_ = home();
    const expanded = expandTyped(p.query, home_, home_ ? { USERPROFILE: home_ } : {});
    return { expanded, ...splitTyped(expanded) };
  });
  const [children] = createResource(
    () => typed()?.parent || undefined,
    (parent) => subfolders(parent).catch(() => [] as string[]),
  );

  const fileRows = (q: string): Row[] => {
    const t = tab();
    if (!t || !q.trim()) return [];
    const l = t.listing();
    const idx: number[] = [];
    for (let i = 0; i < Math.min(l.count, FILE_SCAN_LIMIT); i++) idx.push(i);
    return fuzzyRank(q, idx, (i) => l.names[i]).slice(0, MAX_FILES).map(({ item: i, match }) => {
      const name = l.names[i];
      const full = t.pathOf(i);
      const dir = isDir(l, i);
      const open = () => {
        finish();
        A.openEntry(t, i);
      };
      return {
        key: `file:${full}`,
        label: name,
        group: "In this folder",
        icon: () => <TypeIcon path={full} name={name} isDir={dir} size={16} />,
        match,
        path: full,
        folder: dir,
        copy: full,
        enterLabel: "Open",
        newTab: dir ? () => inNewTab(full) : undefined,
        second: () => {
          finish();
          t.setSelection(new Set([i]));
          t.setFocus(t.view().indexOf(i));
        },
        secondLabel: "Select here",
        props: () => {
          finish();
          ui.setPropertiesPaths([full]);
        },
        reveal: () => {
          finish();
          revealInExplorer(full).catch((e) => ui.toast(errorText(e)));
        },
        run: open,
      } satisfies Row;
    });
  };

  const goRows = (q: string): Row[] => {
    const rows: Row[] = [];
    const trimmed = q.trim();
    const seen = new Set<string>();
    const push = (r: Row) => {
      const k = r.path?.toLowerCase().replace(/\\+$/, "");
      if (k) {
        if (seen.has(k)) return;
        seen.add(k);
      }
      rows.push(r);
    };

    if (!trimmed) {
      sidebar.pins().slice(0, 6).forEach((p) => push(folderRow(p.path, { group: "Pinned", hint: p.label !== baseName(p.path) ? p.label : undefined })));
      sidebar.recent(6).forEach((r) => push(folderRow(r.path, { group: "Recent", hint: ago(r.last, Date.now()), forgettable: true })));
      (places()?.drives ?? []).forEach((d) => push(folderRow(d.root, { group: "Drives" })));
      paletteUse.recent(3).forEach((id) => {
        const c = commandById(id);
        if (c) rows.push(commandRow(c, undefined, "Recent commands"));
      });
      return rows;
    }

    const calc = calculate(trimmed);
    if (calc) {
      rows.push({
        key: "calc",
        label: `= ${calc.result}`,
        group: "Calculator",
        icon: () => <MaterialIcon name="calculate" size={16} />,
        hint: "Enter copies",
        enterLabel: "Copy result",
        copy: calc.copy,
        run: () => {
          finish();
          void A.writeClipboardText(calc.copy).then(() => ui.toast(`Copied ${calc.copy}`));
        },
      });
    }

    const t = typed();
    if (t) {
      rows.push({
        key: "open-typed",
        label: `Open ${trimmed}`,
        icon: () => iconForPath(trimmed),
        enterLabel: "Open",
        group: "Path",
        run: () =>
          resolvePath(t.expanded).then(
            (r) => go(r.dir, r.select),
            (e) => ui.toast(errorText(e)),
          ),
      });
      const names = children() ?? [];
      fuzzyRank(t.partial, names, (n) => n)
        .slice(0, 14)
        .forEach(({ item, match }) => {
          const full = joinPath(t.parent, item);
          // The highlight is on the name, which starts after the parent folder in the label.
          const off = full.length - item.length;
          push(folderRow(full, { group: "Folders here", match: { score: match.score, positions: match.positions.map((p) => p + off) } }));
        });
    }

    const scores = new Map<string, number>();
    const top = history.top(300);
    for (const v of top) scores.set(v.path.toLowerCase(), v.score);
    const candidates: string[] = [];
    const cand = new Set<string>();
    const add = (p: string) => {
      const k = p.toLowerCase();
      if (!cand.has(k)) {
        cand.add(k);
        candidates.push(p);
      }
    };
    top.forEach((v) => add(v.path));
    workspace.allTabs().forEach((x) => add(x.path()));
    sidebar.pins().forEach((p) => add(p.path));
    (places()?.folders ?? []).forEach((f) => add(f.path));
    (places()?.drives ?? []).forEach((d) => add(d.root));
    fuzzyRank(trimmed, candidates, (p) => p, (p) => Math.log2(1 + (scores.get(p.toLowerCase()) ?? 0)) * 6 + (isPinned(sidebar.pins(), p) ? 8 : 0))
      .slice(0, 30)
      .forEach(({ item, match }) => push(folderRow(item, { group: "Folders", match, forgettable: scores.has(item.toLowerCase()) })));

    if (!t) fileRows(trimmed).forEach((r) => push(r));

    if (!t) {
      rows.push(...guideRows(trimmed).map((r) => ({ ...r, key: "guide-search-go" })));
      const here = tab();
      rows.push({
        key: "search-here",
        label: `Search subfolders for "${trimmed}"`,
        group: "Search",
        icon: () => <IconSearch size={15} />,
        hint: here?.title(),
        enterLabel: "Search",
        run: () => {
          finish();
          void here?.runSearch(trimmed);
        },
      });
    }
    return rows;
  };

  const searchRows = (q: string): Row[] => {
    const here = tab();
    const trimmed = q.trim();
    return [
      {
        key: "search",
        label: trimmed ? `Search subfolders of ${here?.title() ?? "this folder"} for "${trimmed}"` : "Type what to search for in this folder and its subfolders",
        icon: () => <IconSearch size={15} />,
        disabled: trimmed ? undefined : "Type to search",
        hint: here ? here.path() : undefined,
        enterLabel: "Search",
        run: () => {
          finish();
          void here?.runSearch(trimmed);
        },
      },
    ];
  };

  const tabRows = (q: string): Row[] => {
    const entries: { paneId: string; tab: TabModel; pane: number }[] = [];
    workspace.paneIds().forEach((paneId, pane) => workspace.paneModel(paneId).tabs().forEach((t) => entries.push({ paneId, tab: t, pane })));
    const multi = workspace.paneCount() > 1;
    return fuzzyRank(q, entries, (e) => e.tab.path()).map(({ item, match }) => {
      const active = workspace.paneModel(item.paneId).activeTabId() === item.tab.id && workspace.activePaneId() === item.paneId;
      const pinned = workspace.tabMeta(item.tab.id).pinned;
      return {
        key: `tab:${item.tab.id}`,
        label: item.tab.path(),
        dimUntil: dimOf(item.tab.path()),
        icon: () => iconForPath(item.tab.path()),
        hint: [multi ? `Pane ${item.pane + 1}` : "", pinned ? "pinned" : "", active ? "current" : ""].filter(Boolean).join(" · ") || undefined,
        match,
        enterLabel: "Switch",
        path: item.tab.path(),
        folder: true,
        copy: item.tab.path(),
        run: () => {
          finish();
          workspace.selectTab(item.paneId, item.tab.id);
        },
      } satisfies Row;
    });
  };

  const pinRows = (q: string): Row[] => {
    const pins = sidebar.pins();
    if (pins.length === 0) return [{ key: "no-pins", label: "Nothing pinned yet: press Ctrl+D on a folder here to pin it", disabled: "No pins", run: () => {} }];
    return fuzzyRank(q, pins, (p) => `${p.label} ${p.path}`).map(({ item }) => {
      const m = fuzzyRank(q, [item.path], (p) => p)[0]?.match;
      return folderRow(item.path, { hint: item.label !== baseName(item.path) ? item.label : undefined, match: m, pinned: true });
    });
  };

  const shellRows = (q: string): Row[] => {
    const t = tab();
    const cmd = q.trim();
    const dir = t?.path() ?? "C:\\";
    const run = (shell: "cmd" | "powershell") => () => {
      finish();
      runCustomAction(cmd, dir, true, shell, false, false).catch((e) => ui.toast(errorText(e)));
    };
    const disabled = !cmd ? "Type a command" : t?.archive() ? "Not inside an archive" : undefined;
    return [
      { key: "sh-cmd", label: cmd ? `cmd: ${cmd}` : "Type a command to run in this folder", group: "Run in", hint: dir, icon: () => <MaterialIcon name="terminal" size={16} />, disabled, enterLabel: "Run in cmd", run: run("cmd") },
      { key: "sh-ps", label: cmd ? `PowerShell: ${cmd}` : "PowerShell", hint: dir, icon: () => <MaterialIcon name="terminal" size={16} />, disabled, enterLabel: "Run in PowerShell", run: run("powershell") },
    ];
  };

  const guideRows = (q: string): Row[] => {
    const words = q.trim();
    return [
      {
        key: "guide-search",
        label: words ? `Search the guide for "${words}"` : "Type what to look up in the Octopolis guide",
        group: "Guide",
        icon: () => <MaterialIcon name="menu_book" size={16} />,
        hint: "Opens in your browser",
        enterLabel: "Search",
        run: () => {
          finish();
          void guide.open(null, words || null);
        },
      },
    ];
  };

  const helpRows = (): Row[] => [
    ...MODE_PREFIXES.filter((m) => m.mode !== "help").map((m) => ({
      key: `help:${m.prefix}`,
      label: `${m.prefix}   ${m.label}`,
      hint: m.hint,
      enterLabel: "Use",
      run: () => pick(m.prefix),
    })),
    { key: "help:calc", label: "12*8  or  5 mb in kb", hint: "A calculator and unit converter, no prefix needed", enterLabel: "Try", run: () => pick("12*8") },
    { key: "help:guide", label: "Open the Octopolis guide", hint: "F1", enterLabel: "Open", run: () => { finish(); void guide.open("palette"); } },
    { key: "help:keys", label: "Keys", hint: "The bar below lists what each key does for the highlighted row", run: () => {} },
  ];

  const pick = (value: string) => {
    setText(value);
    setHot(0);
    input.focus();
  };

  const rows = createMemo(() => {
    const { mode, query } = parsed();
    const all =
      mode === "commands" ? commandRows(query)
      : mode === "search" ? searchRows(query)
      : mode === "tabs" ? tabRows(query)
      : mode === "pins" ? pinRows(query)
      : mode === "shell" ? shellRows(query)
      : mode === "guide" ? guideRows(query)
      : mode === "help" ? helpRows()
      : goRows(query);
    return all.slice(0, MAX_ROWS);
  });

  const hotRow = (): Row | undefined => rows()[Math.min(hot(), rows().length - 1)];
  const runRow = (r: Row | undefined) => {
    if (!r) return;
    if (r.disabled) return ui.toast(r.disabled);
    r.run();
  };
  const alt = (fn?: () => void) => fn?.();

  createEffect(() => {
    const i = Math.min(hot(), rows().length - 1);
    queueMicrotask(() => list?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" }));
  });

  const move = (to: number) => setHot(Math.max(0, Math.min(to, rows().length - 1)));

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    const key = e.key;
    const lower = key.toLowerCase();
    const r = hotRow();
    const noSelection = input.selectionStart === input.selectionEnd;
    if (key === "Escape") return ui.closePalette();
    if (key === "F1") {
      e.preventDefault();
      return void guide.open("palette");
    }
    if (key === "ArrowDown" || (e.ctrlKey && (lower === "n" || lower === "j"))) move(hot() + 1);
    else if (key === "ArrowUp" || (e.ctrlKey && (lower === "k" || (lower === "p" && !e.shiftKey)))) move(hot() - 1);
    else if (key === "PageDown") move(hot() + PAGE);
    else if (key === "PageUp") move(hot() - PAGE);
    else if (key === "Home" && (e.ctrlKey || !text())) move(0);
    else if (key === "End" && (e.ctrlKey || !text())) move(rows().length - 1);
    else if (key === "Tab") {
      if (r?.complete && !e.shiftKey) pick(r.complete);
    } else if (key === "Enter") {
      if (e.altKey && e.shiftKey) alt(r?.reveal);
      else if (e.altKey) alt(r?.props);
      else if (e.shiftKey) r?.newTab ? alt(r.newTab) : runRow(r);
      else if (e.ctrlKey) r?.second ? alt(r.second) : runRow(r);
      else runRow(r);
    } else if (e.ctrlKey && lower === "c" && noSelection && r?.copy) {
      void A.writeClipboardText(r.copy).then(() => ui.toast(r.key === "calc" ? `Copied ${r.copy}` : "Copied path"));
    } else if (e.ctrlKey && lower === "d" && r?.folder && r.path) {
      sidebar.togglePin(r.path);
      ui.toast(isPinned(sidebar.pins(), r.path) ? "Pinned to the sidebar" : "Unpinned");
    } else if (key === "Delete" && e.shiftKey && r?.forgettable && r.path) {
      history.forget(r.path);
      ui.toast("Removed from history");
    } else return;
    e.preventDefault();
  };

  const hints = createMemo(() => {
    const r = hotRow();
    if (!r) return [];
    const out: { keys: string; label: string }[] = [{ keys: "Enter", label: r.disabled ? "Unavailable" : r.enterLabel ?? "Select" }];
    if (r.newTab) out.push({ keys: "Shift+Enter", label: "New tab" });
    if (r.second) out.push({ keys: "Ctrl+Enter", label: r.secondLabel ?? "Other" });
    if (r.complete) out.push({ keys: "Tab", label: "Complete" });
    if (r.props) out.push({ keys: "Alt+Enter", label: "Properties" });
    if (r.copy) out.push({ keys: "Ctrl+C", label: r.key === "calc" ? "Copy result" : "Copy path" });
    if (r.folder && r.path) out.push({ keys: "Ctrl+D", label: isPinned(sidebar.pins(), r.path) ? "Unpin" : "Pin" });
    if (r.forgettable) out.push({ keys: "Shift+Del", label: "Forget" });
    return out;
  });

  const modeName = () => (parsed().mode === "go" && text() ? (typed() ? "Path" : "Go to") : MODE_LABELS[parsed().mode]);

  return (
    <div class="scrim palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && ui.closePalette()}>
      <div class="palette" role="dialog" aria-label="Command palette">
        <div class="palette-bar">
          <span class="palette-mode" classList={{ plain: parsed().mode === "go" }}>{modeName()}</span>
          <input
            ref={(el) => {
              input = el;
              queueMicrotask(() => {
                input.focus();
                // A remembered query is selected, so typing replaces it.
                if (remembered) input.select();
              });
            }}
            class="palette-input"
            value={text()}
            placeholder={PLACEHOLDERS[parsed().mode]}
            spellcheck={false}
            aria-label="Command palette"
            onInput={(e) => {
              setText(e.currentTarget.value);
              last.text = e.currentTarget.value;
              last.at = Date.now();
              setHot(0);
            }}
            onKeyDown={onKey}
          />
        </div>
        <div class="palette-list" role="listbox" ref={list}>
          <For each={rows()}>
            {(r, i) => (
              <>
                <Show when={r.group && r.group !== rows()[i() - 1]?.group}>
                  <div class="palette-group">{r.group}</div>
                </Show>
                <div
                  class="palette-row"
                  role="option"
                  data-i={i()}
                  aria-selected={hot() === i()}
                  aria-disabled={r.disabled ? true : undefined}
                  classList={{ hot: hot() === i(), disabled: !!r.disabled }}
                  onMouseMove={(e) => {
                    // The list moving under a still pointer also fires mousemove: only a real move picks a row.
                    const first = pointer.x < 0;
                    const same = e.clientX === pointer.x && e.clientY === pointer.y;
                    pointer.x = e.clientX;
                    pointer.y = e.clientY;
                    if (first || same) return;
                    if (hot() !== i()) setHot(i());
                  }}
                  onClick={() => runRow(r)}
                >
                  <span class="palette-main">
                    <Show when={r.icon}>
                      <span class="palette-icon" aria-hidden="true">{r.icon!()}</span>
                    </Show>
                    <Highlight text={r.label} positions={r.match?.positions} dimUntil={r.dimUntil} />
                    <Show when={r.pinned}>
                      <span class="palette-pin" title="Pinned" aria-label="Pinned"><IconPin size={12} /></span>
                    </Show>
                  </span>
                  <Show when={r.hint}>
                    <span class="palette-hint">{r.hint}</span>
                  </Show>
                  <Show when={!r.disabled && r.keys}>
                    <kbd>{r.keys}</kbd>
                  </Show>
                  <Show when={r.assignShortcut}>
                    <button
                      type="button"
                      class="palette-row-action"
                      data-tooltip="Assign shortcut"
                      aria-label={`Assign shortcut for ${r.label}`}
                      tabIndex={-1}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        r.assignShortcut!();
                      }}
                    >
                      <MaterialIcon name="keyboard" size={14} />
                    </button>
                  </Show>
                </div>
              </>
            )}
          </For>
          <Show when={rows().length === 0}>
            <div class="palette-empty">No matches. Press ? for the other modes</div>
          </Show>
        </div>
        <div class="palette-foot" aria-hidden="true">
          <For each={hints()}>
            {(h) => (
              <span class="palette-key">
                <kbd>{h.keys}</kbd> {h.label}
              </span>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
