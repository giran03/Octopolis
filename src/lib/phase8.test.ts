import { describe, expect, it } from "vitest";
import { finishNotice, NOTIFY_AFTER_MS } from "./notify";
import { delimiterFor, parseDelimited, parseJsonl, sortRows, toTable } from "./table";

describe("table preview", () => {
  it("parses quoted cells, doubled quotes and CRLF", () => {
    expect(parseDelimited('a,b\r\n"x, y","say ""hi"""\r\n', ",")).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
    expect(parseDelimited('"multi\nline",2', ",")).toEqual([["multi\nline", "2"]]);
  });

  it("picks the delimiter", () => {
    expect(delimiterFor("a.tsv", "x,y")).toBe("\t");
    expect(delimiterFor("a.csv", "name;age;city\nx;1;y")).toBe(";");
    expect(delimiterFor("a.csv", "name,age")).toBe(",");
  });

  it("names missing headers and pads to the widest row", () => {
    const t = toTable("a.csv", "﻿name,\nann,3,extra");
    expect(t.header).toEqual(["name", "Column 2", "Column 3"]);
    expect(t.rows).toEqual([["ann", "3", "extra"]]);
  });

  it("turns JSON Lines into columns", () => {
    const t = parseJsonl('{"a":1,"b":{"c":2}}\n\n{"a":null,"d":"x"}\n42\nnot json');
    expect(t.header).toEqual(["a", "b", "d", "value", "(not JSON)"]);
    expect(t.rows[0]).toEqual(["1", '{"c":2}', "", "", ""]);
    expect(t.rows[2][3]).toBe("42");
    expect(t.rows[3][4]).toBe("not json");
  });

  it("sorts numbers by value, text naturally, empty cells last", () => {
    const rows = [["10"], ["9"], [""], ["1,5"]];
    expect(sortRows(rows, 0, false).map((r) => r[0])).toEqual(["1,5", "9", "10", ""]);
    expect(sortRows(rows, 0, true).map((r) => r[0])).toEqual(["10", "9", "1,5", ""]);
    expect(sortRows([["file10"], ["file2"]], 0, false).map((r) => r[0])).toEqual(["file2", "file10"]);
  });
});

describe("transfer notifications", () => {
  const job = { kind: "copy", label: "Copying 3 items", elapsedMs: NOTIFY_AFTER_MS + 1, errors: 0, cancelled: false };
  const away = { enabled: true, focused: false };
  it("notifies about long jobs that end in the background", () => {
    expect(finishNotice(job, away)).toEqual({ title: "Copied 3 items", body: "Finished in Octopolis" });
    expect(finishNotice({ ...job, errors: 2 }, away)?.body).toBe("3 items: 2 items couldn't be done");
  });
  it("stays quiet when focused, short, cancelled, off, or not a transfer", () => {
    expect(finishNotice(job, { enabled: true, focused: true })).toBeNull();
    expect(finishNotice({ ...job, elapsedMs: 500 }, away)).toBeNull();
    expect(finishNotice({ ...job, cancelled: true }, away)).toBeNull();
    expect(finishNotice(job, { enabled: false, focused: false })).toBeNull();
    expect(finishNotice({ ...job, kind: "rename" }, away)).toBeNull();
  });
});
