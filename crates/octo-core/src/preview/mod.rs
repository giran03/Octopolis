//! What the inspector shows for a file: classification, safe text reading,
//! hex dumps, syntax highlighting and Markdown rendering.

pub mod highlight;
pub mod markdown;

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
        "txt" | "log" | "ini" | "cfg" | "conf" | "toml" | "yaml" | "yml" | "xml" | "csv" | "tsv" | "bat" | "cmd" | "ps1" | "sql" | "env"
        | "gitignore" | "lock" | "svelte" | "vue" | "lua" | "rb" | "php" | "kt" | "swift" => Kind::Text,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "avif" => Kind::Image,
        "svg" => Kind::Svg,
        "pdf" => Kind::Pdf,
        "mp3" | "wav" | "flac" | "ogg" | "m4a" | "aac" | "opus" => Kind::Audio,
        "mp4" | "webm" | "mov" | "m4v" | "mkv" => Kind::Video,
        "obj" | "stl" => Kind::Model,
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
    fn hex_dump_layout() {
        let d = hex_dump(b"Hello, Octopolis!");
        let first = d.lines().next().unwrap();
        assert!(first.starts_with("00000000  48 65 6c 6c 6f 2c 20 4f  63 74"), "{first}");
        assert!(first.ends_with("Hello, Octopolis"), "{first}");
        assert!(d.lines().nth(1).unwrap().starts_with("00000010  21"));
    }
}
