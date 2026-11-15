// Renders CHANGELOG-style Markdown (version and group headings, bullets, inline formatting) as safe JSX.
import { For, type JSX } from "solid-js";

const INLINE_MD = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;

/** Renders inline Markdown (`**bold**`, `*italic*`, `` `code` ``, `[text](url)`) as safe JSX. */
function renderInlineMarkdown(text: string): JSX.Element[] {
  const parts: JSX.Element[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_MD)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push(text.slice(last, idx));
    const tok = m[0];
    if (tok.startsWith("**") && tok.endsWith("**")) {
      parts.push(<strong>{renderInlineMarkdown(tok.slice(2, -2))}</strong>);
    } else if (tok.startsWith("*") && tok.endsWith("*")) {
      parts.push(<em>{renderInlineMarkdown(tok.slice(1, -1))}</em>);
    } else if (tok.startsWith("`") && tok.endsWith("`")) {
      parts.push(<code>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("[")) {
      const sep = tok.indexOf("](");
      const label = tok.slice(1, sep);
      const href = tok.slice(sep + 2, -1);
      parts.push(<a href={href} target="_blank" rel="noreferrer">{label}</a>);
    }
    last = idx + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Renders the changelog Markdown: version headings, group headings, bullets, and inline formatting. */
export function ChangelogText(props: { text: string }) {
  const lines = () => props.text.split(/[\r\n]+/).filter((l) => l.trim() && !/^# /.test(l));
  return (
    <div class="changelog">
      <For each={lines()}>
        {(l) => {
          if (l.startsWith("## ")) return <h4 class="cl-version">{renderInlineMarkdown(l.slice(3))}</h4>;
          if (l.startsWith("### ")) return <h5 class="cl-group">{renderInlineMarkdown(l.slice(4))}</h5>;
          if (/^[-*] /.test(l)) return <p class="cl-item">{renderInlineMarkdown(l.slice(2))}</p>;
          return <p class="cl-text">{renderInlineMarkdown(l)}</p>;
        }}
      </For>
    </div>
  );
}
