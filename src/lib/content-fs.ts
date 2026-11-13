import { promises as fs } from "node:fs";
import path from "node:path";
import { guessTitle, pageId, pathToSlug } from "./ids";
import type { PageRecord, PageSummary } from "./storage";

/**
 * 构建期读本地 content/ 目录生成静态页。
 * 页面在构建时就固化，运行时不访问 GitHub，所以打开是纯静态文件。
 */

const ROOT = process.cwd();
const CONTENT_DIR = path.join(ROOT, "content");
const META_FILE = path.join(ROOT, "_system", "meta.json");

interface PageMeta {
  title?: string;
  order?: number;
  acl?: string[];
  updatedAt?: string;
  updatedBy?: string;
}

async function readMeta(): Promise<Record<string, PageMeta>> {
  try {
    const parsed = JSON.parse(await fs.readFile(META_FILE, "utf8")) as {
      pages?: Record<string, PageMeta>;
    };
    return parsed.pages ?? {};
  } catch {
    return {};
  }
}

async function listMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
    }
  };
  await walk(dir);
  return out;
}

function parentOf(contentPath: string): string | null {
  const rel = contentPath.replace(/^content\//, "");
  const dir = path.posix.dirname(rel);
  if (dir === "." || dir === "" || dir === "content") return null;
  return `content/${dir}/index.md`;
}

export async function readLocalPages(): Promise<PageSummary[]> {
  const meta = await readMeta();
  const files = await listMarkdown(CONTENT_DIR);
  const pages: PageSummary[] = [];

  for (const file of files) {
    const rel = path.relative(CONTENT_DIR, file).split(path.sep).join("/");
    const contentPath = `content/${rel}`;
    const info = meta[contentPath] ?? {};
    let title = info.title?.trim() ?? "";
    if (!title) {
      const markdown = await fs.readFile(file, "utf8").catch(() => "");
      title = guessTitle(contentPath, markdown);
    }
    pages.push({
      id: pageId(contentPath),
      path: contentPath,
      title,
      order: typeof info.order === "number" ? info.order : 100,
      parent: parentOf(contentPath),
      acl: Array.isArray(info.acl) && info.acl.length > 0 ? info.acl : ["admin", "editor"],
    });
  }

  return pages.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path, "zh-Hans-CN"));
}

export async function readLocalPage(contentPath: string): Promise<PageRecord | null> {
  let markdown: string;
  try {
    markdown = await fs.readFile(path.join(ROOT, contentPath), "utf8");
  } catch {
    return null;
  }
  const meta = await readMeta();
  const info = meta[contentPath] ?? {};
  const title = info.title?.trim() || guessTitle(contentPath, markdown);

  return {
    id: pageId(contentPath),
    path: contentPath,
    title,
    markdown,
    sha: pageId(contentPath),
    updatedAt: info.updatedAt ?? new Date(0).toISOString(),
    updatedBy: info.updatedBy ?? "seed",
    acl: Array.isArray(info.acl) && info.acl.length > 0 ? info.acl : ["admin", "editor"],
    order: typeof info.order === "number" ? info.order : 100,
    parent: parentOf(contentPath),
  };
}

export function slugOf(contentPath: string): string {
  return pathToSlug(contentPath);
}
