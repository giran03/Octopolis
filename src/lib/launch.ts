// What a launch argument asks to open: a real path, a known folder, or a
// Windows shell location Octopolis can't show (handed to File Explorer).

/** `shell:` names Windows uses for folders Octopolis knows, mapped to known-folder ids. */
const SHELL_NAMES: Readonly<Record<string, string>> = {
  profile: "home",
  usersfilesfolder: "home",
  desktop: "desktop",
  personal: "documents",
  documents: "documents",
  "my documents": "documents",
  downloads: "downloads",
  "my pictures": "pictures",
  pictures: "pictures",
  "my music": "music",
  music: "music",
  "my video": "videos",
  videos: "videos",
};

export type LaunchTarget =
  | { readonly kind: "path"; readonly path: string }
  /** A known folder id, or "start" for Octopolis's own start folder. */
  | { readonly kind: "known"; readonly id: string }
  | { readonly kind: "explorer"; readonly arg: string };

/** The "This PC" shell object that Win+E opens. */
export const THIS_PC = "::{20d04fe0-3aea-1069-a2d8-08002b30309d}";

export function classifyTarget(arg: string): LaunchTarget {
  const lower = arg.trim().toLowerCase();
  if (lower === THIS_PC || lower === `shell:${THIS_PC}`) return { kind: "known", id: "start" };
  if (lower.startsWith("shell:")) {
    const id = SHELL_NAMES[lower.slice(6).replace(/[\\/]+$/, "")];
    return id ? { kind: "known", id } : { kind: "explorer", arg };
  }
  // Other shell objects (Control Panel, Network, Printers…) stay in Explorer.
  if (lower.startsWith("::{")) return { kind: "explorer", arg };
  return { kind: "path", path: arg };
}

/** The `content:` term of a search query (quotes removed), if any. */
export function contentTerm(query: string): string | null {
  const m = /(?:^|\s)content:(?:"([^"]*)"?|(\S+))/i.exec(query);
  const term = (m?.[1] ?? m?.[2] ?? "").trim();
  return term || null;
}
