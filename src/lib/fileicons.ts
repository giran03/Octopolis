// Which icon-font glyph and color stand for each file type Octopolis supports.
// Types not listed here keep the Windows icon (or the generic glyph for their category).

export interface FileIconSpec {
  /** Segoe Fluent Icons code point, as hex. */
  readonly code: string;
  /** Color name; styled as `.ft-<tone>`. */
  readonly tone: string;
}

const SPECS = new Map<string, FileIconSpec>();
const add = (exts: string, code: string, tone: string) => {
  for (const ext of exts.split(" ")) SPECS.set(ext, { code, tone });
};

// Source code, one color per language family.
add("rs", "E943", "rust");
add("ts tsx mts cts", "E943", "blue");
add("js jsx mjs cjs", "E943", "yellow");
add("json jsonc json5", "E943", "amber");
add("py pyw ipynb", "E943", "python");
add("go", "E943", "cyan");
add("c h cpp cc cxx hpp hxx", "E943", "indigo");
add("cs", "E943", "violet");
add("java", "E943", "red");
add("kt kts", "E943", "violet");
add("swift", "E943", "orange");
add("rb", "E943", "red");
add("php", "E943", "indigo");
add("lua", "E943", "blue");
add("css scss sass less", "E943", "blue");
add("html htm", "E943", "orange");
add("xml xaml svgz", "E943", "teal");
add("sql", "E943", "slate");
add("md markdown mdx", "E8A5", "slate");
add("toml yaml yml ini cfg conf env", "E713", "tan");
add("sh bash zsh ps1 bat cmd", "E756", "green");

// Documents.
add("pdf", "E8A5", "red");
add("doc docx odt rtf", "E8A5", "blue");
add("txt log", "E8A5", "grey");
add("xls xlsx ods", "E9D9", "green");
add("csv tsv", "E8FD", "green");
add("ppt pptx odp", "E7F4", "orange");
add("epub mobi", "E8F1", "violet");

// Pictures, sound and video.
add("png jpg jpeg gif webp bmp tif tiff heic avif ico", "E91B", "violet");
add("svg", "E91B", "orange");
add("psd psb ai", "E91B", "blue");
add("mp3 wav flac ogg m4a aac opus wma", "E8D6", "pink");
add("mp4 mkv mov avi webm wmv m4v", "E714", "orange");

// Archives, disc images, 3D models, fonts and programs.
add("zip 7z rar tar gz tgz bz2 xz zst cab", "E7B8", "tan");
add("iso img", "E958", "grey");
add("glb gltf obj stl fbx 3mf", "F158", "teal");
add("ttf otf woff woff2", "E8D2", "grey");
add("exe msi appx msix", "F012", "blue");
add("dll sys", "F012", "grey");
add("lnk url", "E71B", "grey");

/** The icon for a file name, or null when Octopolis has no specific icon for its type. */
export function fileIconSpec(name: string): FileIconSpec | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return SPECS.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

/** Every extension that has a specific icon, for tests and settings text. */
export const ICON_EXTENSIONS: readonly string[] = [...SPECS.keys()];
