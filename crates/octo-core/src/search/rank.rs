//! Filters an index with a query and ranks matches with the nucleo matcher
//! (the fuzzy engine used by the Helix editor), in parallel.

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use rayon::prelude::*;

use super::index::Index;
use super::query::Query;
use crate::entry::EntryKind;
use crate::ops::CancelToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hit {
    pub index: u32,
    pub score: u32,
}

#[derive(Debug, Default)]
pub struct SearchResult {
    /// Best matches first (or tree order when there is no fuzzy text).
    pub hits: Vec<Hit>,
    /// Matches before `limit` was applied.
    pub matched: usize,
}

impl SearchResult {
    pub fn truncated(&self) -> bool {
        self.matched > self.hits.len()
    }
}

fn passes_filters(ix: &Index, q: &Query, i: usize) -> bool {
    if let Some(kind) = q.kind
        && ix.kinds[i] != kind
    {
        return false;
    }
    let is_file = ix.kinds[i] == EntryKind::File;
    if !q.exts.is_empty() {
        let name = &*ix.names[i];
        let ext = name.rfind('.').filter(|&p| p > 0).map(|p| name[p + 1..].to_lowercase());
        if !is_file || !ext.is_some_and(|e| q.exts.contains(&e)) {
            return false;
        }
    }
    if let Some((lo, hi)) = q.size {
        // Unknown sizes (u64::MAX, from the NTFS journal) never match a size filter.
        let s = ix.sizes[i];
        if !is_file || s == u64::MAX || s < lo || s >= hi {
            return false;
        }
    }
    if let Some((lo, hi)) = q.modified {
        let m = ix.modified_ms[i];
        if m < lo || m >= hi {
            return false;
        }
    }
    if let Some(re) = &q.regex
        && !re.is_match(&ix.names[i])
    {
        return false;
    }
    true
}

/// Runs `q` against `ix`, returning at most `limit` hits.
pub fn run(ix: &Index, q: &Query, limit: usize, cancel: &CancelToken) -> SearchResult {
    let text = q.text.trim();
    if text.is_empty() {
        // Flat view / pure filter: keep tree order.
        let all: Vec<u32> = (0..ix.len()).into_par_iter().filter(|&i| passes_filters(ix, q, i)).map(|i| i as u32).collect();
        let matched = all.len();
        let hits = all.into_iter().take(limit).map(|index| Hit { index, score: 0 }).collect();
        return SearchResult { hits, matched };
    }

    let pattern = Pattern::parse(text, CaseMatching::Smart, Normalization::Smart);
    // A separator in the query means the user is matching on the path.
    let on_path = text.contains(['\\', '/']);
    let mut hits: Vec<Hit> = (0..ix.len())
        .into_par_iter()
        .map_init(
            || (Matcher::new(Config::DEFAULT.match_paths()), Vec::new()),
            |(matcher, buf), i| {
                if cancel.is_cancelled() || !passes_filters(ix, q, i) {
                    return None;
                }
                let path;
                let hay: &str = if on_path {
                    path = ix.rel_path(i as u32);
                    &path
                } else {
                    &ix.names[i]
                };
                pattern.score(Utf32Str::new(hay, buf), matcher).map(|score| Hit { index: i as u32, score })
            },
        )
        .flatten()
        .collect();

    let matched = hits.len();
    // Highest score first; ties go to the shorter (more specific) name.
    hits.par_sort_unstable_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| ix.names[a.index as usize].len().cmp(&ix.names[b.index as usize].len()))
            .then_with(|| a.index.cmp(&b.index))
    });
    hits.truncate(limit);
    SearchResult { hits, matched }
}

#[cfg(test)]
mod tests {
    use super::super::index::ROOT;
    use super::super::query::parse_at;
    use super::*;
    use std::path::PathBuf;

    fn sample() -> Index {
        let mut ix = Index::new(PathBuf::from(r"C:\p"));
        let src = ix.push("src", ROOT, EntryKind::Dir, 0, 0, 1_000);
        ix.push("main.rs", src, EntryKind::File, 0, 2_000, 5_000);
        ix.push("mainframe_notes.txt", ROOT, EntryKind::File, 0, 50, 9_000);
        ix.push("Cargo.toml", ROOT, EntryKind::File, 0, 700, 2_000);
        ix.push("invoice_2026.pdf", ROOT, EntryKind::File, 0, 5_000_000, 3_000);
        ix
    }

    fn names(ix: &Index, r: &SearchResult) -> Vec<String> {
        r.hits.iter().map(|h| ix.names[h.index as usize].to_string()).collect()
    }

    fn q(s: &str) -> Query {
        parse_at(s, &"2026-11-11T00:00[UTC]".parse().unwrap()).unwrap()
    }

    #[test]
    fn fuzzy_ranks_tighter_matches_first() {
        let ix = sample();
        let r = run(&ix, &q("main"), 10, &CancelToken::default());
        assert_eq!(names(&ix, &r)[..2], ["main.rs", "mainframe_notes.txt"]);
        assert_eq!(r.matched, 2);
    }

    #[test]
    fn filters_without_text_keep_tree_order() {
        let ix = sample();
        let r = run(&ix, &q("ext:rs,toml"), 10, &CancelToken::default());
        assert_eq!(names(&ix, &r), ["main.rs", "Cargo.toml"]);
        let r = run(&ix, &q("size:>1mb"), 10, &CancelToken::default());
        assert_eq!(names(&ix, &r), ["invoice_2026.pdf"]);
        let r = run(&ix, &q(r"re:^invoice_\d+"), 10, &CancelToken::default());
        assert_eq!(r.matched, 1);
        let r = run(&ix, &q("type:dir"), 10, &CancelToken::default());
        assert_eq!(names(&ix, &r), ["src"]);
    }

    #[test]
    fn path_queries_match_folders_in_the_path() {
        let ix = sample();
        let r = run(&ix, &q(r"src\main"), 10, &CancelToken::default());
        assert_eq!(names(&ix, &r), ["main.rs"]);
    }

    #[test]
    fn limit_truncates_but_reports_total() {
        let ix = sample();
        let r = run(&ix, &q(""), 2, &CancelToken::default());
        assert_eq!(r.hits.len(), 2);
        assert_eq!(r.matched, 5);
        assert!(r.truncated());
    }

    #[test]
    fn unknown_sizes_never_match_size_filters() {
        let mut ix = Index::new(PathBuf::from(r"C:\p"));
        ix.push("x.bin", ROOT, EntryKind::File, 0, u64::MAX, 0);
        assert_eq!(run(&ix, &q("size:>0"), 10, &CancelToken::default()).matched, 0);
    }
}
