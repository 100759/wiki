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

export interface TocItem {
  level: number;
  text: string;
  id: string;
}

function slugifyHeading(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

/** 渲染正文并给 h2/h3 加锚点，同时返回目录。 */
export function renderPage(source: string): { html: string; toc: TocItem[] } {
  const raw = md.render(source);
  const toc: TocItem[] = [];
  const seen = new Map<string, number>();
  const html = raw.replace(/<h([23])>(.*?)<\/h\1>/g, (_match, level: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    const base = slugifyHeading(text);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const id = count === 1 ? base : `${base}-${count}`;
    toc.push({ level: Number(level), text, id });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
  return { html, toc };
}

/** 正文首行 H1 与页面标题重复时去掉，避免页面上出现两个大标题。 */
export function stripLeadingTitle(markdown: string, title: string): string {
  const match = markdown.match(/^\s*#\s+(.+?)\s*\n/);
  if (!match) return markdown;
  const heading = match[1]?.trim() ?? "";
  if (heading && heading === title.trim()) {
    return markdown.slice(match[0].length).replace(/^\s*\n/, "");
  }
  return markdown;
}

export function renderMarkdown(source: string): string {
  return md.render(source);
}

export function renderInline(source: string): string {
  return md.renderInline(source);
}
