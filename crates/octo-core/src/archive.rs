//! Archives as read-only virtual folders: `C:\x\photos.zip\2024\a.jpg`.
//!
//! Supports zip, 7z and tar (plain, .gz, .bz2). Listings are cached per
//! archive (keyed by size and modified time). Extraction refuses entries whose
//! paths would escape the destination ("zip slip").

use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{Error, Result};
use crate::names::unique_path;
use crate::ops::CancelToken;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveEntry {
    /// Path inside the archive with `\` separators, no leading or trailing `\`.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: i64,
}

impl ArchiveEntry {
    pub fn name(&self) -> &str {
        self.path.rsplit('\\').next().unwrap_or(&self.path)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Zip,
    SevenZ,
    Tar,
    TarGz,
    TarBz2,
}

fn format_of(name: &str) -> Option<Format> {
    let n = name.to_ascii_lowercase();
    if n.ends_with(".tar.gz") || n.ends_with(".tgz") {
        Some(Format::TarGz)
    } else if n.ends_with(".tar.bz2") || n.ends_with(".tbz2") || n.ends_with(".tbz") {
        Some(Format::TarBz2)
    } else if n.ends_with(".tar") {
        Some(Format::Tar)
    } else if n.ends_with(".zip") || n.ends_with(".jar") || n.ends_with(".nupkg") || n.ends_with(".vsix") || n.ends_with(".apk") {
        Some(Format::Zip)
    } else if n.ends_with(".7z") {
        Some(Format::SevenZ)
    } else {
        None
    }
}

pub fn is_archive(name: &str) -> bool {
    format_of(name).is_some()
}

/// Splits `C:\a\b.zip\c\d` into (`C:\a\b.zip`, `c\d`). Returns `None` for
/// ordinary paths. The archive part must be an existing file.
pub fn split_path(p: &Path) -> Option<(PathBuf, String)> {
    let mut acc = PathBuf::new();
    let mut comps = p.components().peekable();
    while let Some(c) = comps.next() {
        acc.push(c.as_os_str());
        if let Component::Normal(name) = c
            && is_archive(&name.to_string_lossy())
            && acc.is_file()
        {
            let inner: Vec<String> = comps.map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
            return Some((acc, inner.join("\\")));
        }
    }
    None
}

fn norm(path: &str) -> String {
    path.replace('/', "\\").trim_matches('\\').to_string()
}

fn ms(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn zip_time(dt: Option<zip::DateTime>) -> i64 {
    let Some(dt) = dt else { return 0 };
    // Zip times are local wall-clock times.
    let civil = jiff::civil::datetime(dt.year() as i16, dt.month() as i8, dt.day() as i8, dt.hour() as i8, dt.minute() as i8, dt.second() as i8, 0);
    civil.to_zoned(jiff::tz::TimeZone::system()).map_or(0, |z| z.timestamp().as_millisecond())
}

fn arch_err(archive: &Path, e: impl std::fmt::Display) -> Error {
    Error::io(archive, std::io::Error::other(e.to_string()))
}

/// Visits every entry with a reader for its contents. Return `false` from the
/// callback to stop early.
fn for_each(archive: &Path, mut f: impl FnMut(&ArchiveEntry, &mut dyn Read) -> bool) -> Result<()> {
    let format = format_of(&archive.to_string_lossy()).ok_or_else(|| arch_err(archive, "not a supported archive"))?;
    let file = File::open(archive).map_err(|e| Error::io(archive, e))?;
    match format {
        Format::Zip => {
            let mut zip = zip::ZipArchive::new(BufReader::new(file)).map_err(|e| arch_err(archive, e))?;
            for i in 0..zip.len() {
                let mut entry = zip.by_index(i).map_err(|e| arch_err(archive, e))?;
                let name = entry.name().map_err(|e| arch_err(archive, e))?.into_owned();
                let meta = ArchiveEntry {
                    path: norm(&name),
                    is_dir: entry.is_dir(),
                    size: entry.size(),
                    modified_ms: zip_time(entry.last_modified()),
                };
                if !f(&meta, &mut entry) {
                    break;
                }
            }
        }
        Format::SevenZ => {
            let mut reader = sevenz_rust2::ArchiveReader::new(BufReader::new(file), sevenz_rust2::Password::empty()).map_err(|e| arch_err(archive, e))?;
            reader
                .for_each_entries(|e, r| {
                    let meta = ArchiveEntry {
                        path: norm(e.name()),
                        is_dir: e.is_directory(),
                        size: e.size(),
                        modified_ms: ms(SystemTime::from(e.last_modified_date())),
                    };
                    Ok(f(&meta, r))
                })
                .map_err(|e| arch_err(archive, e))?;
        }
        Format::Tar | Format::TarGz | Format::TarBz2 => {
            let reader: Box<dyn Read> = match format {
                Format::TarGz => Box::new(flate2::read::GzDecoder::new(BufReader::new(file))),
                Format::TarBz2 => Box::new(bzip2::read::BzDecoder::new(BufReader::new(file))),
                _ => Box::new(BufReader::new(file)),
            };
            let mut tar = tar::Archive::new(reader);
            for entry in tar.entries().map_err(|e| arch_err(archive, e))? {
                let mut entry = entry.map_err(|e| arch_err(archive, e))?;
                let path = entry.path().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
                let header = entry.header();
                let meta = ArchiveEntry {
                    path: norm(&path),
                    is_dir: header.entry_type().is_dir(),
                    size: header.size().unwrap_or(0),
                    modified_ms: header.mtime().map_or(0, |s| s as i64 * 1000),
                };
                if !f(&meta, &mut entry) {
                    break;
                }
            }
        }
    }
    Ok(())
}

type Cache = Mutex<HashMap<PathBuf, (u64, i64, Arc<Vec<ArchiveEntry>>)>>;
const CACHE_LIMIT: usize = 8;

fn cache() -> &'static Cache {
    static C: OnceLock<Cache> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// Every entry, including folders implied by file paths, sorted by path.
pub fn entries(archive: &Path) -> Result<Arc<Vec<ArchiveEntry>>> {
    let meta = std::fs::metadata(archive).map_err(|e| Error::io(archive, e))?;
    let stamp = (meta.len(), meta.modified().map(ms).unwrap_or(0));
    if let Ok(c) = cache().lock()
        && let Some((len, modified, list)) = c.get(archive)
        && (*len, *modified) == stamp
    {
        return Ok(list.clone());
    }
    let mut all: BTreeMap<String, ArchiveEntry> = BTreeMap::new();
    for_each(archive, |e, _| {
        if e.path.is_empty() {
            return true;
        }
        // Make sure every ancestor folder exists even if the archive omits it.
        let mut prefix = String::new();
        for part in e.path.split('\\').collect::<Vec<_>>().split_last().map(|(_, dirs)| dirs.to_vec()).unwrap_or_default() {
            if !prefix.is_empty() {
                prefix.push('\\');
            }
            prefix.push_str(part);
            all.entry(prefix.to_lowercase())
                .or_insert_with(|| ArchiveEntry { path: prefix.clone(), is_dir: true, size: 0, modified_ms: e.modified_ms });
        }
        all.insert(e.path.to_lowercase(), e.clone());
        true
    })?;
    let list = Arc::new(all.into_values().collect::<Vec<_>>());
    if let Ok(mut c) = cache().lock() {
        if c.len() >= CACHE_LIMIT {
            c.clear();
        }
        c.insert(archive.to_path_buf(), (stamp.0, stamp.1, list.clone()));
    }
    Ok(list)
}

/// Direct children of folder `inner` ("" for the archive root).
pub fn children(archive: &Path, inner: &str) -> Result<Vec<ArchiveEntry>> {
    let inner = norm(inner).to_lowercase();
    let all = entries(archive)?;
    if !inner.is_empty() && !all.iter().any(|e| e.is_dir && e.path.to_lowercase() == inner) {
        return Err(Error::NotFound(archive.join(&inner)));
    }
    Ok(all
        .iter()
        .filter(|e| {
            let p = e.path.to_lowercase();
            let rest = if inner.is_empty() { Some(p.as_str()) } else { p.strip_prefix(&inner).and_then(|r| r.strip_prefix('\\')) };
            rest.is_some_and(|r| !r.is_empty() && !r.contains('\\'))
        })
        .cloned()
        .collect())
}

/// Reads up to `max` bytes of the file at `inner`.
pub fn read(archive: &Path, inner: &str, max: usize) -> Result<Vec<u8>> {
    let want = norm(inner).to_lowercase();
    let mut out: Option<Vec<u8>> = None;
    for_each(archive, |e, r| {
        if e.is_dir || e.path.to_lowercase() != want {
            return true;
        }
        let mut buf = Vec::with_capacity((e.size as usize).min(max));
        let _ = r.take(max as u64).read_to_end(&mut buf);
        out = Some(buf);
        false
    })?;
    out.ok_or_else(|| Error::NotFound(archive.join(inner)))
}

/// A relative path made only of normal components, or None if it could
/// escape its destination (`..`, roots, drive prefixes).
fn safe_relative(rel: &str) -> Option<PathBuf> {
    let p = Path::new(rel);
    p.components().all(|c| matches!(c, Component::Normal(_))).then(|| p.to_path_buf())
}

#[derive(Debug, Default)]
pub struct ExtractReport {
    pub files: u64,
    pub bytes: u64,
    pub created: Vec<PathBuf>,
    pub errors: Vec<(String, String)>,
}

/// Extracts the given items (files or folders, as inner paths) into `dest`.
/// Each item lands as `dest\<item name>`, numbered if that name is taken.
pub fn extract(
    archive: &Path,
    items: &[String],
    dest: &Path,
    cancel: &CancelToken,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<ExtractReport> {
    let mut report = ExtractReport::default();
    // Map each selected item to its target folder or file name.
    let mut roots: Vec<(String, PathBuf)> = Vec::new();
    let all = entries(archive)?;
    for item in items {
        let item = norm(item);
        let Some(entry) = all.iter().find(|e| e.path.eq_ignore_ascii_case(&item)) else {
            report.errors.push((item.clone(), "not found in the archive".into()));
            continue;
        };
        let target = unique_path(dest, entry.name(), entry.is_dir);
        if entry.is_dir {
            std::fs::create_dir_all(&target).map_err(|e| Error::io(&target, e))?;
        }
        report.created.push(target.clone());
        roots.push((item.to_lowercase(), target));
    }
    let total: u64 = all
        .iter()
        .filter(|e| !e.is_dir && roots.iter().any(|(r, _)| e.path.to_lowercase() == *r || e.path.to_lowercase().starts_with(&format!("{r}\\"))))
        .map(|e| e.size)
        .sum();

    for_each(archive, |e, r| {
        if cancel.is_cancelled() {
            return false;
        }
        let lower = e.path.to_lowercase();
        let Some((root, target)) = roots.iter().find(|(root, _)| lower == *root || lower.starts_with(&format!("{root}\\"))) else {
            return true;
        };
        let rel = &e.path[root.len()..].trim_start_matches('\\');
        let Some(rel) = safe_relative(rel) else {
            report.errors.push((e.path.clone(), "unsafe path skipped".into()));
            return true;
        };
        let out = if rel.as_os_str().is_empty() { target.clone() } else { target.join(rel) };
        if e.is_dir {
            if let Err(err) = std::fs::create_dir_all(&out) {
                report.errors.push((e.path.clone(), err.to_string()));
            }
            return true;
        }
        let write = (|| -> std::io::Result<u64> {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut file = File::create(&out)?;
            std::io::copy(r, &mut file)
        })();
        match write {
            Ok(n) => {
                report.files += 1;
                report.bytes += n;
                on_progress(report.bytes, total);
            }
            Err(err) => report.errors.push((e.path.clone(), err.to_string())),
        }
        true
    })?;
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_zip(path: &Path, files: &[(&str, &[u8])]) {
        let mut w = zip::ZipWriter::new(File::create(path).unwrap());
        for (name, data) in files {
            w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap();
    }

    fn make_targz(path: &Path, files: &[(&str, &[u8])]) {
        let gz = flate2::write::GzEncoder::new(File::create(path).unwrap(), flate2::Compression::fast());
        let mut tar = tar::Builder::new(gz);
        for (name, data) in files {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_mtime(1_700_000_000);
            h.set_cksum();
            tar.append_data(&mut h, name, *data).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap();
    }

    fn fs_dir(p: &Path) {
        std::fs::create_dir_all(p).unwrap();
    }

    #[test]
    fn splits_virtual_paths_only_at_real_archives() {
        let tmp = tempfile::tempdir().unwrap();
        let z = tmp.path().join("a.zip");
        make_zip(&z, &[("x/y.txt", b"1")]);
        let (arc, inner) = split_path(&z.join("x").join("y.txt")).unwrap();
        assert_eq!(arc, z);
        assert_eq!(inner, r"x\y.txt");
        fs_dir(&tmp.path().join("notreal.zip"));
        assert!(split_path(&tmp.path().join("notreal.zip").join("q")).is_none(), "a folder named .zip is not an archive");
    }

    #[test]
    fn lists_zip_folders_including_implied_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let z = tmp.path().join("a.zip");
        make_zip(&z, &[("docs/readme.md", b"# hi"), ("docs/img/logo.png", b"PNG"), ("top.txt", b"t")]);
        let root: Vec<String> = children(&z, "").unwrap().iter().map(|e| e.path.clone()).collect();
        assert_eq!(root, vec!["docs", "top.txt"]);
        let docs = children(&z, "docs").unwrap();
        assert_eq!(docs.iter().map(|e| e.name()).collect::<Vec<_>>(), vec!["img", "readme.md"]);
        assert!(docs[0].is_dir);
        assert_eq!(read(&z, r"docs\readme.md", 1024).unwrap(), b"# hi");
        assert!(children(&z, "missing").is_err());
    }

    #[test]
    fn reads_and_extracts_tar_gz() {
        let tmp = tempfile::tempdir().unwrap();
        let t = tmp.path().join("a.tar.gz");
        make_targz(&t, &[("pkg/bin/tool", b"#!"), ("pkg/README", b"read me")]);
        assert_eq!(read(&t, r"pkg\README", 1024).unwrap(), b"read me");
        let out = tmp.path().join("out");
        fs_dir(&out);
        let r = extract(&t, &["pkg".into()], &out, &CancelToken::default(), |_, _| {}).unwrap();
        assert_eq!(r.files, 2);
        assert_eq!(std::fs::read(out.join("pkg").join("bin").join("tool")).unwrap(), b"#!");
        assert_eq!(r.created, vec![out.join("pkg")]);
    }

    #[test]
    fn extracting_a_single_file_and_keeping_both_names() {
        let tmp = tempfile::tempdir().unwrap();
        let z = tmp.path().join("a.zip");
        make_zip(&z, &[("dir/note.txt", b"n")]);
        std::fs::write(tmp.path().join("note.txt"), b"existing").unwrap();
        let r = extract(&z, &[r"dir\note.txt".into()], tmp.path(), &CancelToken::default(), |_, _| {}).unwrap();
        assert_eq!(r.created, vec![tmp.path().join("note (2).txt")]);
        assert_eq!(std::fs::read(tmp.path().join("note.txt")).unwrap(), b"existing");
    }

    #[test]
    fn lists_reads_and_extracts_7z() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        fs_dir(&src.join("inner"));
        std::fs::write(src.join("inner").join("a.txt"), b"seven").unwrap();
        let archive = tmp.path().join("a.7z");
        sevenz_rust2::compress_to_path(&src, &archive).unwrap();
        let root = children(&archive, "").unwrap();
        assert!(root.iter().any(|e| e.name() == "inner" && e.is_dir), "{root:?}");
        assert_eq!(read(&archive, r"inner\a.txt", 1024).unwrap(), b"seven");
        let out = tmp.path().join("out");
        fs_dir(&out);
        extract(&archive, &["inner".into()], &out, &CancelToken::default(), |_, _| {}).unwrap();
        assert_eq!(std::fs::read(out.join("inner").join("a.txt")).unwrap(), b"seven");
    }

    #[test]
    fn refuses_paths_that_escape_the_destination() {
        assert!(safe_relative(r"a\b.txt").is_some());
        assert!(safe_relative(r"..\evil.txt").is_none());
        assert!(safe_relative(r"a\..\..\evil.txt").is_none());
        assert!(safe_relative(r"C:\Windows\evil.dll").is_none());
        assert!(safe_relative(r"\rooted").is_none());
    }

    #[test]
    fn listing_cache_notices_a_changed_archive() {
        let tmp = tempfile::tempdir().unwrap();
        let z = tmp.path().join("a.zip");
        make_zip(&z, &[("one.txt", b"1")]);
        assert_eq!(children(&z, "").unwrap().len(), 1);
        std::thread::sleep(std::time::Duration::from_millis(20));
        make_zip(&z, &[("one.txt", b"1"), ("two.txt", b"22")]);
        assert_eq!(children(&z, "").unwrap().len(), 2);
    }
}
