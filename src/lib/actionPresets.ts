// Ready-made custom actions. Every one uses only what ships with Windows (cmd and PowerShell), so it works on a clean PC.
// PowerShell commands may use {pslist} for the selection as a PowerShell list of quoted paths.
import { NEW_ACTION, type CustomAction } from "./customActions";

export type PresetGroup = "Copy" | "Files" | "Open" | "System";

export interface ActionPreset {
  readonly group: PresetGroup;
  readonly description: string;
  readonly action: Omit<CustomAction, "id">;
}

const ps = (name: string, command: string, extra: Partial<CustomAction> = {}): Omit<CustomAction, "id"> => {
  const { id: _id, ...base } = NEW_ACTION;
  return { ...base, name, command, shell: "powershell", ...extra };
};
const cmd = (name: string, command: string, extra: Partial<CustomAction> = {}): Omit<CustomAction, "id"> => {
  const { id: _id, ...base } = NEW_ACTION;
  return { ...base, name, command, shell: "cmd", ...extra };
};

export const PRESET_GROUPS: readonly { id: PresetGroup; title: string }[] = [
  { id: "Copy", title: "Copy to the clipboard" },
  { id: "Files", title: "Files and folders" },
  { id: "Open", title: "Open" },
  { id: "System", title: "System (some ask for administrator)" },
];

export const ACTION_PRESETS: readonly ActionPreset[] = [
  {
    group: "Copy",
    description: "Puts the full path of each selected item on the clipboard, one per line.",
    action: ps("Copy full path", "[string]::Join([Environment]::NewLine, @({pslist})) | Set-Clipboard", { refresh: false }),
  },
  {
    group: "Copy",
    description: "Puts the name of each selected item on the clipboard, one per line.",
    action: ps("Copy name", "(@({pslist}) | ForEach-Object { Split-Path $_ -Leaf }) -join [Environment]::NewLine | Set-Clipboard", { refresh: false }),
  },
  {
    group: "Copy",
    description: "Copies the path of the folder you are viewing.",
    action: ps("Copy this folder's path", "Set-Clipboard -Value {dir}", { refresh: false }),
  },
  {
    group: "Files",
    description: "Writes the SHA-256 of each selected file to SHA256SUMS.txt in this folder.",
    action: ps(
      "SHA-256 checksums",
      "Get-FileHash -Algorithm SHA256 -LiteralPath {pslist} | ForEach-Object { '{0}  {1}' -f $_.Hash.ToLower(), (Split-Path $_.Path -Leaf) } | Set-Content -Encoding UTF8 -LiteralPath (Join-Path {dir} 'SHA256SUMS.txt')",
      { target: "files", minItems: 1 },
    ),
  },
  {
    group: "Files",
    description: "Writes the MD5 of each selected file to MD5SUMS.txt in this folder.",
    action: ps(
      "MD5 checksums",
      "Get-FileHash -Algorithm MD5 -LiteralPath {pslist} | ForEach-Object { '{0}  {1}' -f $_.Hash.ToLower(), (Split-Path $_.Path -Leaf) } | Set-Content -Encoding UTF8 -LiteralPath (Join-Path {dir} 'MD5SUMS.txt')",
      { target: "files", minItems: 1 },
    ),
  },
  {
    group: "Files",
    description: "Compresses the selection into a zip next to it, named after the first item.",
    action: ps("Zip the selection", "Compress-Archive -LiteralPath {pslist} -DestinationPath (Join-Path {dir} '{stem}.zip') -Force", { minItems: 1 }),
  },
  {
    group: "Files",
    description: "Extracts each selected zip into a folder of the same name.",
    action: ps("Extract zip here", "Expand-Archive -LiteralPath {path} -DestinationPath (Join-Path {dir} '{stem}') -Force", { extensions: ["zip"], each: true }),
  },
  {
    group: "Files",
    description: "Removes the \"downloaded from the internet\" mark, so Windows stops warning about them.",
    action: ps("Unblock downloaded files", "Unblock-File -LiteralPath {pslist}", { target: "files", minItems: 1 }),
  },
  {
    group: "Files",
    description: "Clears the read-only flag.",
    action: cmd("Remove read-only", "attrib -R {paths}", { target: "files", minItems: 1 }),
  },
  {
    group: "Files",
    description: "Sets the read-only flag.",
    action: cmd("Make read-only", "attrib +R {paths}", { target: "files", minItems: 1 }),
  },
  {
    group: "Files",
    description: "Saves a list of the folder's contents (name, size, date) as listing.txt in this folder.",
    action: ps(
      "Save a folder listing",
      "Get-ChildItem -LiteralPath {path} -Force | Select-Object Name,Length,LastWriteTime | Format-Table -AutoSize | Out-String -Width 200 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path {dir} 'listing.txt')",
      { target: "folders", minItems: 1, maxItems: 1 },
    ),
  },
  {
    group: "Files",
    description: "Counts the files in a folder, with their total size. Shows the result in a console.",
    action: ps(
      "Count files and size",
      "Get-ChildItem -LiteralPath {path} -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum | Format-List Count,Sum",
      { target: "folders", minItems: 1, maxItems: 1, mode: "console", refresh: false },
    ),
  },
  {
    group: "Open",
    description: "Opens the selected text file in Notepad.",
    action: cmd("Open in Notepad", "notepad {path}", { target: "files", minItems: 1, maxItems: 1, refresh: false }),
  },
  {
    group: "Open",
    description: "Opens Windows Terminal here, or a command prompt if it is not installed.",
    action: cmd("Terminal here", 'where wt >nul 2>nul && (start "" wt -d {dir}) || (start "" /D {dir} cmd)', { refresh: false }),
  },
  {
    group: "Open",
    description: "Opens a PowerShell window in this folder.",
    action: cmd("PowerShell here", 'start "" /D {dir} powershell -NoExit', { refresh: false }),
  },
  {
    group: "System",
    description: "Opens a PowerShell window in this folder as administrator.",
    action: cmd("PowerShell here as administrator", 'start "" /D {dir} powershell -NoExit', { elevate: true, confirm: true, refresh: false }),
  },
  {
    group: "System",
    description: "Makes you the owner of the selection and gives you full control. Needs administrator.",
    action: ps(
      "Take ownership",
      "foreach ($p in @({pslist})) { takeown /F $p /R /D Y | Out-Null; icacls $p /grant ($env:USERNAME + ':(OI)(CI)F') /T | Out-Null }",
      { elevate: true, confirm: true, minItems: 1 },
    ),
  },
  {
    group: "System",
    description: "Scans the selection with Microsoft Defender. Needs administrator.",
    action: ps("Scan with Defender", "Start-MpScan -ScanType CustomScan -ScanPath {path}; Write-Host 'Scan finished.'", { elevate: true, mode: "console", minItems: 1, maxItems: 1, refresh: false }),
  },
  {
    group: "System",
    description: "Shows this PC's network addresses in a console.",
    action: cmd("Network info", "ipconfig /all", { mode: "console", refresh: false }),
  },
  {
    group: "System",
    description: "Clears the DNS cache. Needs administrator.",
    action: cmd("Flush DNS cache", "ipconfig /flushdns", { elevate: true, mode: "console", refresh: false }),
  },
];
