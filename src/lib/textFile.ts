// Saving text as a file and reading a small text file back, for sharing settings-like data.
const MAX_BYTES = 256 * 1024;

export function downloadText(filename: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The text of a chosen file; refuses big ones, since what is shared this way is small. */
export async function readTextFile(file: File): Promise<string> {
  if (file.size > MAX_BYTES) throw new Error("That file is too big");
  return file.text();
}
