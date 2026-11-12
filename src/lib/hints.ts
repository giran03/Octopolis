// Which shortcuts are worth showing for what is selected, as command ids in the order they matter.
// The status bar turns each id into the key the user actually has bound (so custom shortcuts show up).

export interface HintContext {
  readonly count: number;
  readonly folders: number;
  readonly files: number;
  /** Looking inside an archive: items can be extracted but not changed. */
  readonly archive: boolean;
  /** Search results or the flat view, where the folder an item lives in is not the one on screen. */
  readonly search: boolean;
  readonly canPaste: boolean;
  readonly git: boolean;
}

export interface Hint {
  readonly id: string;
  readonly label: string;
}

const h = (id: string, label: string): Hint => ({ id, label });

/** Hints for the current selection, most useful first. Empty when nothing is selected. */
export function hintsFor(c: HintContext): readonly Hint[] {
  if (c.count === 0) return [];
  const single = c.count === 1;
  const out: Hint[] = [];

  if (c.archive) {
    out.push(h("file.open", single && c.folders === 1 ? "Open folder" : "Open"), h("file.extract", "Extract"), h("file.copyPath", "Copy path"), h("file.properties", "Properties"));
    return out;
  }

  if (single) out.push(h("file.open", c.folders === 1 ? "Open folder" : "Open"));
  else out.push(h("file.open", `Open ${c.count.toLocaleString()}`));

  if (single) out.push(h("file.rename", "Rename"));
  else out.push(h("file.batchRename", "Batch rename"));

  out.push(h("file.copy", "Copy"), h("file.cut", "Cut"));
  if (c.canPaste) out.push(h("file.paste", c.folders === 1 && single ? "Paste into" : "Paste"));
  out.push(h("file.delete", "Recycle"));

  if (single && c.files === 1) out.push(h("view.quickLook", "Quick look"), h("file.openWith", "Open with"));
  if (single && c.folders === 1) out.push(h("sidebar.pin", "Pin to sidebar"));
  if (c.search) out.push(h("file.reveal", "Show in Explorer"));
  if (c.git) out.push(h("git.stage", "Stage"), h("git.unstage", "Unstage"));

  out.push(h("file.compress", "Zip"), h("shelf.add", "Add to shelf"), h("file.tags", "Tags"), h("file.copyPath", "Copy path"));
  if (!single) out.push(h("file.invertSelection", "Invert selection"));
  else out.push(h("file.selectSameType", "Select same type"));
  out.push(h("file.properties", "Properties"));
  return out;
}
