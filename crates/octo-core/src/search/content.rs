//! Searching inside files: case-insensitive text matching that reads files in
//! chunks, skips binary files, and finds the matching lines for previews.

use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

/// Files larger than this are not searched inside (logs and media dumps would stall a search).
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const CHUNK: usize = 1 << 20;
/// A NUL byte in the first few kilobytes marks a binary file.
const SNIFF: usize = 8 * 1024;

/// What to look for. ASCII text is matched byte-wise (fast); other text by
/// lower-casing decoded UTF-8.
pub struct Needle {
    lower: String,
    finder: Option<memchr::memmem::Finder<'static>>,
}

impl Needle {
    pub fn new(text: &str) -> Self {
        let lower = text.to_lowercase();
        let finder = lower.is_ascii().then(|| memchr::memmem::Finder::new(lower.as_bytes()).into_owned());
        Self { lower, finder }
    }

    fn in_chunk(&self, chunk: &[u8]) -> bool {
        match &self.finder {
            Some(f) => f.find(&chunk.to_ascii_lowercase()).is_some(),
            None => String::from_utf8_lossy(chunk).to_lowercase().contains(&self.lower),
        }
    }

    /// Whether the text occurs in the file. Unreadable and binary files never match.
    pub fn found_in(&self, path: &Path) -> bool {
        if self.lower.is_empty() {
            return true;
        }
        let Ok(mut file) = File::open(path) else { return false };
        // Chunks overlap by the needle's length so a match across a boundary is found.
        let overlap = self.lower.len().saturating_sub(1);
        let mut buf = vec![0u8; CHUNK + overlap];
        let mut carried = 0usize;
        let mut first = true;
        loop {
            let n = match file.read(&mut buf[carried..]) {
                Ok(0) => return false,
                Ok(n) => n,
                Err(_) => return false,
            };
            let filled = carried + n;
            if first {
                first = false;
                if memchr::memchr(0, &buf[..filled.min(SNIFF)]).is_some() {
                    return false;
                }
            }
            if self.in_chunk(&buf[..filled]) {
                return true;
            }
            let keep = overlap.min(filled);
            buf.copy_within(filled - keep..filled, 0);
            carried = keep;
        }
    }
}

/// Lines containing `text` (1-based line number, trimmed line), at most `limit`.
pub fn matching_lines(path: &Path, text: &str, limit: usize) -> std::io::Result<Vec<(usize, String)>> {
    let needle = text.to_lowercase();
    let mut out = Vec::new();
    let reader = BufReader::new(File::open(path)?);
    for (i, line) in reader.split(b'\n').enumerate() {
        let line = line?;
        if i == 0 && memchr::memchr(0, &line[..line.len().min(SNIFF)]).is_some() {
            return Ok(out); // binary
        }
        let text = String::from_utf8_lossy(&line);
        if text.to_lowercase().contains(&needle) {
            let trimmed: String = text.trim().chars().take(300).collect();
            out.push((i + 1, trimmed));
            if out.len() >= limit {
                break;
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_text_case_insensitively_and_across_chunks() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("big.log");
        let mut data = vec![b'x'; CHUNK - 3];
        data.extend_from_slice(b"Needle in the hay");
        std::fs::write(&f, &data).unwrap();
        assert!(Needle::new("needle IN").found_in(&f), "match spanning the first chunk boundary");
        assert!(!Needle::new("absent").found_in(&f));
    }

    #[test]
    fn skips_binary_files_and_matches_non_ascii() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("a.bin");
        std::fs::write(&bin, b"\0\0hello").unwrap();
        assert!(!Needle::new("hello").found_in(&bin));
        let txt = tmp.path().join("b.txt");
        std::fs::write(&txt, "Größe über alles").unwrap();
        assert!(Needle::new("GRÖSSE").found_in(&txt) || Needle::new("größe").found_in(&txt));
        assert!(Needle::new("ÜBER").found_in(&txt));
    }

    #[test]
    fn content_filter_runs_inside_a_search() {
        use crate::entry::EntryKind;
        use crate::ops::CancelToken;
        use crate::search::{index::{Index, ROOT}, query, rank};
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("notes.txt"), "remember the milk").unwrap();
        std::fs::write(tmp.path().join("todo.txt"), "nothing here").unwrap();
        let mut ix = Index::new(tmp.path().to_path_buf());
        ix.push("notes.txt", ROOT, EntryKind::File, 0, 17, 0);
        ix.push("todo.txt", ROOT, EntryKind::File, 0, 12, 0);
        ix.push("online.txt", ROOT, EntryKind::File, 0x0040_0000, 5, 0); // never opened
        let hits = |text: &str| {
            let r = rank::run(&ix, &query::parse(text).unwrap(), 100, &CancelToken::default());
            r.hits.iter().map(|h| ix.names[h.index as usize].to_string()).collect::<Vec<_>>()
        };
        assert_eq!(hits("content:MILK"), vec!["notes.txt"]);
        assert_eq!(hits("todo content:milk"), Vec::<String>::new(), "name and content must both match");
        assert_eq!(hits(r#"content:"the milk" ext:txt"#), vec!["notes.txt"]);
    }

    #[test]
    fn tag_filter_uses_the_paths_it_is_given() {
        use crate::entry::EntryKind;
        use crate::ops::CancelToken;
        use crate::search::{index::{Index, ROOT}, query, rank};
        let mut ix = Index::new(std::path::PathBuf::from(r"C:\p"));
        ix.push("a.txt", ROOT, EntryKind::File, 0, 1, 0);
        ix.push("b.txt", ROOT, EntryKind::File, 0, 1, 0);
        let mut q = query::parse("tag:work").unwrap();
        assert_eq!(q.tag.as_deref(), Some("work"));
        let names = |q: &query::Query| rank::run(&ix, q, 10, &CancelToken::default()).hits.iter().map(|h| ix.names[h.index as usize].to_string()).collect::<Vec<_>>();
        assert!(names(&q).is_empty(), "no tag index given: nothing matches");
        q.tagged = Some(std::sync::Arc::new([r"c:\p\b.txt".to_string()].into_iter().collect()));
        assert_eq!(names(&q), vec!["b.txt"]);
    }

    #[test]
    fn lists_matching_lines_with_numbers() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("c.rs");
        std::fs::write(&f, "fn a() {}\n  // TODO: fix\nfn b() {}\n// todo later\n").unwrap();
        assert_eq!(matching_lines(&f, "todo", 10).unwrap(), vec![(2, "// TODO: fix".to_string()), (4, "// todo later".to_string())]);
        assert_eq!(matching_lines(&f, "todo", 1).unwrap().len(), 1);
    }
}
