//! File metadata used by batch rename templates and the inspector:
//! EXIF (photos) and ID3 (MP3 audio).

use std::collections::BTreeMap;
use std::path::Path;

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
}
