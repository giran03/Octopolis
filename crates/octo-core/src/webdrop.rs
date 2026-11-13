//! Saving media dragged in from a web page: working out a safe file name, whether a link is worth fetching,
//! and which hosts are off limits. The network and disk work lives in the app; this part is pure.

use std::net::IpAddr;

/// Whether a content type is a picture, video or audio file.
pub fn is_media_mime(mime: &str) -> bool {
    let m = mime.trim().to_ascii_lowercase();
    m.starts_with("image/") || m.starts_with("video/") || m.starts_with("audio/")
}

const MEDIA_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "jpe", "jfif", "gif", "webp", "avif", "bmp", "ico", "svg", "tif", "tiff", "heic", "heif", "apng", "mp4", "m4v", "webm", "mkv", "mov", "avi", "ogv", "wmv", "mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac",
];

/// Whether a name already ends in a real extension (1-8 letters or digits after a dot, not a server-script one).
pub fn has_real_ext(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(stem, ext)| {
        let e = ext.to_ascii_lowercase();
        !stem.is_empty() && (1..=8).contains(&e.len()) && e.chars().all(|c| c.is_ascii_alphanumeric()) && !["php", "asp", "aspx", "jsp", "cgi", "do", "action", "html", "htm", "download"].contains(&e.as_str())
    })
}

/// Whether a file name ends in a picture, video or audio extension.
pub fn has_media_ext(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && MEDIA_EXTS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// The usual extension for a media content type.
pub fn ext_for_mime(mime: &str) -> Option<&'static str> {
    let base = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    Some(match base.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" | "image/pjpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/avif" => "avif",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
        "image/tiff" => "tif",
        "image/heic" => "heic",
        "image/apng" => "png",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "video/x-matroska" => "mkv",
        "video/ogg" => "ogv",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/flac" | "audio/x-flac" => "flac",
        "audio/ogg" => "ogg",
        "audio/mp4" | "audio/x-m4a" => "m4a",
        "audio/aac" => "aac",
        "audio/opus" => "opus",
        "application/pdf" => "pdf",
        "application/zip" | "application/x-zip-compressed" => "zip",
        "application/x-7z-compressed" => "7z",
        "application/vnd.rar" | "application/x-rar-compressed" => "rar",
        "application/gzip" | "application/x-gzip" => "gz",
        "application/x-tar" => "tar",
        "application/json" => "json",
        "application/xml" | "text/xml" => "xml",
        "application/msword" => "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/vnd.ms-excel" => "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.ms-powerpoint" => "ppt",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
        "application/epub+zip" => "epub",
        "application/x-msdownload" | "application/vnd.microsoft.portable-executable" => "exe",
        "text/plain" => "txt",
        "text/csv" => "csv",
        "text/markdown" => "md",
        _ => return None,
    })
}

/// Decodes `%XX` escapes as UTF-8 (a bad escape is kept as it is).
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let (Some(h), Some(l)) = ((b[i + 1] as char).to_digit(16), (b[i + 2] as char).to_digit(16))
        {
            out.push((h * 16 + l) as u8);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A name Windows accepts: no reserved characters or control characters, no trailing dots or spaces,
/// not a device name, and not absurdly long. Empty when nothing usable is left.
pub fn sanitize_name(name: &str) -> String {
    let mut s: String = name.chars().filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c)).collect();
    s = s.trim().trim_end_matches(['.', ' ']).to_string();
    if s.chars().count() > 120 {
        let (stem, ext) = s.rsplit_once('.').map(|(a, b)| (a.to_string(), format!(".{b}"))).unwrap_or((s.clone(), String::new()));
        let keep = 120usize.saturating_sub(ext.chars().count().min(20));
        s = format!("{}{}", stem.chars().take(keep).collect::<String>(), if ext.chars().count() <= 20 { ext } else { String::new() });
    }
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    const DEVICES: &[&str] = &["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];
    if DEVICES.contains(&stem.as_str()) {
        s.insert(0, '_');
    }
    s
}

/// The file name in a `Content-Disposition` header, if it has one.
pub fn filename_from_disposition(header: &str) -> Option<String> {
    let lower = header.to_ascii_lowercase();
    if let Some(i) = lower.find("filename*=") {
        let v = header[i + 10..].split(';').next()?.trim();
        // RFC 5987: charset'language'percent-encoded
        let encoded = v.splitn(3, '\'').nth(2).unwrap_or(v);
        let name = percent_decode(encoded.trim_matches('"'));
        if !name.is_empty() {
            return Some(name);
        }
    }
    let i = lower.find("filename=")?;
    let v = header[i + 9..].split(';').next()?.trim().trim_matches('"');
    (!v.is_empty()).then(|| v.to_string())
}

/// The last part of a link's path, decoded, without the query or fragment.
pub fn filename_from_url(url: &str) -> Option<String> {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let path = rest.split(['?', '#']).next()?;
    let (_, p) = path.split_once('/')?;
    let last = p.rsplit('/').next()?;
    let name = percent_decode(last);
    (!name.is_empty()).then_some(name)
}

/// The host of an http(s) link, lowercased and without user info, port or brackets; `None` for any other kind of link.
pub fn http_host(url: &str) -> Option<String> {
    let u = url.trim();
    let lower = u.to_ascii_lowercase();
    let rest = if lower.starts_with("https://") {
        &u[8..]
    } else if lower.starts_with("http://") {
        &u[7..]
    } else {
        return None;
    };
    let authority = rest.split(['/', '?', '#']).next()?;
    let host_port = authority.rsplit('@').next()?;
    let host = if let Some(inner) = host_port.strip_prefix('[') {
        inner.split(']').next()?
    } else {
        host_port.split(':').next()?
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// Whether a link points at this PC or a private network, which a dragged web link has no reason to reach.
pub fn host_is_blocked(host: &str) -> bool {
    let h = host.trim_end_matches('.');
    if h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local") || h.ends_with(".internal") {
        return true;
    }
    match h.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified() || ip.is_broadcast() || ip.octets()[0] == 0,
        Ok(IpAddr::V6(ip)) => {
            let seg = ip.segments();
            ip.is_loopback() || ip.is_unspecified() || (seg[0] & 0xfe00) == 0xfc00 || (seg[0] & 0xffc0) == 0xfe80 || ip.to_ipv4_mapped().is_some_and(|v4| host_is_blocked(&v4.to_string()))
        }
        Err(_) => false,
    }
}

/// The name to save a download under: the header's name, else the link's, else "download"; given the extension of
/// its content type when the name has no real extension.
pub fn final_name(url: &str, disposition: Option<&str>, content_type: Option<&str>) -> String {
    let raw = disposition.and_then(filename_from_disposition).or_else(|| filename_from_url(url)).unwrap_or_default();
    let mut name = sanitize_name(&raw);
    if name.is_empty() {
        name = "download".into();
    }
    if !has_real_ext(&name)
        && let Some(ext) = content_type.and_then(ext_for_mime)
    {
        name = format!("{}.{ext}", name.trim_end_matches('.'));
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_media() {
        assert!(is_media_mime("image/png"));
        assert!(is_media_mime(" VIDEO/mp4; codecs=x"));
        assert!(!is_media_mime("text/html"));
        assert!(!is_media_mime("application/octet-stream"));
        assert!(has_media_ext("a.PNG"));
        assert!(has_media_ext("clip.webm"));
        assert!(!has_media_ext("page.html"));
        assert!(!has_media_ext(".png"));
        assert_eq!(ext_for_mime("image/jpeg; charset=x"), Some("jpg"));
        assert_eq!(ext_for_mime("application/x-unknown"), None);
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("a%20b%C3%A9"), "a bé");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("x%2"), "x%2");
    }

    #[test]
    fn makes_safe_names() {
        assert_eq!(sanitize_name("a<b>:c?.png"), "abc.png");
        assert_eq!(sanitize_name("../../evil.png"), "....evil.png");
        assert_eq!(sanitize_name("name. "), "name");
        assert_eq!(sanitize_name("CON.png"), "_CON.png");
        assert_eq!(sanitize_name("***"), "");
        let long = format!("{}.jpg", "x".repeat(300));
        let s = sanitize_name(&long);
        assert!(s.chars().count() <= 120 && s.ends_with(".jpg"));
    }

    #[test]
    fn names_from_headers_and_links() {
        assert_eq!(filename_from_disposition("attachment; filename=\"cat.png\"").as_deref(), Some("cat.png"));
        assert_eq!(filename_from_disposition("attachment; filename*=UTF-8''caf%C3%A9.jpg").as_deref(), Some("café.jpg"));
        assert_eq!(filename_from_disposition("inline"), None);
        assert_eq!(filename_from_url("https://x.com/a/b/My%20Pic.png?w=200#top").as_deref(), Some("My Pic.png"));
        assert_eq!(filename_from_url("https://x.com"), None);
        assert_eq!(filename_from_url("https://x.com/"), None);
    }

    #[test]
    fn final_name_adds_the_extension_when_missing() {
        assert_eq!(final_name("https://x.com/img/12345", None, Some("image/webp")), "12345.webp");
        assert_eq!(final_name("https://x.com/a.png", None, Some("image/png")), "a.png");
        assert_eq!(final_name("https://x.com/", None, Some("image/gif")), "download.gif");
        assert_eq!(final_name("https://x.com/a", Some("attachment; filename=\"b.jpg\""), None), "b.jpg");
        assert_eq!(final_name("https://x.com/a.php", None, Some("image/png")), "a.php.png");
        assert_eq!(final_name("https://x.com/files/report", None, Some("application/pdf")), "report.pdf");
        assert_eq!(final_name("https://x.com/files/report.pdf", None, Some("application/pdf")), "report.pdf");
        assert_eq!(final_name("https://x.com/dl?id=3", None, Some("application/zip")), "dl.zip");
        assert_eq!(final_name("https://x.com/", None, Some("application/pdf")), "download.pdf");
        assert_eq!(final_name("https://x.com/v1.2/readme", None, Some("text/plain")), "readme.txt");
    }

    #[test]
    fn finds_and_blocks_private_hosts() {
        assert_eq!(http_host("https://User:pw@Example.COM:8080/a?b").as_deref(), Some("example.com"));
        assert_eq!(http_host("HTTP://[::1]:80/x").as_deref(), Some("::1"));
        assert_eq!(http_host("ftp://x.com/a"), None);
        assert_eq!(http_host("file:///C:/a.png"), None);
        assert_eq!(http_host("javascript:alert(1)"), None);
        for h in ["localhost", "foo.localhost", "127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.0.1", "169.254.1.1", "0.0.0.0", "::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "printer.local"] {
            assert!(host_is_blocked(h), "{h}");
        }
        for h in ["example.com", "8.8.8.8", "172.32.0.1", "2606:4700::1111"] {
            assert!(!host_is_blocked(h), "{h}");
        }
    }
}
