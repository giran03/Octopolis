//! Markdown to HTML for the inspector. Raw HTML in the document is shown as
//! text, never interpreted, so a README can't inject markup or scripts.

use pulldown_cmark::{Event, Options, Parser, html};

pub fn to_html(source: &str) -> String {
    let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_FOOTNOTES;
    let events = Parser::new_ext(source, options).map(|e| match e {
        Event::Html(raw) | Event::InlineHtml(raw) => Event::Text(raw),
        other => other,
    });
    let mut out = String::with_capacity(source.len() * 3 / 2);
    html::push_html(&mut out, events);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_markdown() {
        let h = to_html("# Title\n\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |");
        assert!(h.contains("<h1>Title</h1>"));
        assert!(h.contains("<table>"));
        assert!(h.contains("checkbox"));
    }

    #[test]
    fn raw_html_is_escaped() {
        let h = to_html("hi <script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
        assert!(!h.contains("<script>"));
        assert!(!h.contains("<img"));
        assert!(h.contains("&lt;script&gt;"));
    }
}
