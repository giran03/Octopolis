//! Creating archives from a selection: `.zip`, `.7z` and `.tar.gz`.
//! The archive is written to a `.part` file and renamed when complete, so a
//! cancelled or failed run never leaves a broken archive behind.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::names::unique_path;
use crate::ops::CancelToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    Zip,
    SevenZ,
    TarGz,
}

impl ArchiveFormat {
    pub fn extension(self) -> &'static str {
        match self {
            ArchiveFormat::Zip => "zip",
            ArchiveFormat::SevenZ => "7z",
            ArchiveFormat::TarGz => "tar.gz",
        }
    }
}

/// One file or folder to store, with its name inside the archive (`/`-separated).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub path: PathBuf,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

/// Everything under `sources`, named relative to each source's parent folder.
/// Links and junctions are not followed, so a loop can't make the archive endless.
pub fn collect(sources: &[PathBuf]) -> Result<Vec<Item>> {
    fn walk(path: &Path, name: String, out: &mut Vec<Item>) -> Result<()> {
        let meta = path.symlink_metadata().map_err(|e| Error::io(path, e))?;
        if meta.file_type().is_symlink() {
            return Ok(());
        }
        if meta.is_dir() {
            out.push(Item { path: path.to_path_buf(), name: name.clone(), is_dir: true, size: 0 });
            let mut children: Vec<_> = fs::read_dir(path).map_err(|e| Error::io(path, e))?.flatten().collect();
            children.sort_by_key(|c| c.file_name());
            for child in children {
                walk(&child.path(), format!("{name}/{}", child.file_name().to_string_lossy()), out)?;
            }
        } else {
            out.push(Item { path: path.to_path_buf(), name, is_dir: false, size: meta.len() });
        }
        Ok(())
    }
    let mut out = Vec::new();
    for s in sources {
        let name = s.file_name().ok_or_else(|| Error::io(s, io::Error::other("a drive can't be put in an archive")))?;
        walk(s, name.to_string_lossy().into_owned(), &mut out)?;
    }
    Ok(out)
}

/// Counts bytes read and stops (with an error) once the job is cancelled.
struct Tracked<'a, R> {
    inner: R,
    cancel: &'a CancelToken,
    on_bytes: &'a mut dyn FnMut(u64),
}

impl<R: Read> Read for Tracked<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        while self.cancel.is_paused() && !self.cancel.is_cancelled() {
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        if self.cancel.is_cancelled() {
            return Err(io::Error::other("cancelled"));
        }
        let n = self.inner.read(buf)?;
        (self.on_bytes)(n as u64);
        Ok(n)
    }
}

/// Packs `sources` into a new archive named `name` (extension added if
/// missing) in `dest`, numbering it if taken. Reports `(done, total)` bytes.
/// Returns the archive's path.
pub fn compress(
    sources: &[PathBuf],
    dest: &Path,
    name: &str,
    format: ArchiveFormat,
    cancel: &CancelToken,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<PathBuf> {
    crate::names::validate_name(name)?;
    let ext = format!(".{}", format.extension());
    let file_name = if name.to_ascii_lowercase().ends_with(&ext) { name.to_string() } else { format!("{name}{ext}") };
    let target = unique_path(dest, &file_name, false);
    let items = collect(sources)?;
    let total: u64 = items.iter().map(|i| i.size).sum();
    let part = target.with_file_name(format!("{}.part", target.file_name().unwrap_or_default().to_string_lossy()));
    let mut done = 0u64;
    let mut on_bytes = |n: u64| {
        done += n;
        on_progress(done, total);
    };
    let result = match format {
        ArchiveFormat::Zip => write_zip(&part, &items, cancel, &mut on_bytes),
        ArchiveFormat::SevenZ => write_7z(&part, &items, cancel, &mut on_bytes),
        ArchiveFormat::TarGz => write_tar_gz(&part, &items, cancel, &mut on_bytes),
    };
    if let Err(e) = result {
        let _ = fs::remove_file(&part);
        return Err(if cancel.is_cancelled() { Error::io(&target, io::Error::other("cancelled")) } else { e });
    }
    fs::rename(&part, &target).map_err(|e| {
        let _ = fs::remove_file(&part);
        Error::io(&target, e)
    })?;
    Ok(target)
}

fn write_zip(out: &Path, items: &[Item], cancel: &CancelToken, on_bytes: &mut dyn FnMut(u64)) -> Result<()> {
    use zip::write::SimpleFileOptions;
    let file = File::create(out).map_err(|e| Error::io(out, e))?;
    let mut zip = zip::ZipWriter::new(file);
    let fail = |p: &Path, e: zip::result::ZipError| Error::io(p, io::Error::other(e.to_string()));
    for item in items {
        let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(item.size >= u32::MAX as u64);
        if item.is_dir {
            zip.add_directory(format!("{}/", item.name), options).map_err(|e| fail(&item.path, e))?;
            continue;
        }
        zip.start_file(item.name.as_str(), options).map_err(|e| fail(&item.path, e))?;
        let src = File::open(&item.path).map_err(|e| Error::io(&item.path, e))?;
        let mut reader = Tracked { inner: src, cancel, on_bytes: &mut *on_bytes };
        io::copy(&mut reader, &mut zip).map_err(|e| Error::io(&item.path, e))?;
    }
    zip.finish().map_err(|e| fail(out, e))?;
    Ok(())
}

fn write_7z(out: &Path, items: &[Item], cancel: &CancelToken, on_bytes: &mut dyn FnMut(u64)) -> Result<()> {
    use sevenz_rust2::{ArchiveEntry, ArchiveWriter};
    let fail = |p: &Path, e: sevenz_rust2::Error| Error::io(p, io::Error::other(e.to_string()));
    let mut sz = ArchiveWriter::create(out).map_err(|e| fail(out, e))?;
    for item in items {
        let entry = ArchiveEntry::from_path(&item.path, item.name.clone());
        if item.is_dir {
            sz.push_archive_entry::<File>(entry, None).map_err(|e| fail(&item.path, e))?;
            continue;
        }
        let src = File::open(&item.path).map_err(|e| Error::io(&item.path, e))?;
        let reader = Tracked { inner: src, cancel, on_bytes: &mut *on_bytes };
        sz.push_archive_entry(entry, Some(reader)).map_err(|e| fail(&item.path, e))?;
    }
    sz.finish().map_err(|e| Error::io(out, e))?;
    Ok(())
}

fn write_tar_gz(out: &Path, items: &[Item], cancel: &CancelToken, on_bytes: &mut dyn FnMut(u64)) -> Result<()> {
    let file = File::create(out).map_err(|e| Error::io(out, e))?;
    let gz = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut tar = tar::Builder::new(gz);
    for item in items {
        let meta = item.path.metadata().map_err(|e| Error::io(&item.path, e))?;
        let mut header = tar::Header::new_gnu();
        header.set_metadata(&meta);
        if item.is_dir {
            header.set_size(0);
            tar.append_data(&mut header, format!("{}/", item.name), io::empty()).map_err(|e| Error::io(&item.path, e))?;
            continue;
        }
        let src = File::open(&item.path).map_err(|e| Error::io(&item.path, e))?;
        let reader = Tracked { inner: src, cancel, on_bytes: &mut *on_bytes };
        tar.append_data(&mut header, &item.name, reader).map_err(|e| Error::io(&item.path, e))?;
    }
    let gz = tar.into_inner().map_err(|e| Error::io(out, e))?;
    gz.finish().map_err(|e| Error::io(out, e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(root: &Path) -> PathBuf {
        let src = root.join("project");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a.txt"), b"hello").unwrap();
        fs::write(src.join("sub/b.bin"), vec![7u8; 5000]).unwrap();
        src
    }

    #[test]
    fn every_format_round_trips_through_the_archive_reader() {
        let tmp = tempfile::tempdir().unwrap();
        let src = sample(tmp.path());
        for format in [ArchiveFormat::Zip, ArchiveFormat::SevenZ, ArchiveFormat::TarGz] {
            let mut last = (0, 0);
            let out = compress(std::slice::from_ref(&src), tmp.path(), "project", format, &CancelToken::default(), |d, t| last = (d, t)).unwrap();
            assert!(out.to_string_lossy().ends_with(format.extension()), "{out:?}");
            assert_eq!(last, (5005, 5005), "{format:?} progress");
            let names: Vec<String> = crate::archive::entries(&out).unwrap().iter().filter(|e| !e.is_dir).map(|e| e.path.replace('/', "\\")).collect();
            assert!(names.iter().any(|n| n.ends_with("project\\a.txt")), "{format:?}: {names:?}");
            assert!(names.iter().any(|n| n.ends_with("project\\sub\\b.bin")), "{format:?}: {names:?}");
        }
    }

    #[test]
    fn names_are_numbered_and_cancel_leaves_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let src = sample(tmp.path());
        let first = compress(std::slice::from_ref(&src), tmp.path(), "x", ArchiveFormat::Zip, &CancelToken::default(), |_, _| {}).unwrap();
        let second = compress(std::slice::from_ref(&src), tmp.path(), "x.zip", ArchiveFormat::Zip, &CancelToken::default(), |_, _| {}).unwrap();
        assert_eq!(first.file_name().unwrap(), "x.zip");
        assert_eq!(second.file_name().unwrap(), "x (2).zip");

        let cancel = CancelToken::default();
        cancel.cancel();
        assert!(compress(std::slice::from_ref(&src), tmp.path(), "gone", ArchiveFormat::Zip, &cancel, |_, _| {}).is_err());
        let leftovers: Vec<_> = fs::read_dir(tmp.path()).unwrap().flatten().map(|e| e.file_name()).filter(|n| n.to_string_lossy().starts_with("gone")).collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }
}
