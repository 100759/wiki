import MarkdownIt from "markdown-it";
import { common, createLowlight } from "lowlight";
import { toHtml } from "hast-util-to-html";

const lowlight = createLowlight(common);

const md = new MarkdownIt({
  // 安全边界：正文里的 HTML 一律当文本，不执行。
  html: false,
  linkify: false,
  breaks: false,
  highlight(code, lang) {
    if (lang && lowlight.registered(lang)) {
      return `<pre class="hljs"><code>${toHtml(lowlight.highlight(lang, code))}</code></pre>`;
    }
    return "";
  },
});

// 外链新窗口打开，并加 noopener。
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const href = token?.attrGet("href") ?? "";
  if (/^https?:\/\//i.test(href)) {
    token?.attrSet("target", "_blank");
    token?.attrSet("rel", "noopener noreferrer");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(source: string): string {
  return md.render(source);
}

export function renderInline(source: string): string {
  return md.renderInline(source);
}
