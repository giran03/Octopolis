import { describe, expect, it } from "vitest";
import { hasSavable, mediaCandidates, mediaFromHtml, nameForDropped, parseUriList } from "./webdrop";

describe("dropped web media", () => {
  it("reads a uri-list, skipping comments and blanks", () => {
    expect(parseUriList("# comment\r\nhttps://a.com/x.png\r\n\r\nhttps://b.com/y.jpg\n")).toEqual(["https://a.com/x.png", "https://b.com/y.jpg"]);
  });

  it("finds media addresses in dragged HTML, decoding entities and ignoring relative ones", () => {
    const html = `<meta charset="utf-8"><a href="https://site.com/page"><img src="https://cdn.site.com/a.png?x=1&amp;y=2" alt="a"></a><img class='x' src='/relative.png'><video src=https://v.com/c.mp4></video><source SRC="https://v.com/d.webm">`;
    expect(mediaFromHtml(html)).toEqual(["https://cdn.site.com/a.png?x=1&y=2", "https://v.com/c.mp4", "https://v.com/d.webm"]);
    expect(mediaFromHtml("")).toEqual([]);
    expect(mediaFromHtml('<img src="javascript:alert(1)"><img src="file:///C:/a.png">')).toEqual([]);
    expect(mediaFromHtml('<img src="data:image/png;base64,AAAA">')).toEqual(["data:image/png;base64,AAAA"]);
    expect(mediaFromHtml('<img src="data:text/html;base64,AAAA">')).toEqual([]);
  });

  it("prefers the dragged picture over the link wrapped around it", () => {
    const snap = { uris: ["https://site.com/page"], html: '<a href="https://site.com/page"><img src="https://cdn.site.com/a.png"></a>', text: "https://site.com/page" };
    expect(mediaCandidates(snap)).toEqual(["https://cdn.site.com/a.png"]);
  });

  it("falls back to links, then to an address dropped as text, and removes duplicates", () => {
    expect(mediaCandidates({ uris: ["https://a.com/x.png", "https://a.com/x.png", "ftp://a.com/y.png"], html: "", text: "" })).toEqual(["https://a.com/x.png"]);
    expect(mediaCandidates({ uris: [], html: "", text: " https://a.com/pic.jpg " })).toEqual(["https://a.com/pic.jpg"]);
    expect(mediaCandidates({ uris: [], html: "", text: "just some words" })).toEqual([]);
  });

  it("names dropped files and knows when there is nothing to save", () => {
    expect(nameForDropped("photo", "image/jpeg")).toBe("photo.jpg");
    expect(nameForDropped("photo.png", "image/jpeg")).toBe("photo.png");
    expect(nameForDropped("", "image/webp")).toBe("dropped.webp");
    expect(nameForDropped("notes", "text/plain")).toBe("notes");
    expect(hasSavable({ files: [], uris: [], html: "", text: "words" })).toBe(false);
    expect(hasSavable({ files: [], uris: ["https://a.com/x.png"], html: "", text: "" })).toBe(true);
  });
});
