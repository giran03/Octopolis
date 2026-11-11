//! Search query syntax.
//!
//! Free words are fuzzy-matched (nucleo syntax: `^prefix`, `suffix$`,
//! `'exact`, `!not`). Filters:
//!
//! | filter | examples |
//! | :-- | :-- |
//! | `ext:` | `ext:rs,toml` |
//! | `type:` | `type:file`, `type:dir` |
//! | `size:` | `size:>100mb`, `size:<=4k`, `size:1mb..2gb` |
//! | `dm:` | `dm:today`, `dm:yesterday`, `dm:week`, `dm:month`, `dm:year`, `dm:2026-11-01`, `dm:>2026-01-01`, `dm:2026-01-01..2026-03-31` |
//! | `re:` | `re:^invoice_\d+`, `re:"two words"` |
//! | `tag:` | `tag:work`, `tag:red` (tags and color labels) |
//! | `content:` | `content:TODO`, `content:"connection refused"` (text inside files) |
//!
//! Values with spaces go in double quotes.

use jiff::{Span, Zoned, civil::Date};
use regex::Regex;

use crate::entry::EntryKind;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct QueryError(pub String);

#[derive(Debug, Default, Clone)]
pub struct Query {
    /// Fuzzy text (may be empty: then every entry passing the filters matches).
    pub text: String,
    /// Lower-case extensions without dots.
    pub exts: Vec<String>,
    pub kind: Option<EntryKind>,
    /// Inclusive lower and exclusive upper size bounds in bytes.
    pub size: Option<(u64, u64)>,
    /// Inclusive lower and exclusive upper modified time (Unix ms).
    pub modified: Option<(i64, i64)>,
    pub regex: Option<Regex>,
    /// Text that must appear inside the file (case-insensitive).
    pub content: Option<String>,
    /// Tag the item must carry. The caller fills `tagged` with the lower-case
    /// paths that have it (tags live outside the index).
    pub tag: Option<String>,
    pub tagged: Option<std::sync::Arc<std::collections::HashSet<String>>>,
}

impl Query {
    pub fn has_filters(&self) -> bool {
        !self.exts.is_empty() || self.kind.is_some() || self.size.is_some() || self.modified.is_some() || self.regex.is_some() || self.content.is_some() || self.tag.is_some()
    }
}

/// Parses a query using the current local time for relative dates.
pub fn parse(input: &str) -> Result<Query, QueryError> {
    parse_at(input, &Zoned::now())
}

pub fn parse_at(input: &str, now: &Zoned) -> Result<Query, QueryError> {
    let mut q = Query::default();
    let mut words = Vec::new();
    for token in tokenize(input) {
        let Some((key, value)) = token.split_once(':').filter(|(k, _)| is_filter(k)) else {
            words.push(token);
            continue;
        };
        if value.is_empty() {
            continue; // the user is still typing the value
        }
        match key.to_ascii_lowercase().as_str() {
            "ext" => q.exts.extend(value.split(',').map(|e| e.trim().trim_start_matches('.').to_lowercase()).filter(|e| !e.is_empty())),
            "type" => q.kind = Some(parse_kind(value)?),
            "size" => q.size = Some(parse_size_filter(value)?),
            "dm" => q.modified = Some(parse_date_filter(value, now)?),
            "re" => q.regex = Some(Regex::new(value).map_err(|e| QueryError(format!("re: {}", first_line(&e.to_string()))))?),
            "content" => q.content = Some(value.to_string()),
            "tag" => q.tag = Some(value.to_string()),
            _ => unreachable!("is_filter checked the key"),
        }
    }
    q.text = words.join(" ");
    Ok(q)
}

fn is_filter(key: &str) -> bool {
    matches!(key.to_ascii_lowercase().as_str(), "ext" | "type" | "size" | "dm" | "re" | "content" | "tag")
}

fn first_line(s: &str) -> &str {
    s.lines().last().unwrap_or(s).trim()
}

/// Splits on whitespace, keeping double-quoted runs together (quotes removed).
fn tokenize(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in input.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn parse_kind(v: &str) -> Result<EntryKind, QueryError> {
    match v.to_ascii_lowercase().as_str() {
        "file" | "f" => Ok(EntryKind::File),
        "dir" | "d" | "folder" => Ok(EntryKind::Dir),
        _ => Err(QueryError(format!("type: use file or dir, not \"{v}\""))),
    }
}

/// Parses `1.5gb`, `100k`, `12` (bytes) into bytes (1024-based units).
pub fn parse_bytes(v: &str) -> Result<u64, QueryError> {
    let v = v.trim().to_ascii_lowercase();
    let split = v.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(v.len());
    let (num, unit) = v.split_at(split);
    let n: f64 = num.parse().map_err(|_| QueryError(format!("size: \"{v}\" is not a size")))?;
    let mult: f64 = match unit.trim() {
        "" | "b" => 1.0,
        "k" | "kb" => 1024.0,
        "m" | "mb" => 1024f64.powi(2),
        "g" | "gb" => 1024f64.powi(3),
        "t" | "tb" => 1024f64.powi(4),
        u => return Err(QueryError(format!("size: unknown unit \"{u}\" (use b, kb, mb, gb, tb)"))),
    };
    Ok((n * mult).round() as u64)
}

fn parse_size_filter(v: &str) -> Result<(u64, u64), QueryError> {
    if let Some((a, b)) = v.split_once("..") {
        return Ok((parse_bytes(a)?, parse_bytes(b)?.saturating_add(1)));
    }
    let (op, rest) = split_op(v);
    let n = parse_bytes(rest)?;
    Ok(match op {
        ">" => (n.saturating_add(1), u64::MAX),
        ">=" => (n, u64::MAX),
        "<" => (0, n),
        "<=" => (0, n.saturating_add(1)),
        _ => (n, n.saturating_add(1)),
    })
}

fn split_op(v: &str) -> (&str, &str) {
    for op in [">=", "<=", ">", "<", "="] {
        if let Some(rest) = v.strip_prefix(op) {
            return (op, rest);
        }
    }
    ("", v)
}

fn ms(z: &Zoned) -> i64 {
    z.timestamp().as_millisecond()
}

fn day_start(date: &str, now: &Zoned) -> Result<Zoned, QueryError> {
    let d: Date = date.trim().parse().map_err(|_| QueryError(format!("dm: \"{date}\" is not a date (use YYYY-MM-DD)")))?;
    d.to_zoned(now.time_zone().clone()).map_err(|e| QueryError(e.to_string()))
}

fn add_days(z: &Zoned, days: i64) -> Result<Zoned, QueryError> {
    z.checked_add(Span::new().days(days)).map_err(|e| QueryError(e.to_string()))
}

fn parse_date_filter(v: &str, now: &Zoned) -> Result<(i64, i64), QueryError> {
    let today = now.start_of_day().map_err(|e| QueryError(e.to_string()))?;
    let ago = |days: i64| add_days(now, -days).map(|z| (ms(&z), i64::MAX));
    match v.to_ascii_lowercase().as_str() {
        "today" => return Ok((ms(&today), i64::MAX)),
        "yesterday" => return Ok((ms(&add_days(&today, -1)?), ms(&today))),
        "week" => return ago(7),
        "month" => return ago(30),
        "year" => return ago(365),
        _ => {}
    }
    if let Some((a, b)) = v.split_once("..") {
        return Ok((ms(&day_start(a, now)?), ms(&add_days(&day_start(b, now)?, 1)?)));
    }
    let (op, rest) = split_op(v);
    let start = day_start(rest, now)?;
    let next = add_days(&start, 1)?;
    Ok(match op {
        ">" => (ms(&next), i64::MAX),
        ">=" => (ms(&start), i64::MAX),
        "<" => (i64::MIN, ms(&start)),
        "<=" => (i64::MIN, ms(&next)),
        _ => (ms(&start), ms(&next)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> Zoned {
        "2026-11-11T15:30:00[UTC]".parse().unwrap()
    }
    fn at(s: &str) -> i64 {
        let z: Zoned = s.parse().unwrap();
        ms(&z)
    }

    #[test]
    fn splits_text_from_filters() {
        let q = parse_at("quarterly report ext:pdf,.DOCX type:file", &now()).unwrap();
        assert_eq!(q.text, "quarterly report");
        assert_eq!(q.exts, vec!["pdf", "docx"]);
        assert_eq!(q.kind, Some(EntryKind::File));
        assert!(q.has_filters());
    }

    #[test]
    fn sizes_with_units_and_operators() {
        assert_eq!(parse_bytes("1.5gb").unwrap(), 1_610_612_736);
        assert_eq!(parse_bytes("100K").unwrap(), 102_400);
        assert_eq!(parse_size_filter(">100mb").unwrap(), (104_857_601, u64::MAX));
        assert_eq!(parse_size_filter("<=4k").unwrap(), (0, 4097));
        assert_eq!(parse_size_filter("1mb..2mb").unwrap(), (1_048_576, 2_097_153));
        assert!(parse_size_filter(">12parsecs").is_err());
    }

    #[test]
    fn relative_and_absolute_dates() {
        let n = now();
        assert_eq!(parse_date_filter("today", &n).unwrap(), (at("2026-11-11T00:00[UTC]"), i64::MAX));
        assert_eq!(parse_date_filter("yesterday", &n).unwrap(), (at("2026-11-10T00:00[UTC]"), at("2026-11-11T00:00[UTC]")));
        assert_eq!(parse_date_filter("week", &n).unwrap().0, at("2026-11-04T15:30[UTC]"));
        assert_eq!(parse_date_filter("2026-01-02", &n).unwrap(), (at("2026-01-02T00:00[UTC]"), at("2026-01-03T00:00[UTC]")));
        assert_eq!(parse_date_filter(">2026-01-02", &n).unwrap().0, at("2026-01-03T00:00[UTC]"));
        assert_eq!(parse_date_filter("<2026-01-02", &n).unwrap().1, at("2026-01-02T00:00[UTC]"));
        assert_eq!(
            parse_date_filter("2026-01-01..2026-01-31", &n).unwrap(),
            (at("2026-01-01T00:00[UTC]"), at("2026-02-01T00:00[UTC]"))
        );
        assert!(parse_date_filter("someday", &n).is_err());
    }

    #[test]
    fn quoted_regex_and_errors() {
        let q = parse_at(r#"re:"^draft \d+" notes"#, &now()).unwrap();
        assert_eq!(q.text, "notes");
        assert!(q.regex.unwrap().is_match("draft 12.md"));
        let err = parse_at("re:(unclosed", &now()).unwrap_err();
        assert!(err.0.starts_with("re:"), "{err}");
        assert!(parse_at("type:banana", &now()).is_err());
    }

    #[test]
    fn unfinished_filters_and_unknown_keys_are_harmless() {
        let q = parse_at("ext: size: C:notes http://x", &now()).unwrap();
        assert!(!q.has_filters());
        assert_eq!(q.text, "C:notes http://x");
    }
}
