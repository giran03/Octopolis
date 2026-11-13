//! Google Fonts support: validating family names and reading the CSS Google serves for a family.
//!
//! Only the pieces that need no network live here, so they can be tested. The app downloads the CSS,
//! picks the latin faces out of it with `parse_css`, and downloads the listed font files.

use regex::Regex;

/// Only letters, digits and single spaces, so a name can't smuggle anything into a URL or a folder name.
pub fn valid_family(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty() && name.len() <= 50 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ') && !name.contains("  ")
}

/// The CSS request for a family at the given weights (`None` asks for just the regular weight).
pub fn css_url(family: &str, weights: Option<&str>) -> String {
    let name = family.trim().replace(' ', "+");
    match weights {
        Some(w) => format!("https://fonts.googleapis.com/css2?family={name}:wght@{w}&display=swap"),
        None => format!("https://fonts.googleapis.com/css2?family={name}&display=swap"),
    }
}

/// Weight lists to try in turn: families don't all offer every weight, and Google answers with an error
/// for a weight a family lacks.
pub const WEIGHT_TRIES: &[Option<&str>] = &[Some("400;500;600;700"), Some("400;700"), None];

/// One `@font-face` from Google's CSS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Face {
    /// `latin`, `latin-ext`, `cyrillic`, ...
    pub subset: String,
    /// A number like `400`, or a range like `100 900` for a variable font.
    pub weight: String,
    pub style: String,
    pub url: String,
    /// The `unicode-range` value, so the browser only uses this file for the characters it holds.
    pub range: String,
}

/// Subsets worth keeping: Latin text (including accents) covers what menus and file names need.
const KEEP: &[&str] = &["latin", "latin-ext"];

/// Where font files may come from.
pub const FONT_HOST: &str = "https://fonts.gstatic.com/";

/// The Latin faces in a CSS response, with files served from Google's font host only.
pub fn parse_css(css: &str) -> Vec<Face> {
    let block = Regex::new(r"(?s)/\*\s*([\w-]+)\s*\*/\s*@font-face\s*\{([^}]*)\}").expect("valid regex");
    let prop = |body: &str, name: &str| -> Option<String> {
        let re = Regex::new(&format!(r"{name}\s*:\s*([^;]+);")).ok()?;
        re.captures(body).map(|c| c[1].trim().to_string())
    };
    let src = Regex::new(r"url\(([^)]+)\)").expect("valid regex");
    block
        .captures_iter(css)
        .filter_map(|c| {
            let subset = c[1].to_string();
            if !KEEP.contains(&subset.as_str()) {
                return None;
            }
            let body = &c[2];
            let url = src.captures(body)?[1].trim().trim_matches(['\'', '"']).to_string();
            if !url.starts_with(FONT_HOST) || !url.ends_with(".woff2") {
                return None;
            }
            Some(Face { subset, weight: prop(body, "font-weight").unwrap_or_else(|| "400".into()), style: prop(body, "font-style").unwrap_or_else(|| "normal".into()), url, range: prop(body, "unicode-range").unwrap_or_default() })
        })
        .collect()
}

/// A file name for a face on disk, unique per weight, style and subset.
pub fn face_file_name(face: &Face) -> String {
    format!("{}_{}_{}.woff2", face.weight.replace(' ', "-"), face.style, face.subset)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
/* cyrillic */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v13/cyr.woff2) format('woff2');
  unicode-range: U+0301, U+0400-045F;
}
/* latin-ext */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v13/ext.woff2) format('woff2');
  unicode-range: U+0100-02AF;
}
/* latin */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v13/lat.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
/* latin */
@font-face {
  font-family: 'Evil';
  src: url(https://evil.example/x.woff2) format('woff2');
}
"#;

    #[test]
    fn accepts_plain_family_names_only() {
        assert!(valid_family("Inter"));
        assert!(valid_family("Open Sans"));
        assert!(valid_family("Source Sans 3"));
        assert!(!valid_family(""));
        assert!(!valid_family("Inter&family=Evil"));
        assert!(!valid_family("../Inter"));
        assert!(!valid_family("A  B"));
        assert!(!valid_family(&"x".repeat(60)));
    }

    #[test]
    fn builds_css_urls() {
        assert_eq!(css_url("Open Sans", Some("400;700")), "https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700&display=swap");
        assert_eq!(css_url("Inter", None), "https://fonts.googleapis.com/css2?family=Inter&display=swap");
    }

    #[test]
    fn keeps_latin_faces_from_the_font_host_only() {
        let faces = parse_css(SAMPLE);
        assert_eq!(faces.iter().map(|f| f.subset.as_str()).collect::<Vec<_>>(), ["latin-ext", "latin"]);
        assert_eq!(faces[1].weight, "100 900");
        assert_eq!(faces[1].range, "U+0000-00FF");
        assert!(faces.iter().all(|f| f.url.starts_with(FONT_HOST)));
    }

    #[test]
    fn file_names_are_safe_and_distinct() {
        let faces = parse_css(SAMPLE);
        assert_eq!(face_file_name(&faces[1]), "100-900_normal_latin.woff2");
        assert_ne!(face_file_name(&faces[0]), face_file_name(&faces[1]));
    }
}
