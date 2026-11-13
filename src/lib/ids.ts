import { createHash } from "node:crypto";

/** M1 约定：仓库内正文统一放在 content/ 下，扩展名 .md。 */
export function normalizeContentPath(input: string): string {
  let p = input.trim().replace(/\\/g, "/");
  if (!p) throw new Error("路径不能为空");
  if (!p.startsWith("content/")) p = `content/${p}`;
  if (!p.endsWith(".md")) p = `${p}.md`;
  p = p.replace(/\/+/g, "/");
  if (p.includes("..") || p.includes("\0")) throw new Error("非法路径");
  return p;
}

/** v1 约定：id = sha1(仓库相对路径)[:12]。 */
export function pageId(contentPath: string): string {
  return createHash("sha1").update(contentPath).digest("hex").slice(0, 12);
}

/** /w/<slug>：“content/guide/start.md” → “guide.start”；首页 → “index”。 */
export function pathToSlug(contentPath: string): string {
  const rel = contentPath.replace(/^content\//, "").replace(/\.md$/, "");
  if (rel === "" || rel === "index") return "index";
  return rel.split("/").map((s) => encodeURIComponent(s)).join(".");
}

/** slug → content 路径；非法输入返回 null。 */
export function slugToPath(slug: string): string | null {
  if (!slug || slug.length > 300) return null;
  if (slug === "index") return "content/index.md";
  try {
    const parts = slug.split(".").map((s) => decodeURIComponent(s));
    if (parts.some((s) => !s || s === ".." || s.includes("/") || s.includes("\\"))) return null;
    return normalizeContentPath(parts.join("/"));
  } catch {
    return null;
  }
}

/** 从 markdown 猜标题：第一个 # 标题，否则文件名。 */
export function guessTitle(contentPath: string, markdown: string): string {
  const heading = markdown.match(/^\s*#\s+(.+)$/m);
  if (heading?.[1]) return heading[1].trim();
  const base = contentPath.replace(/^content\//, "").replace(/\.md$/, "");
  return base === "index" ? "首页" : base;
}
