//! Text from Office documents (Word, PowerPoint, Excel and their OpenDocument cousins) for the preview.
//! These are zip files of XML, so no Office install is needed.

use std::io::Read;
use std::path::Path;

use regex::Regex;

use crate::error::{Error, Result};

/// A document type this module can read.
pub fn document_label(ext: &str) -> Option<&'static str> {
    match ext {
        "docx" | "docm" => Some("Word document"),
        "pptx" | "pptm" => Some("PowerPoint presentation"),
        "xlsx" | "xlsm" => Some("Excel workbook"),
        "odt" => Some("OpenDocument text"),
        "ods" => Some("OpenDocument spreadsheet"),
        "odp" => Some("OpenDocument presentation"),
        _ => None,
    }
}

const MAX_ENTRY_BYTES: u64 = 20 * 1024 * 1024;
const MAX_SHEET_ROWS: usize = 300;

fn read_entry(zip: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let entry = zip.by_name(name).ok()?;
    if entry.size() > MAX_ENTRY_BYTES {
        return None;
    }
    let mut out = String::new();
    entry.take(MAX_ENTRY_BYTES).read_to_string(&mut out).ok()?;
    Some(out)
}

fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&#10;", "\n").replace("&amp;", "&")
}

fn strip_tags(xml: &str) -> String {
    let tags = Regex::new(r"<[^>]*>").expect("valid regex");
    decode_entities(&tags.replace_all(xml, ""))
}

/// Paragraph, line and tab markers become whitespace before the tags are removed.
fn flatten(xml: &str, breaks: &[&str], tabs: &[&str]) -> String {
    let mut s = xml.to_string();
    for b in breaks {
        s = s.replace(b, "\n");
    }
    for t in tabs {
        s = s.replace(t, "\t");
    }
    let text = strip_tags(&s);
    // Collapse the runs of blank lines this leaves behind.
    let blank = Regex::new(r"\n{3,}").expect("valid regex");
    blank.replace_all(text.trim(), "\n\n").into_owned()
}

fn docx(zip: &mut zip::ZipArchive<std::fs::File>) -> Option<String> {
    let xml = read_entry(zip, "word/document.xml")?;
    Some(flatten(&xml, &["</w:p>", "<w:br/>", "<w:br />"], &["<w:tab/>", "<w:tab />"]))
}

fn slide_number(name: &str) -> u32 {
    name.trim_start_matches("ppt/slides/slide").trim_end_matches(".xml").parse().unwrap_or(0)
}

fn pptx(zip: &mut zip::ZipArchive<std::fs::File>) -> Option<String> {
    let mut slides: Vec<String> = zip.file_names().filter_map(|n| n.ok().map(|s| s.into_owned())).filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml")).collect();
    slides.sort_by_key(|n| slide_number(n));
    let mut out = String::new();
    for name in slides {
        let xml = read_entry(zip, &name)?;
        out.push_str(&format!("— Slide {} —\n{}\n\n", slide_number(&name), flatten(&xml, &["</a:p>"], &[])));
    }
    (!out.is_empty()).then_some(out.trim().to_string())
}

fn xlsx(zip: &mut zip::ZipArchive<std::fs::File>) -> Option<String> {
    let shared = read_entry(zip, "xl/sharedStrings.xml").unwrap_or_default();
    let item = Regex::new(r"(?s)<si>(.*?)</si>").expect("valid regex");
    let strings: Vec<String> = item.captures_iter(&shared).map(|c| strip_tags(&c[1])).collect();
    let sheet = read_entry(zip, "xl/worksheets/sheet1.xml")?;
    let row = Regex::new(r"(?s)<row[^>]*>(.*?)</row>").expect("valid regex");
    let cell = Regex::new(r#"(?s)<c\b([^>]*?)(?:/>|>(.*?)</c>)"#).expect("valid regex");
    let value = Regex::new(r"(?s)<v>(.*?)</v>").expect("valid regex");
    let inline = Regex::new(r"(?s)<is>(.*?)</is>").expect("valid regex");
    let mut lines = Vec::new();
    for r in row.captures_iter(&sheet).take(MAX_SHEET_ROWS) {
        let cells: Vec<String> = cell
            .captures_iter(&r[1])
            .map(|c| {
                let attrs = &c[1];
                let body = c.get(2).map_or("", |m| m.as_str());
                if let Some(i) = inline.captures(body) {
                    return strip_tags(&i[1]);
                }
                let v = value.captures(body).map(|v| decode_entities(&v[1])).unwrap_or_default();
                if attrs.contains("t=\"s\"") { v.parse::<usize>().ok().and_then(|i| strings.get(i).cloned()).unwrap_or_default() } else { v }
            })
            .collect();
        lines.push(cells.join("\t").trim_end().to_string());
    }
    Some(lines.join("\n"))
}

fn opendocument(zip: &mut zip::ZipArchive<std::fs::File>) -> Option<String> {
    let xml = read_entry(zip, "content.xml")?;
    Some(flatten(&xml, &["</text:p>", "</text:h>", "</table:table-row>", "<text:line-break/>"], &["</table:table-cell>", "<text:tab/>"]))
}

/// The text of an Office or OpenDocument file, or `None` when it has no readable content.
pub fn extract_text(path: &Path, ext: &str) -> Result<Option<String>> {
    let file = std::fs::File::open(path).map_err(|e| Error::io(path, e))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| Error::io(path, std::io::Error::other(e.to_string())))?;
    Ok(match ext {
        "docx" | "docm" => docx(&mut zip),
        "pptx" | "pptm" => pptx(&mut zip),
        "xlsx" | "xlsm" => xlsx(&mut zip),
        "odt" | "ods" | "odp" => opendocument(&mut zip),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_zip(name: &str, entries: &[(&str, &str)]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("octopolis-office-{}-{name}", std::process::id()));
        let mut w = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        for (n, body) in entries {
            w.start_file(*n, opts).unwrap();
            w.write_all(body.as_bytes()).unwrap();
        }
        w.finish().unwrap();
        path
    }

    #[test]
    fn reads_word_paragraphs() {
        let p = make_zip("a.docx", &[("word/document.xml", "<w:document><w:body><w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>")]);
        let text = extract_text(&p, "docx").unwrap().unwrap();
        assert_eq!(text, "Hello & welcome\nSecond");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn reads_spreadsheet_with_shared_strings() {
        let p = make_zip(
            "b.xlsx",
            &[
                ("xl/sharedStrings.xml", "<sst><si><t>Name</t></si><si><t>Total</t></si></sst>"),
                ("xl/worksheets/sheet1.xml", r#"<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Bob</t></is></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>"#),
            ],
        );
        let text = extract_text(&p, "xlsx").unwrap().unwrap();
        assert_eq!(text, "Name\tTotal\nBob\t42");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn orders_slides_numerically() {
        let p = make_zip("c.pptx", &[("ppt/slides/slide10.xml", "<p><a:p><a:t>Ten</a:t></a:p></p>"), ("ppt/slides/slide2.xml", "<p><a:p><a:t>Two</a:t></a:p></p>")]);
        let text = extract_text(&p, "pptx").unwrap().unwrap();
        assert!(text.find("Two").unwrap() < text.find("Ten").unwrap());
        let _ = std::fs::remove_file(p);
    }
}
