//! Image tools: find similar pictures, and resize or convert a batch.
//!
//! Similarity uses a difference hash (dHash): each picture is shrunk to 9x8 grey pixels and
//! each pixel is compared with its right-hand neighbour, giving 64 bits that survive resizing,
//! recompression and small edits. Pictures whose hashes differ in only a few bits are "similar".

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use image::imageops::FilterType;
use rayon::prelude::*;

use crate::dupes::{DupeFile, DupeGroup};
use crate::error::{Error, Result};
use crate::ops::CancelToken;

const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp"];
/// Skip very large files: decoding them would dominate the scan.
const MAX_BYTES: u64 = 60 * 1024 * 1024;
const MAX_IMAGES: usize = 20_000;
const REPARSE_POINT: u32 = 0x400;

pub fn is_image(path: &Path) -> bool {
    path.extension().is_some_and(|e| IMAGE_EXTS.iter().any(|x| e.eq_ignore_ascii_case(x)))
}

/// The 64-bit difference hash of an image.
pub fn dhash(img: &image::DynamicImage) -> u64 {
    let small = img.resize_exact(9, 8, FilterType::Triangle).to_luma8();
    let mut hash = 0u64;
    for y in 0..8u32 {
        for x in 0..8u32 {
            hash <<= 1;
            if small.get_pixel(x, y)[0] > small.get_pixel(x + 1, y)[0] {
                hash |= 1;
            }
        }
    }
    hash
}

fn collect(dir: &Path, out: &mut Vec<(PathBuf, u64, i64)>, cancel: &CancelToken) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        if cancel.is_cancelled() || out.len() >= MAX_IMAGES {
            return;
        }
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        #[cfg(windows)]
        let link = {
            use std::os::windows::fs::MetadataExt;
            meta.file_attributes() & (REPARSE_POINT | 0x0040_0000 | 0x0004_0000 | 0x1000) != 0
        };
        #[cfg(not(windows))]
        let link = meta.file_type().is_symlink();
        if link {
            continue;
        }
        if meta.is_dir() {
            collect(&path, out, cancel);
        } else if is_image(&path) && meta.len() <= MAX_BYTES && meta.len() > 0 {
            let modified = meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64);
            out.push((path, meta.len(), modified));
        }
    }
}

/// Groups of pictures under `root` whose hashes are within `max_distance` bits (0 = identical look,
/// 6-10 = same picture resized or recompressed). `on_progress` gets (pictures read, pictures found).
pub fn find_similar(root: &Path, max_distance: u32, cancel: &CancelToken, on_progress: &(dyn Fn(u64, u64) + Sync)) -> Result<Vec<DupeGroup>> {
    let mut files = Vec::new();
    collect(root, &mut files, cancel);
    let total = files.len() as u64;
    let done = AtomicU64::new(0);
    let hashed: Vec<Option<u64>> = files
        .par_iter()
        .map(|(path, _, _)| {
            if cancel.is_cancelled() {
                return None;
            }
            let h = image::open(path).ok().map(|img| dhash(&img));
            on_progress(done.fetch_add(1, Ordering::Relaxed) + 1, total);
            h
        })
        .collect();
    Ok(group(&files, &hashed, max_distance))
}

/// Union-find over pairs within the distance, then the groups with two or more pictures.
fn group(files: &[(PathBuf, u64, i64)], hashes: &[Option<u64>], max_distance: u32) -> Vec<DupeGroup> {
    let items: Vec<usize> = (0..files.len()).filter(|&i| hashes[i].is_some()).collect();
    let mut parent: Vec<usize> = (0..files.len()).collect();
    fn find(parent: &mut [usize], mut x: usize) -> usize {
        while parent[x] != x {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        x
    }
    for (a, &i) in items.iter().enumerate() {
        let hi = hashes[i].unwrap_or(0);
        for &j in &items[a + 1..] {
            if (hi ^ hashes[j].unwrap_or(0)).count_ones() <= max_distance {
                let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
                if ri != rj {
                    parent[ri] = rj;
                }
            }
        }
    }
    let mut buckets: std::collections::HashMap<usize, Vec<usize>> = std::collections::HashMap::new();
    for &i in &items {
        let root = find(&mut parent, i);
        buckets.entry(root).or_default().push(i);
    }
    let mut groups: Vec<DupeGroup> = buckets
        .into_values()
        .filter(|g| g.len() > 1)
        .map(|g| {
            let mut members: Vec<DupeFile> = g.iter().map(|&i| DupeFile { path: files[i].0.clone(), modified_ms: files[i].2 }).collect();
            members.sort_by_key(|f| std::cmp::Reverse(f.modified_ms));
            let size = g.iter().map(|&i| files[i].1).max().unwrap_or(0);
            DupeGroup { size, files: members }
        })
        .collect();
    groups.sort_by_key(|g| std::cmp::Reverse(g.size * g.files.len() as u64));
    groups
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Jpeg,
    Png,
    /// Lossless WebP.
    Webp,
}

impl Format {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "jpeg" | "jpg" => Some(Format::Jpeg),
            "png" => Some(Format::Png),
            "webp" => Some(Format::Webp),
            _ => None,
        }
    }

    fn ext(self) -> &'static str {
        match self {
            Format::Jpeg => "jpg",
            Format::Png => "png",
            Format::Webp => "webp",
        }
    }
}

/// What to do to each picture. Re-encoding also drops metadata such as camera details and location.
#[derive(Debug, Clone, Copy)]
pub struct ConvertOptions {
    /// Longest side in pixels; pictures already smaller are not enlarged.
    pub max_edge: Option<u32>,
    /// Output format; `None` keeps each picture's own.
    pub format: Option<Format>,
    /// JPEG quality, 1-100.
    pub quality: u8,
}

fn unique(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    (2..10_000).map(|n| dir.join(format!("{stem} ({n}).{ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

/// Writes a resized and/or converted copy of `src` into `out_dir` (the original is never changed).
pub fn convert(src: &Path, out_dir: &Path, opts: ConvertOptions) -> Result<PathBuf> {
    let fail = |msg: String| Error::io(src, std::io::Error::other(msg));
    let img = image::open(src).map_err(|e| fail(e.to_string()))?;
    let (w, h) = (img.width(), img.height());
    let img = match opts.max_edge {
        Some(edge) if edge > 0 && w.max(h) > edge => img.resize(edge, edge, FilterType::Lanczos3),
        _ => img,
    };
    let own = src.extension().and_then(|e| e.to_str()).and_then(|e| Format::parse(&e.to_ascii_lowercase())).unwrap_or(Format::Png);
    let format = opts.format.unwrap_or(own);
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "image".into());
    let resized = img.width() != w || img.height() != h;
    let stem = if resized && opts.format.is_none() { format!("{stem} ({}px)", opts.max_edge.unwrap_or(0)) } else if opts.format.is_some() || resized { stem } else { format!("{stem} (copy)") };
    std::fs::create_dir_all(out_dir).map_err(|e| Error::io(out_dir, e))?;
    let out = unique(out_dir, &stem, format.ext());
    let mut file = std::fs::File::create(&out).map_err(|e| Error::io(&out, e))?;
    let write = match format {
        Format::Jpeg => img.to_rgb8().write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, opts.quality.clamp(1, 100))),
        Format::Png => img.write_with_encoder(image::codecs::png::PngEncoder::new(&mut file)),
        Format::Webp => img.write_with_encoder(image::codecs::webp::WebPEncoder::new_lossless(&mut file)),
    };
    if let Err(e) = write {
        drop(file);
        let _ = std::fs::remove_file(&out);
        return Err(fail(e.to_string()));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, Rgb, RgbImage};

    fn gradient(w: u32, h: u32, invert: bool) -> DynamicImage {
        let img = RgbImage::from_fn(w, h, |x, _| {
            let v = (x * 255 / w.max(1)) as u8;
            Rgb(if invert { [255 - v; 3] } else { [v; 3] })
        });
        DynamicImage::ImageRgb8(img)
    }

    #[test]
    fn hash_survives_resizing_but_not_inversion() {
        let a = dhash(&gradient(200, 100, false));
        let b = dhash(&gradient(80, 40, false));
        let c = dhash(&gradient(200, 100, true));
        assert!((a ^ b).count_ones() <= 4, "resized copy stays close");
        assert!((a ^ c).count_ones() > 20, "inverted picture is far away");
    }

    #[test]
    fn grouping_joins_close_hashes_only() {
        let files: Vec<(PathBuf, u64, i64)> = ["a", "b", "c", "d"].iter().enumerate().map(|(i, n)| (PathBuf::from(n), 10 + i as u64, i as i64)).collect();
        let hashes = vec![Some(0b0000u64), Some(0b0011), Some(u64::MAX), None];
        let groups = group(&files, &hashes, 4);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].files.len(), 2);
    }

    #[test]
    fn converts_and_resizes_without_touching_the_original() {
        let base = std::env::temp_dir().join(format!("octopolis-img-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let src = base.join("pic.png");
        gradient(400, 200, false).save(&src).unwrap();
        let before = std::fs::read(&src).unwrap();
        let out = convert(&src, &base.join("out"), ConvertOptions { max_edge: Some(100), format: Some(Format::Jpeg), quality: 80 }).unwrap();
        assert_eq!(out.extension().unwrap(), "jpg");
        let small = image::open(&out).unwrap();
        assert_eq!((small.width(), small.height()), (100, 50));
        assert_eq!(std::fs::read(&src).unwrap(), before);
        // A second run doesn't overwrite.
        let again = convert(&src, &base.join("out"), ConvertOptions { max_edge: Some(100), format: Some(Format::Jpeg), quality: 80 }).unwrap();
        assert_ne!(out, again);
        let _ = std::fs::remove_dir_all(base);
    }
}
