//! Syntax highlighting with tree-sitter, rendered as HTML lines whose spans
//! carry `hl-<capture>` classes. Source text is HTML-escaped by the renderer.

use std::collections::HashMap;
use std::sync::OnceLock;

use tree_sitter::Language;
use tree_sitter_highlight::{HighlightConfiguration, Highlighter, HtmlRenderer};

/// Capture names we style; anything else falls back to the nearest prefix.
pub const NAMES: &[&str] = &[
    "attribute", "comment", "constant", "constant.builtin", "constructor", "embedded", "escape", "function", "function.builtin",
    "function.method", "keyword", "label", "module", "number", "operator", "property", "punctuation", "punctuation.bracket",
    "punctuation.delimiter", "string", "string.special", "tag", "type", "type.builtin", "variable", "variable.builtin",
    "variable.parameter",
];

/// Highlighting is skipped above this size; the plain text is shown instead.
pub const MAX_BYTES: usize = 512 * 1024;

fn config(lang: Language, name: &str, highlights: &str, injections: &str, locals: &str) -> Option<HighlightConfiguration> {
    let mut c = HighlightConfiguration::new(lang, name, highlights, injections, locals).ok()?;
    c.configure(NAMES);
    Some(c)
}

fn configs() -> &'static HashMap<&'static str, HighlightConfiguration> {
    static C: OnceLock<HashMap<&'static str, HighlightConfiguration>> = OnceLock::new();
    C.get_or_init(|| {
        let ts_highlights = format!("{}\n{}", tree_sitter_typescript::HIGHLIGHTS_QUERY, tree_sitter_javascript::HIGHLIGHT_QUERY);
        let entries: Vec<(&'static str, Option<HighlightConfiguration>)> = vec![
            ("rust", config(tree_sitter_rust::LANGUAGE.into(), "rust", tree_sitter_rust::HIGHLIGHTS_QUERY, tree_sitter_rust::INJECTIONS_QUERY, "")),
            (
                "javascript",
                config(
                    tree_sitter_javascript::LANGUAGE.into(),
                    "javascript",
                    &format!("{}\n{}", tree_sitter_javascript::HIGHLIGHT_QUERY, tree_sitter_javascript::JSX_HIGHLIGHT_QUERY),
                    tree_sitter_javascript::INJECTIONS_QUERY,
                    tree_sitter_javascript::LOCALS_QUERY,
                ),
            ),
            ("typescript", config(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), "typescript", &ts_highlights, "", tree_sitter_typescript::LOCALS_QUERY)),
            ("tsx", config(tree_sitter_typescript::LANGUAGE_TSX.into(), "tsx", &ts_highlights, "", tree_sitter_typescript::LOCALS_QUERY)),
            ("python", config(tree_sitter_python::LANGUAGE.into(), "python", tree_sitter_python::HIGHLIGHTS_QUERY, "", "")),
            ("json", config(tree_sitter_json::LANGUAGE.into(), "json", tree_sitter_json::HIGHLIGHTS_QUERY, "", "")),
            ("css", config(tree_sitter_css::LANGUAGE.into(), "css", tree_sitter_css::HIGHLIGHTS_QUERY, "", "")),
            ("html", config(tree_sitter_html::LANGUAGE.into(), "html", tree_sitter_html::HIGHLIGHTS_QUERY, "", "")),
            ("bash", config(tree_sitter_bash::LANGUAGE.into(), "bash", tree_sitter_bash::HIGHLIGHT_QUERY, "", "")),
            ("c", config(tree_sitter_c::LANGUAGE.into(), "c", tree_sitter_c::HIGHLIGHT_QUERY, "", "")),
            ("cpp", config(tree_sitter_cpp::LANGUAGE.into(), "cpp", &format!("{}\n{}", tree_sitter_cpp::HIGHLIGHT_QUERY, tree_sitter_c::HIGHLIGHT_QUERY), "", "")),
            ("go", config(tree_sitter_go::LANGUAGE.into(), "go", tree_sitter_go::HIGHLIGHTS_QUERY, "", "")),
            ("c_sharp", config(tree_sitter_c_sharp::LANGUAGE.into(), "c_sharp", tree_sitter_c_sharp::HIGHLIGHTS_QUERY, "", "")),
            ("java", config(tree_sitter_java::LANGUAGE.into(), "java", tree_sitter_java::HIGHLIGHTS_QUERY, "", "")),
        ];
        entries.into_iter().filter_map(|(k, c)| c.map(|c| (k, c))).collect()
    })
}

/// Builds every grammar configuration ahead of first use.
pub fn warm_up() {
    configs();
}

/// Highlights `source` as `lang`, returning one HTML string per line, or None
/// if the language is unknown, the text is too large, or parsing fails.
pub fn to_html_lines(lang: &str, source: &str) -> Option<Vec<String>> {
    if source.len() > MAX_BYTES {
        return None;
    }
    let configs = configs();
    let cfg = configs.get(lang)?;
    let mut highlighter = Highlighter::new();
    let events = highlighter.highlight(cfg, source.as_bytes(), None, None, |inj| configs.get(inj)).ok()?;
    let classes: Vec<String> = NAMES.iter().map(|n| format!("class=\"hl-{}\"", n.replace('.', "-"))).collect();
    let mut renderer = HtmlRenderer::new();
    renderer.render(events, source.as_bytes(), &|h, out: &mut Vec<u8>| out.extend_from_slice(classes[h.0].as_bytes())).ok()?;
    Some(renderer.lines().map(|l| l.trim_end_matches('\n').to_string()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn highlights_rust_and_escapes_html() {
        let lines = to_html_lines("rust", "fn main() { let s = \"<b>\"; }\n// done").unwrap();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("hl-keyword"), "{}", lines[0]);
        assert!(lines[0].contains("&lt;b&gt;"), "source is escaped: {}", lines[0]);
        assert!(!lines[0].contains("<b>"));
        assert!(lines[1].contains("hl-comment"));
    }

    #[test]
    fn every_language_loads() {
        for lang in ["rust", "javascript", "typescript", "tsx", "python", "json", "css", "html", "bash", "c", "cpp", "go", "c_sharp", "java"] {
            assert!(configs().contains_key(lang), "{lang} grammar failed to load");
        }
    }

    #[test]
    fn unknown_language_or_huge_input_returns_none() {
        assert!(to_html_lines("cobol", "x").is_none());
        assert!(to_html_lines("rust", &"a".repeat(MAX_BYTES + 1)).is_none());
    }
}
