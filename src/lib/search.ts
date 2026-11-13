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

function bigrams(text: string): string[] {
  const clean = text.replace(/[^\w\u4e00-\u9fa5]+/g, " ").trim();
  const out = new Set<string>();
  for (const word of clean.split(/\s+/).filter(Boolean)) {
    if (word.length <= 2) {
      out.add(word.toLowerCase());
      continue;
    }
    for (let i = 0; i < word.length - 1; i += 1) out.add(word.slice(i, i + 2).toLowerCase());
  }
  return [...out];
}

/**
 * 问答检索：中文按二元组切词打分，比整句子串匹配靠谱。
 * 一条都命中不了时退回首页 + 前两页，让模型至少能看到站内有什么。
 */
export async function retrievePages(
  store: ContentStore,
  question: string,
  limit = 3,
): Promise<{ path: string; title: string; slug: string; markdown: string }[]> {
  const pages = await store.listPages();
  const grams = bigrams(question);
  const scored: { page: (typeof pages)[number]; score: number }[] = [];

  for (const page of pages.slice(0, 300)) {
    const record = await store.getPageByPath(page.path).catch(() => null);
    if (!record) continue;
    const haystack = `${record.title}\n${record.markdown}`.toLowerCase();
    let score = 0;
    for (const gram of grams) if (haystack.includes(gram)) score += 1;
    if (score > 0) scored.push({ page, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const picked: { path: string; title: string; slug: string; markdown: string }[] = [];
  for (const item of scored) {
    if (picked.length >= limit) break;
    const record = await store.getPageByPath(item.page.path).catch(() => null);
    if (!record) continue;
    picked.push({ path: record.path, title: record.title, slug: pathToSlug(record.path), markdown: record.markdown });
  }

  if (picked.length === 0) {
    for (const page of pages.slice(0, limit)) {
      const record = await store.getPageByPath(page.path).catch(() => null);
      if (!record) continue;
      picked.push({ path: record.path, title: record.title, slug: pathToSlug(record.path), markdown: record.markdown });
    }
  }

  return picked;
}
