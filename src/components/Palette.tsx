// Command palette: Ctrl+P jumps to folders (frecency + fuzzy), ">" or
// Ctrl+Shift+P runs commands.
import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js";
import { COMMANDS, type Command } from "../commands";
import { inferPathIsDir } from "../lib/format";
import { fuzzyRank, type FuzzyMatch } from "../lib/fuzzy";
import { errorText, knownFolders, listDrives, resolvePath, type Drive, type KnownFolder } from "../lib/ipc";
import { formatKeys } from "../lib/keymap";
import { baseName, isRoot } from "../lib/paths";
import { history } from "../state/history";
import { keybindings } from "../state/keybindings";
import { ui } from "../state/ui";
import { workspace } from "../state/workspace";
import { IconDrive, IconSearch, PathIcon, PlaceGlyph, TypeIcon } from "./Icons";

const MAX_ROWS = 60;

interface Row {
  readonly key: string;
  readonly label: string;
  readonly icon?: () => JSX.Element;
  readonly hint?: string;
  readonly match?: FuzzyMatch;
  readonly run: () => void;
}

function Highlight(props: { text: string; positions?: readonly number[] }): JSX.Element {
  const marks = () => new Set(props.positions ?? []);
  return (
    <span>
      <For each={[...props.text]}>{(ch, i) => (marks().has(i()) ? <mark>{ch}</mark> : ch)}</For>
    </span>
  );
}

const looksLikePath = (s: string) => /^([a-z]:|\\\\|~|%)/i.test(s.trim());

export function Palette() {
  let input!: HTMLInputElement;
  const [text, setText] = createSignal(ui.palette() === "commands" ? ">" : "");
  const [hot, setHot] = createSignal(0);
  const [places] = createResource(async () => {
    const [folders, drives] = await Promise.all([knownFolders().catch(() => []), listDrives().catch(() => [])]);
    return { folders, drives };
  });

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

  const go = (path: string, select?: string | null) => {
    ui.closePalette();
    void workspace.activeTab()?.navigate(path, select ? [select] : undefined);
  };

  const commandRows = (q: string): Row[] =>
    fuzzyRank(q, COMMANDS.filter((c) => !c.hidden), (c: Command) => `${c.category}: ${c.title}`).map(({ item, match }) => ({
      key: item.id,
      label: `${item.category}: ${item.title}`,
      hint: keybindings.keysFor(item).map(formatKeys).join("  "),
      match,
      run: () => {
        ui.closePalette();
        item.run();
      },
    }));

  const folderRows = (q: string): Row[] => {
    const scores = new Map<string, number>();
    for (const v of history.top(300)) scores.set(v.path.toLowerCase(), v.score);
    const seen = new Set<string>();
    const candidates: string[] = [];
    const add = (p: string) => {
      const k = p.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        candidates.push(p);
      }
    };
    history.top(300).forEach((v) => add(v.path));
    workspace.allTabs().forEach((t) => add(t.path()));
    (places()?.folders ?? []).forEach((f) => add(f.path));
    (places()?.drives ?? []).forEach((d) => add(d.root));
    const rows: Row[] = fuzzyRank(q, candidates, (p) => p, (p) => Math.log2(1 + (scores.get(p.toLowerCase()) ?? 0)) * 6).map(({ item, match }) => ({
      key: item,
      label: item,
      icon: () => iconForPath(item),
      match,
      run: () => go(item),
    }));
    const trimmed = q.trim();
    if (looksLikePath(trimmed)) {
      rows.unshift({
        key: "open-typed",
        label: `Open ${trimmed}`,
        icon: () => iconForPath(trimmed),
        run: () =>
          resolvePath(trimmed).then(
            (r) => go(r.dir, r.select),
            (e) => ui.toast(errorText(e)),
          ),
      });
    } else if (trimmed) {
      const tab = workspace.activeTab();
      rows.push({
        key: "search-here",
        label: `Search subfolders for "${trimmed}"`,
        icon: () => <IconSearch size={15} />,
        hint: tab?.title(),
        run: () => {
          ui.closePalette();
          void tab?.runSearch(trimmed);
        },
      });
    }
    return rows;
  };

  const rows = createMemo(() => {
    const t = text();
    return (t.startsWith(">") ? commandRows(t.slice(1)) : folderRows(t)).slice(0, MAX_ROWS);
  });

  const runHot = () => rows()[Math.min(hot(), rows().length - 1)]?.run();

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") ui.closePalette();
    else if (e.key === "ArrowDown") setHot((h) => Math.min(h + 1, rows().length - 1));
    else if (e.key === "ArrowUp") setHot((h) => Math.max(h - 1, 0));
    else if (e.key === "Enter") runHot();
    else return;
    e.preventDefault();
  };

  return (
    <div class="scrim palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && ui.closePalette()}>
      <div class="palette" role="dialog" aria-label="Command palette">
        <input
          ref={(el) => {
            input = el;
            queueMicrotask(() => input.focus());
          }}
          class="palette-input"
          value={text()}
          placeholder={text().startsWith(">") ? "Type a command" : "Go to folder, type a path, or > for commands"}
          spellcheck={false}
          onInput={(e) => {
            setText(e.currentTarget.value);
            setHot(0);
          }}
          onKeyDown={onKey}
        />
        <div class="palette-list" role="listbox">
          <For each={rows()}>
            {(r, i) => (
              <button
                class="palette-row"
                role="option"
                aria-selected={hot() === i()}
                classList={{ hot: hot() === i() }}
                onMouseEnter={() => setHot(i())}
                onClick={() => r.run()}
              >
                <span class="palette-main">
                  <Show when={r.icon}>
                    <span class="palette-icon" aria-hidden="true">{r.icon!()}</span>
                  </Show>
                  <Highlight text={r.label} positions={r.match?.positions} />
                </span>
                <Show when={r.hint}>
                  <kbd>{r.hint}</kbd>
                </Show>
              </button>
            )}
          </For>
          <Show when={rows().length === 0}>
            <div class="palette-empty">No matches</div>
          </Show>
        </div>
      </div>
    </div>
  );
}
