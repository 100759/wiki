import { pathToSlug } from "./ids";
import type { PageSummary } from "./storage";

export interface NavItem {
  title: string;
  path: string;
  slug: string;
  depth: number;
  parent: string | null;
}

/**
 * 扁平化导航：按路径排序，用目录层级算缩进。
 * 没有自建目录表，路径本身（content/guide/start.md）就是结构。
 */
export function buildNav(pages: PageSummary[]): NavItem[] {
  return pages
    .map((page) => {
      const rel = page.path.replace(/^content\//, "").replace(/\.md$/, "");
      const depth = page.path === "content/index.md" ? 0 : rel.split("/").length - 1;
      return {
        title: page.title,
        path: page.path,
        slug: pathToSlug(page.path),
        depth,
        parent: page.parent,
      };
    })
    .sort((a, b) => {
      if (a.path === "content/index.md") return -1;
      if (b.path === "content/index.md") return 1;
      return a.path.localeCompare(b.path, "zh-Hans-CN");
    });
}

/** 上一篇/下一篇：按导航顺序取相邻项。 */
export function neighbours(pages: PageSummary[], currentPath: string): {
  prev: NavItem | null;
  next: NavItem | null;
} {
  const nav = buildNav(pages);
  const index = nav.findIndex((item) => item.path === currentPath);
  if (index < 0) return { prev: null, next: null };
  return { prev: nav[index - 1] ?? null, next: nav[index + 1] ?? null };
}
