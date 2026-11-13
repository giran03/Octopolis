//! File metadata used by batch rename templates and the inspector:
//! EXIF (photos) and ID3 (MP3 audio).

use std::collections::BTreeMap;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// Rich label/value pairs shown by the inspector's media details toggle (images & videos).
pub fn media_details(path: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "png" => {
            png_details(path, &mut out);
            exif_details(path, &mut out);
        }
        "gif" => gif_details(path, &mut out),
        "jpg" | "jpeg" | "tif" | "tiff" | "heic" | "webp" | "avif" => exif_details(path, &mut out),
        "mp4" | "m4v" | "mov" => mp4_details(path, &mut out),
        _ => {}
    }
    out
}

/// Alias kept for image-specific callers and tests.
pub fn image_details(path: &Path) -> Vec<(String, String)> {
    media_details(path)
}

fn png_details(path: &Path, out: &mut Vec<(String, String)>) {
    let Ok(file) = std::fs::File::open(path) else { return };
    let Ok(reader) = png::Decoder::new(BufReader::new(file)).read_info() else { return };
    let info = reader.info();
    let color = match info.color_type {
        png::ColorType::Grayscale => "Grayscale",
        png::ColorType::Rgb => "RGB",
        png::ColorType::Indexed => "Indexed palette",
        png::ColorType::GrayscaleAlpha => "Grayscale + Alpha",
        png::ColorType::Rgba => "RGBA",
    };
    let bits = match info.bit_depth {
        png::BitDepth::One => "1-bit",
        png::BitDepth::Two => "2-bit",
        png::BitDepth::Four => "4-bit",
        png::BitDepth::Eight => "8-bit",
        png::BitDepth::Sixteen => "16-bit",
    };
    out.push(("Color".into(), format!("{color} · {bits}")));
    if let Some(actl) = info.animation_control {
        out.push(("Animation".into(), format!("APNG · {} frames", actl.num_frames)));
    }
}

fn gif_details(path: &Path, out: &mut Vec<(String, String)>) {
    let Ok(mut file) = std::fs::File::open(path) else { return };
    let mut hdr = [0u8; 13];
    if file.read_exact(&mut hdr).is_err() {
        return;
    }
    if &hdr[..3] != b"GIF" {
        return;
    }
    let version = String::from_utf8_lossy(&hdr[..6]).into_owned();
    out.push(("Format spec".into(), version));
    let packed = hdr[10];
    if packed & 0x80 != 0 {
        let colors = 1usize << ((packed & 0x07) + 1);
        out.push(("Palette".into(), format!("{colors} colors")));
    }
}

fn exif_details(path: &Path, out: &mut Vec<(String, String)>) {
    let Ok(file) = std::fs::File::open(path) else { return };
    let Ok(data) = exif::Reader::new().read_from_container(&mut BufReader::new(file)) else { return };
    let get = |tag| {
        data.get_field(tag, exif::In::PRIMARY)
            .map(|f| f.display_value().with_unit(&data).to_string().trim_matches('"').trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let push = |out: &mut Vec<(String, String)>, label: &str, val: Option<String>| {
        if let Some(v) = val {
            out.push((label.into(), v));
        }
    };

    let make = get(exif::Tag::Make);
    let model = get(exif::Tag::Model);
    let camera = match (make.as_deref(), model.as_deref()) {
        (Some(mk), Some(md)) if !md.to_lowercase().starts_with(&mk.to_lowercase()) => Some(format!("{mk} {md}")),
        (_, Some(md)) => Some(md.to_string()),
        (Some(mk), None) => Some(mk.to_string()),
        (None, None) => None,
    };
    push(out, "Camera", camera);
    push(out, "Lens", get(exif::Tag::LensModel));
    push(out, "Captured", get(exif::Tag::DateTimeOriginal).or_else(|| get(exif::Tag::DateTime)));
    push(out, "Exposure", get(exif::Tag::ExposureTime));
    push(out, "Aperture", get(exif::Tag::FNumber));
    push(out, "ISO", get(exif::Tag::PhotographicSensitivity).map(|v| format!("ISO {v}")));
    let focal = match (get(exif::Tag::FocalLength), get(exif::Tag::FocalLengthIn35mmFilm)) {
        (Some(f), Some(f35)) if f != f35 => Some(format!("{f} ({f35} eq.)")),
        (Some(f), _) => Some(f),
        (None, Some(f35)) => Some(f35),
        _ => None,
    };
    push(out, "Focal length", focal);
    push(out, "Color space", get(exif::Tag::ColorSpace));
    push(out, "Orientation", get(exif::Tag::Orientation));
    push(out, "Software", get(exif::Tag::Software));
    if let (Some(lat), Some(lon)) = (get(exif::Tag::GPSLatitude), get(exif::Tag::GPSLongitude)) {
        let lat_ref = get(exif::Tag::GPSLatitudeRef).unwrap_or_default();
        let lon_ref = get(exif::Tag::GPSLongitudeRef).unwrap_or_default();
        out.push(("Location".into(), format!("{lat} {lat_ref}, {lon} {lon_ref}").trim().to_string()));
    }
}

fn format_duration_secs(secs: f64) -> String {
    if !secs.is_finite() || secs <= 0.0 {
        return String::new();
    }
    let total = secs.round() as u64;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

fn mp4_codec_name(fourcc: &[u8]) -> Option<&'static str> {
    match fourcc {
        b"avc1" | b"avc3" => Some("H.264 (AVC)"),
        b"hvc1" | b"hev1" => Some("H.265 (HEVC)"),
        b"av01" => Some("AV1"),
        b"vp09" => Some("VP9"),
        b"vp08" => Some("VP8"),
        b"mp4v" => Some("MPEG-4"),
        b"apch" | b"apcn" | b"apcs" | b"apco" | b"ap4h" => Some("Apple ProRes"),
        b"mp4a" => Some("AAC"),
        b"Opus" => Some("Opus"),
        b"alac" => Some("ALAC"),
        b"ac-3" => Some("AC-3"),
        b"ec-3" => Some("E-AC-3"),
        b"fLaC" => Some("FLAC"),
        b"lpcm" | b"sowt" | b"twos" => Some("PCM"),
        _ => None,
    }
}

fn mp4_details(path: &Path, out: &mut Vec<(String, String)>) {
    const MAX_MOOV_BYTES: u64 = 8 * 1024 * 1024;
    let Ok(mut file) = std::fs::File::open(path) else { return };
    let Ok(file_len) = file.metadata().map(|m| m.len()) else { return };

    let mut pos = 0u64;
    let mut hdr = [0u8; 8];
    let mut moov_buf: Option<Vec<u8>> = None;

    for _ in 0..256 {
        if pos + 8 > file_len {
            break;
        }
        if file.seek(SeekFrom::Start(pos)).is_err() || file.read_exact(&mut hdr).is_err() {
            break;
        }
        let size32 = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as u64;
        let kind = [hdr[4], hdr[5], hdr[6], hdr[7]];
        let (header_len, atom_len) = if size32 == 1 {
            let mut ext = [0u8; 8];
            if pos + 16 > file_len || file.read_exact(&mut ext).is_err() {
                break;
            }
            (16u64, u64::from_be_bytes(ext))
        } else if size32 == 0 {
            (8u64, file_len - pos)
        } else {
            (8u64, size32)
        };
        if atom_len < header_len || pos + atom_len > file_len {
            break;
        }
        if &kind == b"moov" {
            let payload_len = atom_len - header_len;
            if payload_len <= MAX_MOOV_BYTES {
                let mut buf = vec![0u8; payload_len as usize];
                if file.read_exact(&mut buf).is_ok() {
                    moov_buf = Some(buf);
                }
            }
            break;
        }
        pos += atom_len;
    }

    let Some(moov) = moov_buf else { return };
    parse_moov(&moov, out);
}

fn parse_moov(moov: &[u8], out: &mut Vec<(String, String)>) {
    let mut duration: Option<String> = None;
    let mut res: Option<(u32, u32)> = None;
    let mut vcodec: Option<&'static str> = None;
    let mut acodec: Option<&'static str> = None;

    walk_atoms(moov, |kind, body| match kind {
        b"mvhd" if body.len() >= 20 => {
            let (scale, dur) = if body[0] == 1 && body.len() >= 32 {
                (
                    u32::from_be_bytes([body[20], body[21], body[22], body[23]]) as f64,
                    u64::from_be_bytes([body[24], body[25], body[26], body[27], body[28], body[29], body[30], body[31]]) as f64,
                )
            } else {
                (
                    u32::from_be_bytes([body[12], body[13], body[14], body[15]]) as f64,
                    u32::from_be_bytes([body[16], body[17], body[18], body[19]]) as f64,
                )
            };
            if scale > 0.0 && dur > 0.0 {
                let fmt = format_duration_secs(dur / scale);
                if !fmt.is_empty() {
                    duration = Some(fmt);
                }
            }
        }
        b"trak" => {
            let (dims, handler, codec) = parse_trak(body);
            if handler == Some(*b"vide") {
                if dims.is_some() && res.is_none() {
                    res = dims;
                }
                if codec.is_some() && vcodec.is_none() {
                    vcodec = codec;
                }
            } else if handler == Some(*b"soun") && codec.is_some() && acodec.is_none() {
                acodec = codec;
            }
        }
        _ => {}
    });

    if let Some((w, h)) = res {
        out.push(("Resolution".into(), format!("{w} × {h} px")));
    }
    if let Some(d) = duration {
        out.push(("Duration".into(), d));
    }
    if let Some(c) = vcodec {
        out.push(("Video codec".into(), c.into()));
    }
    if let Some(c) = acodec {
        out.push(("Audio codec".into(), c.into()));
    }
}

type TrakInfo = (Option<(u32, u32)>, Option<[u8; 4]>, Option<&'static str>);

fn parse_trak(trak: &[u8]) -> TrakInfo {
    let mut dims = None;
    let mut handler = None;
    let mut codec = None;
    walk_atoms(trak, |kind, body| match kind {
        b"tkhd" => {
            let off = if body.first() == Some(&1) { 88 } else { 76 };
            if body.len() >= off + 8 {
                let w = u32::from_be_bytes([body[off], body[off + 1], body[off + 2], body[off + 3]]) >> 16;
                let h = u32::from_be_bytes([body[off + 4], body[off + 5], body[off + 6], body[off + 7]]) >> 16;
                if w > 0 && h > 0 {
                    dims = Some((w, h));
                }
            }
        }
        b"mdia" => {
            walk_atoms(body, |mk, mbody| match mk {
                b"hdlr" if mbody.len() >= 12 => {
                    handler = Some([mbody[8], mbody[9], mbody[10], mbody[11]]);
                }
                b"minf" => {
                    walk_atoms(mbody, |ik, ibody| {
                        if ik == b"stbl" {
                            walk_atoms(ibody, |sk, sbody| {
                                if sk == b"stsd" && sbody.len() >= 16 {
                                    codec = codec.or_else(|| mp4_codec_name(&sbody[12..16]));
                                }
                            });
                        }
                    });
                }
                _ => {}
            });
        }
        _ => {}
    });
    (dims, handler, codec)
}

fn walk_atoms(mut buf: &[u8], mut f: impl FnMut(&[u8; 4], &[u8])) {
    while buf.len() >= 8 {
        let size = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        let kind: [u8; 4] = [buf[4], buf[5], buf[6], buf[7]];
        if size < 8 || size > buf.len() {
            break;
        }
        f(&kind, &buf[8..size]);
        buf = &buf[size..];
    }
}

/// Tag values keyed by template name: `exif:date`, `exif:camera`, `exif:model`,
/// `id3:artist`, `id3:title`, `id3:album`, `id3:track`, `id3:year`.
pub fn tags(path: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" | "tif" | "tiff" | "heic" | "png" | "webp" => exif_tags(path, &mut out),
        "mp3" => id3_tags(path, &mut out),
        _ => {}
    }
    out
}

fn exif_tags(path: &Path, out: &mut BTreeMap<String, String>) {
    let Ok(file) = std::fs::File::open(path) else { return };
    let Ok(data) = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(file)) else { return };
    let get = |tag| data.get_field(tag, exif::In::PRIMARY).map(|f| f.display_value().to_string().trim_matches('"').trim().to_string());
    if let Some(d) = get(exif::Tag::DateTimeOriginal).or_else(|| get(exif::Tag::DateTime)) {
        // "2024-05-01 13:45:12" → date and time parts usable in file names.
        let d = d.replace(':', "-");
        let (date, time) = d.split_once(' ').unwrap_or((&d, ""));
        out.insert("exif:date".into(), date.into());
        out.insert("exif:time".into(), time.replace('-', ""));
    }
    if let Some(make) = get(exif::Tag::Make) {
        out.insert("exif:make".into(), make);
    }
    if let Some(model) = get(exif::Tag::Model) {
        out.insert("exif:model".into(), model.clone());
        let camera = match out.get("exif:make") {
            Some(make) if !model.to_lowercase().starts_with(&make.to_lowercase()) => format!("{make} {model}"),
            _ => model,
        };
        out.insert("exif:camera".into(), camera);
    }
}

fn id3_tags(path: &Path, out: &mut BTreeMap<String, String>) {
    use id3::TagLike;
    let Ok(tag) = id3::Tag::read_from_path(path) else { return };
    let mut put = |k: &str, v: Option<String>| {
        if let Some(v) = v.filter(|v| !v.trim().is_empty()) {
            out.insert(k.into(), v.trim().to_string());
        }
    };
    put("id3:artist", tag.artist().map(str::to_string));
    put("id3:title", tag.title().map(str::to_string));
    put("id3:album", tag.album().map(str::to_string));
    put("id3:track", tag.track().map(|t| format!("{t:02}")));
    put("id3:year", tag.year().map(|y| y.to_string()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_id3_tags() {
        use id3::TagLike;
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("song.mp3");
        std::fs::write(&f, b"").unwrap();
        let mut tag = id3::Tag::new();
        tag.set_artist("Octo Band");
        tag.set_title("Ink");
        tag.set_track(3);
        tag.write_to_path(&f, id3::Version::Id3v24).unwrap();
        let t = tags(&f);
        assert_eq!(t["id3:artist"], "Octo Band");
        assert_eq!(t["id3:title"], "Ink");
        assert_eq!(t["id3:track"], "03");
    }

    #[test]
    fn files_without_metadata_have_no_tags() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("x.jpg");
        std::fs::write(&f, b"not really a jpeg").unwrap();
        assert!(tags(&f).is_empty());
    }

    #[test]
    fn reads_png_and_gif_header_details() {
        let tmp = tempfile::tempdir().unwrap();
        let png_path = tmp.path().join("sample.png");
        let file = std::fs::File::create(&png_path).unwrap();
        let mut enc = png::Encoder::new(file, 2, 2);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().unwrap();
        writer.write_image_data(&[255; 16]).unwrap();

        let png_info = image_details(&png_path);
        assert!(png_info.iter().any(|(k, v)| k == "Color" && v == "RGBA · 8-bit"));

        let gif_path = tmp.path().join("anim.gif");
        // GIF89a header with global color table bit (0x80) + 3-bit depth index (= 2^(3+1) = 16 colors).
        let hdr = [b'G', b'I', b'F', b'8', b'9', b'a', 1, 0, 1, 0, 0x83, 0, 0];
        std::fs::write(&gif_path, hdr).unwrap();

        let gif_info = image_details(&gif_path);
        assert!(gif_info.iter().any(|(k, v)| k == "Format spec" && v == "GIF89a"));
        assert!(gif_info.iter().any(|(k, v)| k == "Palette" && v == "16 colors"));
    }

    fn atom(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn reads_mp4_header_details() {
        let tmp = tempfile::tempdir().unwrap();
        let mp4_path = tmp.path().join("clip.mp4");

        let mut mvhd_body = vec![0u8; 24];
        mvhd_body[12..16].copy_from_slice(&1000u32.to_be_bytes());
        mvhd_body[16..20].copy_from_slice(&65_000u32.to_be_bytes());
        let mvhd = atom(b"mvhd", &mvhd_body);

        let mut tkhd_body = vec![0u8; 84];
        tkhd_body[76..80].copy_from_slice(&(1920u32 << 16).to_be_bytes());
        tkhd_body[80..84].copy_from_slice(&(1080u32 << 16).to_be_bytes());
        let tkhd = atom(b"tkhd", &tkhd_body);

        let mut hdlr_v = vec![0u8; 16];
        hdlr_v[8..12].copy_from_slice(b"vide");
        let mut stsd_v = vec![0u8; 16];
        stsd_v[12..16].copy_from_slice(b"avc1");
        let v_minf = atom(b"minf", &atom(b"stbl", &atom(b"stsd", &stsd_v)));
        let v_trak = atom(b"trak", &[tkhd, atom(b"mdia", &[atom(b"hdlr", &hdlr_v), v_minf].concat())].concat());

        let mut hdlr_a = vec![0u8; 16];
        hdlr_a[8..12].copy_from_slice(b"soun");
        let mut stsd_a = vec![0u8; 16];
        stsd_a[12..16].copy_from_slice(b"mp4a");
        let a_minf = atom(b"minf", &atom(b"stbl", &atom(b"stsd", &stsd_a)));
        let a_trak = atom(b"trak", &atom(b"mdia", &[atom(b"hdlr", &hdlr_a), a_minf].concat()));

        let moov = atom(b"moov", &[mvhd, v_trak, a_trak].concat());
        let ftyp = atom(b"ftyp", b"isom");
        std::fs::write(&mp4_path, [ftyp, moov].concat()).unwrap();

        let details = media_details(&mp4_path);
        assert!(details.iter().any(|(k, v)| k == "Resolution" && v == "1920 × 1080 px"));
        assert!(details.iter().any(|(k, v)| k == "Duration" && v == "1:05"));
        assert!(details.iter().any(|(k, v)| k == "Video codec" && v == "H.264 (AVC)"));
        assert!(details.iter().any(|(k, v)| k == "Audio codec" && v == "AAC"));
    }
}
