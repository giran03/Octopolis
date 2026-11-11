//! Tags and color labels on files and folders, kept in a small per-user index
//! (one line per item: `path<TAB>tag<TAB>tag`). The files themselves are never
//! touched, so tagging doesn't change dates or wake sync apps.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

#[derive(Debug, Default, Clone)]
pub struct TagStore {
    /// Lower-case path → (path as given, tags in the order added).
    items: HashMap<String, (String, Vec<String>)>,
}

fn key(path: &str) -> String {
    path.trim_end_matches('\\').to_lowercase()
}

/// Tag names are trimmed, have no tabs or line breaks, and are at most 40 characters.
pub fn clean_tag(tag: &str) -> Option<String> {
    let t: String = tag.trim().chars().filter(|c| !c.is_control()).take(40).collect();
    (!t.is_empty()).then_some(t)
}

impl TagStore {
    pub fn parse(text: &str) -> Self {
        let mut items = HashMap::new();
        for line in text.lines() {
            let mut parts = line.split('\t');
            let Some(path) = parts.next().filter(|p| !p.is_empty()) else { continue };
            let tags: Vec<String> = parts.filter_map(clean_tag).collect();
            if !tags.is_empty() {
                items.insert(key(path), (path.to_string(), tags));
            }
        }
        Self { items }
    }

    pub fn to_text(&self) -> String {
        let mut lines: Vec<String> = self.items.values().map(|(p, tags)| format!("{p}\t{}", tags.join("\t"))).collect();
        lines.sort();
        lines.join("\n")
    }

    pub fn load(file: &Path) -> Self {
        std::fs::read_to_string(file).map(|t| Self::parse(&t)).unwrap_or_default()
    }

    /// Writes atomically (temporary file, then rename).
    pub fn save(&self, file: &Path) -> Result<()> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| Error::io(dir, e))?;
        }
        let tmp = file.with_extension("tmp");
        std::fs::write(&tmp, self.to_text()).map_err(|e| Error::io(&tmp, e))?;
        std::fs::rename(&tmp, file).map_err(|e| Error::io(file, e))
    }

    pub fn tags_of(&self, path: &str) -> &[String] {
        self.items.get(&key(path)).map_or(&[], |(_, t)| t.as_slice())
    }

    /// Adds or removes `tag` on every path. Returns true if anything changed.
    pub fn set(&mut self, paths: &[String], tag: &str, on: bool) -> bool {
        let Some(tag) = clean_tag(tag) else { return false };
        let mut changed = false;
        for p in paths {
            let k = key(p);
            let entry = self.items.entry(k.clone()).or_insert_with(|| (p.clone(), Vec::new()));
            let has = entry.1.iter().any(|t| t.eq_ignore_ascii_case(&tag));
            if on && !has {
                entry.1.push(tag.clone());
                changed = true;
            } else if !on && has {
                entry.1.retain(|t| !t.eq_ignore_ascii_case(&tag));
                changed = true;
            }
            if entry.1.is_empty() {
                self.items.remove(&k);
            }
        }
        changed
    }

    /// Tags of the items directly inside `dir`, by lower-case name.
    pub fn in_dir(&self, dir: &str) -> Vec<(String, Vec<String>)> {
        let prefix = format!("{}\\", key(dir));
        self.items
            .iter()
            .filter_map(|(k, (_, tags))| {
                let rest = k.strip_prefix(&prefix)?;
                (!rest.contains('\\')).then(|| (rest.to_string(), tags.clone()))
            })
            .collect()
    }

    /// Every tag with how many items have it, by name.
    pub fn all(&self) -> BTreeMap<String, usize> {
        let mut out: BTreeMap<String, usize> = BTreeMap::new();
        for (_, tags) in self.items.values() {
            for t in tags {
                *out.entry(t.clone()).or_default() += 1;
            }
        }
        out
    }

    /// Paths carrying `tag` (as given when tagged).
    pub fn with_tag(&self, tag: &str) -> Vec<String> {
        let mut out: Vec<String> = self.items.values().filter(|(_, t)| t.iter().any(|x| x.eq_ignore_ascii_case(tag))).map(|(p, _)| p.clone()).collect();
        out.sort_by_key(|p| p.to_lowercase());
        out
    }

    /// Lower-case paths carrying `tag`, for the search filter.
    pub fn keys_with_tag(&self, tag: &str) -> HashSet<String> {
        self.items.iter().filter(|(_, (_, t))| t.iter().any(|x| x.eq_ignore_ascii_case(tag))).map(|(k, _)| k.clone()).collect()
    }

    /// Follows items (and everything inside moved folders) to their new paths.
    pub fn moved(&mut self, pairs: &[(PathBuf, PathBuf)]) -> bool {
        let mut changed = false;
        for (from, to) in pairs {
            let (from, to) = (from.to_string_lossy().into_owned(), to.to_string_lossy().into_owned());
            let (fk, inside) = (key(&from), format!("{}\\", key(&from)));
            let hits: Vec<String> = self.items.keys().filter(|k| **k == fk || k.starts_with(&inside)).cloned().collect();
            for k in hits {
                if let Some((old, tags)) = self.items.remove(&k) {
                    let new_path = format!("{}{}", to.trim_end_matches('\\'), &old[from.trim_end_matches('\\').len()..]);
                    self.items.insert(key(&new_path), (new_path, tags));
                    changed = true;
                }
            }
        }
        changed
    }

    /// Drops items that no longer exist. Returns how many were removed.
    pub fn prune_missing(&mut self) -> usize {
        let before = self.items.len();
        self.items.retain(|_, (p, _)| Path::new(p).exists());
        before - self.items.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn sets_lists_and_round_trips() {
        let mut t = TagStore::default();
        assert!(t.set(&s(&["C:\\p\\a.txt", "C:\\p\\Sub"]), "work", true));
        assert!(t.set(&s(&["C:\\p\\a.txt"]), " red ", true));
        assert!(!t.set(&s(&["c:\\P\\A.TXT"]), "WORK", true), "tags are case-insensitive");
        assert_eq!(t.tags_of("c:\\p\\a.txt"), &["work".to_string(), "red".to_string()]);
        let mut dir = t.in_dir("C:\\p");
        dir.sort();
        assert_eq!(dir, vec![("a.txt".into(), s(&["work", "red"])), ("sub".into(), s(&["work"]))]);
        assert_eq!(t.all().get("work"), Some(&2));
        let back = TagStore::parse(&t.to_text());
        assert_eq!(back.with_tag("work"), s(&["C:\\p\\a.txt", "C:\\p\\Sub"]));

        assert!(t.set(&s(&["C:\\p\\a.txt"]), "work", false));
        assert!(t.set(&s(&["C:\\p\\a.txt"]), "red", false));
        assert!(t.tags_of("C:\\p\\a.txt").is_empty());
        assert!(!t.set(&s(&["x"]), "\t\n", true), "empty tags are refused");
    }

    #[test]
    fn follows_moves_including_folder_contents() {
        let mut t = TagStore::default();
        t.set(&s(&["C:\\old\\f.txt", "C:\\old", "C:\\older\\g.txt"]), "keep", true);
        assert!(t.moved(&[(PathBuf::from("C:\\old"), PathBuf::from("D:\\new"))]));
        let mut all = t.with_tag("keep");
        all.sort();
        assert_eq!(all, s(&["C:\\older\\g.txt", "D:\\new", "D:\\new\\f.txt"]), "C:\\older is a different folder");
    }
}
