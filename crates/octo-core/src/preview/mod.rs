//! What the inspector shows for a file: classification, safe text reading,
//! hex dumps, syntax highlighting and Markdown rendering.

pub mod highlight;
pub mod markdown;
pub mod office;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Code(&'static str),
    Markdown,
    Text,
    Image,
    Svg,
    Pdf,
    Audio,
    Video,
    Model,
    Archive,
    Binary,
    /// TrueType, OpenType and web fonts.
    Font,
    /// CSV, TSV and JSON Lines, shown as a table.
    Table,
}

impl Kind {
    pub fn tag(self) -> &'static str {
        match self {
            Kind::Code(_) => "code",
            Kind::Markdown => "markdown",
            Kind::Text => "text",
            Kind::Image => "image",
            Kind::Svg => "svg",
            Kind::Pdf => "pdf",
            Kind::Audio => "audio",
            Kind::Video => "video",
            Kind::Model => "model",
            Kind::Archive => "archive",
            Kind::Binary => "binary",
            Kind::Font => "font",
            Kind::Table => "table",
        }
    }
}

fn ext(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

/// Picks a preview kind from the file name.
pub fn classify(name: &str) -> Kind {
    if crate::archive::is_archive(name) {
        return Kind::Archive;
    }
    match ext(name).as_str() {
        "md" | "markdown" | "mdx" => Kind::Markdown,
        "rs" => Kind::Code("rust"),
        "js" | "mjs" | "cjs" | "jsx" => Kind::Code("javascript"),
        "ts" | "mts" | "cts" => Kind::Code("typescript"),
        "tsx" => Kind::Code("tsx"),
        "py" | "pyw" => Kind::Code("python"),
        "json" | "jsonc" => Kind::Code("json"),
        "css" | "scss" => Kind::Code("css"),
        "html" | "htm" | "xhtml" => Kind::Code("html"),
        "sh" | "bash" | "zsh" => Kind::Code("bash"),
        "c" | "h" => Kind::Code("c"),
        "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx" => Kind::Code("cpp"),
        "go" => Kind::Code("go"),
        "cs" => Kind::Code("c_sharp"),
        "java" => Kind::Code("java"),
        "txt" | "log" | "ini" | "cfg" | "conf" | "toml" | "yaml" | "yml" | "xml" | "bat" | "cmd" | "ps1" | "sql" | "env"
        | "gitignore" | "lock" | "svelte" | "vue" | "lua" | "rb" | "php" | "kt" | "swift" => Kind::Text,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "avif" => Kind::Image,
        "svg" => Kind::Svg,
        "pdf" => Kind::Pdf,
        "mp3" | "wav" | "flac" | "ogg" | "m4a" | "aac" | "opus" => Kind::Audio,
        "mp4" | "webm" | "mov" | "m4v" | "mkv" => Kind::Video,
        "obj" | "stl" => Kind::Model,
        "ttf" | "otf" | "woff" | "woff2" => Kind::Font,
        "csv" | "tsv" | "tab" | "jsonl" | "ndjson" => Kind::Table,
        "" => Kind::Text, // README, LICENSE, Makefile…
        _ => Kind::Binary,
    }
}

/// Bytes that look like binary data (NUL in the first block, no UTF-16 BOM).
pub fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return false;
    }
    bytes.iter().take(8192).any(|&b| b == 0)
}

/// Decodes text with UTF-8 / UTF-16 BOM detection; invalid bytes are replaced.
pub fn decode_text(bytes: &[u8]) -> String {
    let utf16 = |be: bool, body: &[u8]| {
        let units: Vec<u16> =
            body.chunks_exact(2).map(|c| if be { u16::from_be_bytes([c[0], c[1]]) } else { u16::from_le_bytes([c[0], c[1]]) }).collect();
        String::from_utf16_lossy(&units)
    };
    match bytes {
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8_lossy(rest).into_owned(),
        [0xFF, 0xFE, rest @ ..] => utf16(false, rest),
        [0xFE, 0xFF, rest @ ..] => utf16(true, rest),
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// Encoding, line endings and line count of a text file's first block.
/// `bytes` is what was read, `text` its decoded form.
pub fn text_details(bytes: &[u8], text: &str, truncated: bool) -> Vec<(String, String)> {
    // A read cut mid-character still counts as UTF-8.
    let utf8 = std::str::from_utf8(bytes).is_ok() || truncated && std::str::from_utf8(&bytes[..bytes.len().saturating_sub(3)]).is_ok();
    let encoding = match bytes {
        [0xEF, 0xBB, 0xBF, ..] => "UTF-8 with BOM",
        [0xFF, 0xFE, ..] => "UTF-16 LE",
        [0xFE, 0xFF, ..] => "UTF-16 BE",
        _ if utf8 && bytes.is_ascii() => "ASCII",
        _ if utf8 => "UTF-8",
        _ => "Unknown (shown as UTF-8)",
    };
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    let cr = text.matches('\r').count() - crlf;
    let endings = match (crlf > 0, lf > 0, cr > 0) {
        (false, false, false) => "None",
        (true, false, false) => "Windows (CRLF)",
        (false, true, false) => "Unix (LF)",
        (false, false, true) => "Classic Mac (CR)",
        _ => "Mixed",
    };
    let mut lines = crlf + lf + cr;
    if !text.is_empty() && !text.ends_with('\n') && !text.ends_with('\r') {
        lines += 1;
    }
    let lines = if truncated { format!("{lines}+ (start of file)") } else { lines.to_string() };
    vec![("Encoding".into(), encoding.into()), ("Line endings".into(), endings.into()), ("Lines".into(), lines)]
}

/// Classic hex dump: offset, 16 bytes in hex, printable ASCII.
pub fn hex_dump(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 4 + 32);
    for (row, chunk) in bytes.chunks(16).enumerate() {
        out.push_str(&format!("{:08x}  ", row * 16));
        for i in 0..16 {
            match chunk.get(i) {
                Some(b) => out.push_str(&format!("{b:02x} ")),
                None => out.push_str("   "),
            }
            if i == 7 {
                out.push(' ');
            }
        }
        out.push(' ');
        out.extend(chunk.iter().map(|&b| if (0x20..0x7f).contains(&b) { b as char } else { '.' }));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_common_files() {
        assert_eq!(classify("main.RS"), Kind::Code("rust"));
        assert_eq!(classify("README"), Kind::Text);
        assert_eq!(classify("notes.md"), Kind::Markdown);
        assert_eq!(classify("a.tar.gz"), Kind::Archive);
        assert_eq!(classify("photo.JPG"), Kind::Image);
        assert_eq!(classify("setup.exe"), Kind::Binary);
    }

    #[test]
    fn decodes_boms_and_detects_binary() {
        assert_eq!(decode_text(&[0xEF, 0xBB, 0xBF, b'h', b'i']), "hi");
        assert_eq!(decode_text(&[0xFF, 0xFE, b'h', 0, b'i', 0]), "hi");
        assert!(!looks_binary(&[0xFF, 0xFE, b'h', 0]));
        assert!(looks_binary(b"MZ\x90\x00\x03"));
        assert!(!looks_binary("plain ünïcode".as_bytes()));
    }

    #[test]
    fn classifies_fonts_and_tables() {
        assert_eq!(classify("Inter.woff2"), Kind::Font);
        assert_eq!(classify("data.CSV"), Kind::Table);
        assert_eq!(classify("log.jsonl"), Kind::Table);
    }

    #[test]
    fn reports_encoding_line_endings_and_lines() {
        let get = |d: &[(String, String)], k: &str| d.iter().find(|(n, _)| n == k).unwrap().1.clone();
        let d = text_details(b"a\r\nb\r\n", "a\r\nb\r\n", false);
        assert_eq!(get(&d, "Encoding"), "ASCII");
        assert_eq!(get(&d, "Line endings"), "Windows (CRLF)");
        assert_eq!(get(&d, "Lines"), "2");
        let d = text_details("é\nx\r\ny".as_bytes(), "é\nx\r\ny", false);
        assert_eq!(get(&d, "Encoding"), "UTF-8");
        assert_eq!(get(&d, "Line endings"), "Mixed");
        assert_eq!(get(&d, "Lines"), "3");
        assert_eq!(get(&text_details(&[0xEF, 0xBB, 0xBF, b'a'], "a", false), "Encoding"), "UTF-8 with BOM");
        assert_eq!(get(&text_details(&[0xE9, b'a'], "\u{FFFD}a", false), "Encoding"), "Unknown (shown as UTF-8)");
    }

    #[test]
    fn hex_dump_layout() {
        let d = hex_dump(b"Hello, Octopolis!");
        let first = d.lines().next().unwrap();
        assert!(first.starts_with("00000000  48 65 6c 6c 6f 2c 20 4f  63 74"), "{first}");
        assert!(first.ends_with("Hello, Octopolis"), "{first}");
        assert!(d.lines().nth(1).unwrap().starts_with("00000010  21"));
    }
}
