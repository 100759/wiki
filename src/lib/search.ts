import { pathToSlug } from "./ids";
import type { ContentStore } from "./storage";

export interface SearchHit {
  path: string;
  slug: string;
  title: string;
  snippet: string;
  score: number;
}

function snippetOf(markdown: string, query: string): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*`_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const index = plain.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return plain.slice(0, 80);
  const start = Math.max(0, index - 40);
  return `${start > 0 ? "…" : ""}${plain.slice(start, start + 110)}…`;
}

/** 没有数据库：直接读仓库内容做内存匹配，页数在几百以内足够快。 */
export async function searchPages(store: ContentStore, query: string, limit = 30): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const needle = q.toLowerCase();
  const pages = await store.listPages();
  const hits: SearchHit[] = [];

  for (const page of pages.slice(0, 300)) {
    const record = await store.getPageByPath(page.path).catch(() => null);
    if (!record) continue;
    const titleHit = record.title.toLowerCase().includes(needle);
    const bodyHit = record.markdown.toLowerCase().includes(needle);
    if (!titleHit && !bodyHit) continue;
    hits.push({
      path: page.path,
      slug: pathToSlug(page.path),
      title: record.title,
      snippet: snippetOf(record.markdown, q),
      score: (titleHit ? 10 : 0) + (bodyHit ? 1 : 0),
    });
  }

  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh-Hans-CN"));
  return hits.slice(0, limit);
}
