import { describe, expect, it } from "vitest";
import { ACTION_PRESETS } from "./actionPresets";
import { actionApplies, actionsToJson, expandCommand, leadingProgram, NEW_ACTION, parseActions, parseActionsText, parseExtensions, placeholderNeeds, uniqueActionName, wildcardMatcher, type CustomAction } from "./customActions";

const act = (patch: Partial<CustomAction> = {}): CustomAction => ({ ...NEW_ACTION, id: "x", name: "A", command: "c", ...patch });
const file = (name: string) => ({ name, isDir: false });
const dir = (name: string) => ({ name, isDir: true });

describe("expandCommand", () => {
  it("quotes paths for cmd and fills the name parts", () => {
    expect(expandCommand('ffmpeg -i {path} "{stem}.mp4"', ["C:\\v\\My clip.mov"], "C:\\v")).toBe('ffmpeg -i "C:\\v\\My clip.mov" "My clip.mp4"');
    expect(expandCommand("code {paths}", ["C:\\a", "C:\\b"], "C:\\")).toBe('code "C:\\a" "C:\\b"');
    expect(expandCommand("wt -d {dir}", [], "D:\\x")).toBe('wt -d "D:\\x"');
    expect(expandCommand("{parent} {ext} {name}", ["C:\\v\\a.tar.gz"], "C:\\v")).toBe('"C:\\v" gz a.tar.gz');
  });
  it("keeps a trailing backslash from swallowing the closing quote", () => {
    expect(expandCommand("wt -d {dir}", [], "C:\\")).toBe('wt -d "C:\\."');
    expect(expandCommand("{parent}", ["C:\\a.txt"], "C:\\")).toBe('"C:\\."');
  });
  it("uses single quotes for PowerShell and doubles quotes inside", () => {
    expect(expandCommand("gci {path}", ["C:\\it's\\$x"], "C:\\", { shell: "powershell" })).toBe("gci 'C:\\it''s\\$x'");
    expect(expandCommand("{pslist}", ["C:\\a", "C:\\b"], "C:\\", { shell: "powershell" })).toBe("'C:\\a','C:\\b'");
    expect(expandCommand("'{stem}.zip'", ["C:\\o'k.txt"], "C:\\", { shell: "powershell" })).toBe("'o''k.zip'");
  });
  it("fills prompts, the chosen folder and the list file", () => {
    const out = expandCommand("copy {path} {pickfolder} /{prompt:Tag}/ {list}", ["C:\\a"], "C:\\", { prompts: { Tag: "x\ny" }, folder: "D:\\out", list: "C:\\t\\l.txt" });
    expect(out).toBe('copy "C:\\a" "D:\\out" /x y/ "C:\\t\\l.txt"');
    expect(placeholderNeeds("a {prompt:One} {prompt:One} {prompt:Two} {pickfolder} {list}")).toEqual({ prompts: ["One", "Two"], pickFolder: true, list: true });
    expect(placeholderNeeds("plain")).toEqual({ prompts: [], pickFolder: false, list: false });
  });
});

describe("actionApplies", () => {
  it("matches by file type, kind, name pattern and count", () => {
    const conv = act({ extensions: ["mov", "mkv"] });
    expect(actionApplies(conv, [file("x.MOV"), file("y.mkv")])).toBe(true);
    expect(actionApplies(conv, [file("x.mov"), file("y.txt")])).toBe(false);
    expect(actionApplies(conv, [dir("clips.mov")])).toBe(false);
    expect(actionApplies(act({ target: "files" }), [file("a"), dir("b")])).toBe(false);
    expect(actionApplies(act({ target: "folders" }), [dir("a")])).toBe(true);
    expect(actionApplies(act({ namePattern: "*.log; report?.txt" }), [file("a.LOG"), file("report1.txt")])).toBe(true);
    expect(actionApplies(act({ namePattern: "*.log" }), [file("a.txt")])).toBe(false);
    expect(actionApplies(act({ minItems: 2 }), [file("a")])).toBe(false);
    expect(actionApplies(act({ maxItems: 1 }), [file("a"), file("b")])).toBe(false);
    expect(actionApplies(act({ minItems: 1, maxItems: 3 }), [file("a"), file("b")])).toBe(true);
  });
  it("needs an enabled action, and allows an empty selection only when nothing narrows it", () => {
    expect(actionApplies(act({ enabled: false }), [file("a")])).toBe(false);
    expect(actionApplies(act(), [])).toBe(true);
    expect(actionApplies(act({ minItems: 1 }), [])).toBe(false);
    expect(actionApplies(act({ extensions: ["txt"] }), [])).toBe(false);
    expect(actionApplies(act({ target: "files" }), [])).toBe(false);
  });
  it("matches wildcards literally apart from * and ?", () => {
    expect(wildcardMatcher("a+b.(1)*")("A+B.(1)xyz")).toBe(true);
    expect(wildcardMatcher("a+b")("aab")).toBe(false);
    expect(wildcardMatcher("")("anything")).toBe(true);
    expect(parseExtensions(" mp4, .MOV;mkv mp4")).toEqual(["mp4", "mov", "mkv"]);
  });
});

describe("parsing and sharing", () => {
  it("loads old saves (four fields) with defaults, and drops unusable entries", () => {
    const [a, ...rest] = parseActions([{ name: "Old", command: "dir", extensions: ["TXT"], mode: "console" }, { name: "", command: "x" }, { name: "n" }, 5, null]);
    expect(rest).toEqual([]);
    expect(a).toMatchObject({ name: "Old", command: "dir", extensions: ["txt"], mode: "console", enabled: true, shell: "cmd", target: "any", minItems: 0, maxItems: 0, refresh: true, elevate: false, each: false });
    expect(a.id.length).toBeGreaterThan(3);
  });
  it("clamps bad values and keeps ids unique", () => {
    const list = parseActions([{ id: "same", name: "A", command: "c", minItems: -4, maxItems: "9", shell: "bash", target: "x" }, { id: "same", name: "B", command: "c" }]);
    expect(list[0]).toMatchObject({ minItems: 0, maxItems: 0, shell: "cmd", target: "any" });
    expect(list[0].id).not.toBe(list[1].id);
  });
  it("round-trips through JSON without ids, giving imports fresh ones", () => {
    const src = [act({ id: "k1", name: "One", shell: "powershell", elevate: true }), act({ id: "k2", name: "Two" })];
    const text = actionsToJson(src);
    expect(text).not.toContain("k1");
    const back = parseActionsText(text);
    expect(back.map((a) => a.name)).toEqual(["One", "Two"]);
    expect(back[0]).toMatchObject({ shell: "powershell", elevate: true });
    expect(back[0].id).not.toBe("k1");
    expect(parseActionsText(JSON.stringify({ name: "Solo", command: "dir" }))).toHaveLength(1);
    expect(() => parseActionsText("{")).toThrow("valid JSON");
    expect(() => parseActionsText("[]")).toThrow();
  });
  it("makes names unique", () => {
    expect(uniqueActionName("Zip", ["zip", "Zip 2"])).toBe("Zip 3");
    expect(uniqueActionName("Zip", [])).toBe("Zip");
  });
  it("names the program worth checking", () => {
    expect(leadingProgram("notepad {path}", "cmd")).toBe("notepad");
    expect(leadingProgram('"C:\\Tools\\x.exe" a', "cmd")).toBe("C:\\Tools\\x.exe");
    expect(leadingProgram("echo hi", "cmd")).toBeNull();
    expect(leadingProgram("Get-Date", "powershell")).toBeNull();
    expect(leadingProgram("%COMSPEC% /c x", "cmd")).toBeNull();
  });
});

describe("presets", () => {
  it("have unique names and only use cmd or PowerShell", () => {
    const names = ACTION_PRESETS.map((p) => p.action.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    const thirdParty = /\b(ffmpeg|git|code|npm|node|python|7z|pandoc|magick|curl|wget)\b/i;
    for (const p of ACTION_PRESETS) {
      expect(p.action.command, p.action.name).not.toMatch(thirdParty);
      expect(["cmd", "powershell"]).toContain(p.action.shell);
      expect(p.description.length).toBeGreaterThan(10);
    }
  });
  it("ask before anything that needs administrator rights", () => {
    for (const p of ACTION_PRESETS.filter((x) => x.action.elevate)) expect(p.action.confirm || p.action.mode === "console", p.action.name).toBe(true);
  });
  it("only use placeholders that exist, and survive a round trip through the parser", () => {
    for (const p of ACTION_PRESETS) {
      const out = expandCommand(p.action.command, ["C:\\a\\b.txt"], "C:\\a", { shell: p.action.shell, prompts: {}, list: "x", folder: "y" });
      expect(out.match(/\{(path|paths|pslist|dir|parent|name|stem|ext|list|pickfolder|prompt:[^}]*)\}/g), p.action.name).toBeNull();
      expect(parseActions([{ ...p.action, id: "t" }])[0], p.action.name).toMatchObject({ name: p.action.name, shell: p.action.shell, elevate: p.action.elevate });
    }
  });
});
