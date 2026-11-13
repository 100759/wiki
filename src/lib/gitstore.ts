import path from "node:path";
import { commitFiles, type FileChange } from "./gitcommit";
import { GithubError, type GithubClient } from "./github";
import { guessTitle, normalizeContentPath, pageId, pathToSlug } from "./ids";
import { MAX_IMAGE_BYTES, validateImage } from "./image-rules";
import type {
  ContentStore,
  PageRecord,
  PageSummary,
  SaveInput,
  SaveResult,
  UploadInput,
  UploadResult,
} from "./storage";

/* ------------------------------------------------------------------ *
 * githubStore —— 唯一真源是仓库
 *   content/**.md          正文
 *   _system/meta.json      标题/排序/ACL/更新时间
 *   assets/<pageId>/*      正文图片
 * 读路径带进程内缓存；GitHub 不可达时退回构建期打包内容，不返回 500。
 * ------------------------------------------------------------------ */

export const META_PATH = "_system/meta.json";
const DEFAULT_ACL = ["admin", "editor"];


interface PageMeta {
  title?: string;
  order?: number;
  acl?: string[];
  updatedAt?: string;
  updatedBy?: string;
}

interface MetaFile {
  version: 1;
  pages: Record<string, PageMeta>;
}

/** 写路径专用：结构不合法直接抛错，绝不用空表覆盖线上 meta。 */
function parseMetaStrict(raw: string): MetaFile {
  const parsed = JSON.parse(raw) as Partial<MetaFile>;
  if (!parsed || typeof parsed !== "object" || !parsed.pages || typeof parsed.pages !== "object") {
    throw new Error("meta.json 结构不合法，拒绝覆盖");
  }
  return { version: 1, pages: parsed.pages as Record<string, PageMeta> };
}

function parseMeta(raw: string): MetaFile {
  try {
    const parsed = JSON.parse(raw) as Partial<MetaFile>;
    const pages = parsed.pages;
    if (!pages || typeof pages !== "object") return { version: 1, pages: {} };
    return { version: 1, pages: pages as Record<string, PageMeta> };
  } catch {
    return { version: 1, pages: {} };
  }
}

function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
  return base || "image";
}

function parentOf(contentPath: string): string | null {
  const rel = contentPath.replace(/^content\//, "");
  const dir = path.posix.dirname(rel);
  if (dir === "." || dir === "" || dir === "content") return null;
  return `content/${dir}/index.md`;
}

export class GithubStore implements ContentStore {
  constructor(private readonly client: GithubClient) {}

  private async bundled(): Promise<Map<string, string>> {
    try {
      const { getBundledPages } = await import("./bundled");
      const pages = await getBundledPages();
      return new Map(pages.map((page) => [page.path, page.markdown]));
    } catch {
      return new Map();
    }
  }

  private async readMeta(treeEntries: Map<string, { sha: string }>): Promise<{ meta: MetaFile; sha: string | null }> {
    const entry = treeEntries.get(META_PATH);
    if (!entry) return { meta: { version: 1, pages: {} }, sha: null };
    try {
      return { meta: parseMeta(await this.client.readBlob(entry.sha)), sha: entry.sha };
    } catch {
      return { meta: { version: 1, pages: {} }, sha: entry.sha };
    }
  }

  /** 写路径专用：meta 存在但读不到/解析失败时整次操作失败，避免默认 ACL 放行。 */
  private async readMetaStrictForWrite(
    entries: Map<string, { sha: string }>,
  ): Promise<{ meta: MetaFile; sha: string | null }> {
    const entry = entries.get(META_PATH);
    if (!entry) return { meta: { version: 1, pages: {} }, sha: null };
    const meta = parseMetaStrict(await this.client.readBlob(entry.sha));
    return { meta, sha: entry.sha };
  }

  private async markdownPaths(): Promise<{ sha: string; entries: Map<string, { sha: string }> } | null> {
    try {
      const tree = await this.client.tree();
      return { sha: tree.sha, entries: tree.entries };
    } catch {
      return null;
    }
  }

  async getPageByPath(input: string): Promise<PageRecord | null> {
    let contentPath: string;
    try {
      contentPath = normalizeContentPath(input);
    } catch {
      return null;
    }

    const paths = await this.markdownPaths();
    if (!paths) {
      const bundled = await this.bundled();
      const markdown = bundled.get(contentPath);
      if (markdown === undefined) return null;
      return this.record(contentPath, markdown, `bundled-${pageId(contentPath)}`, {});
    }

    const entry = paths.entries.get(contentPath);
    if (!entry) {
      // 仓库里没有，但构建期打包有（首次部署尚未写入新页）→ 当只读基线展示。
      const bundled = await this.bundled();
      const markdown = bundled.get(contentPath);
      if (markdown === undefined) return null;
      return this.record(contentPath, markdown, `bundled-${pageId(contentPath)}`, {});
    }

    try {
      const markdown = await this.client.readBlob(entry.sha);
      const { meta } = await this.readMeta(paths.entries);
      return this.record(contentPath, markdown, entry.sha, meta.pages[contentPath] ?? {});
    } catch (err) {
      if (err instanceof GithubError && err.code === "not_found") return null;
      const bundled = await this.bundled();
      const markdown = bundled.get(contentPath);
      if (markdown === undefined) return null;
      return this.record(contentPath, markdown, `bundled-${pageId(contentPath)}`, {});
    }
  }

  private record(contentPath: string, markdown: string, sha: string, meta: PageMeta): PageRecord {
    return {
      id: pageId(contentPath),
      path: contentPath,
      title: meta.title?.trim() || guessTitle(contentPath, markdown),
      markdown,
      sha,
      updatedAt: meta.updatedAt ?? new Date(0).toISOString(),
      updatedBy: meta.updatedBy ?? "unknown",
      acl: Array.isArray(meta.acl) && meta.acl.length > 0 ? meta.acl : [...DEFAULT_ACL],
      order: typeof meta.order === "number" ? meta.order : 100,
      parent: parentOf(contentPath),
    };
  }

  async getPageById(id: string): Promise<PageRecord | null> {
    const summaries = await this.listPages();
    const found = summaries.find((page) => page.id === id);
    if (!found) return null;
    return this.getPageByPath(found.path);
  }

  async listPages(): Promise<PageSummary[]> {
    const paths = await this.markdownPaths();
    if (!paths) {
      const bundled = await this.bundled();
      return [...bundled.entries()]
        .map(([contentPath, markdown]) => ({
          id: pageId(contentPath),
          path: contentPath,
          title: guessTitle(contentPath, markdown),
          order: 100,
          parent: parentOf(contentPath),
          acl: [...DEFAULT_ACL],
        }))
        .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, "zh-Hans-CN"));
    }

    const { meta } = await this.readMeta(paths.entries);
    const mdPaths = [...paths.entries.keys()].filter((p) => p.startsWith("content/") && p.endsWith(".md"));

    const summaries = mdPaths.map((contentPath) => {
      const info = meta.pages[contentPath] ?? {};
      return {
        id: pageId(contentPath),
        path: contentPath,
        title: info.title?.trim() || guessTitle(contentPath, ""),
        order: typeof info.order === "number" ? info.order : 100,
        parent: parentOf(contentPath),
        acl: Array.isArray(info.acl) && info.acl.length > 0 ? info.acl : [...DEFAULT_ACL],
      };
    });

    // 标题缺失时补读正文（并发受限，避免一次打满 GitHub）。
    const missing = summaries.filter((_, index) => {
      const info = meta.pages[mdPaths[index] ?? ""];
      return !info?.title;
    });
    await this.fillTitles(missing, paths.entries);

    return summaries.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, "zh-Hans-CN"));
  }

  private async fillTitles(
    targets: PageSummary[],
    entries: Map<string, { sha: string }>,
  ): Promise<void> {
    const queue = [...targets];
    const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const entry = entries.get(item.path);
        if (!entry) continue;
        try {
          item.title = guessTitle(item.path, await this.client.readBlob(entry.sha));
        } catch {
          /* 保留文件名兜底 */
        }
      }
    });
    await Promise.all(workers);
  }

  async savePage(input: SaveInput): Promise<SaveResult> {
    try {
      return await this.savePageImpl(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "invalid", message: `存储异常：${message}` };
    }
  }

  private async savePageImpl(input: SaveInput): Promise<SaveResult> {
    if (input.actor.role === "viewer") {
      return { ok: false, code: "forbidden", message: "viewer 角色没有保存权限" };
    }

    let contentPath: string;
    try {
      contentPath = normalizeContentPath(input.path);
    } catch (err) {
      return { ok: false, code: "invalid", message: (err as Error).message };
    }
    if (typeof input.markdown !== "string" || typeof input.title !== "string") {
      return { ok: false, code: "invalid", message: "title / markdown 必须是字符串" };
    }

    const tree = await this.client.tree();
    if (tree.truncated) {
      return { ok: false, code: "invalid", message: "仓库文件目录过大导致列表被截断，暂不能安全写入" };
    }
    const current = tree.entries.get(contentPath)?.sha ?? null;
    const baseSha = input.baseSha && input.baseSha.length > 0 ? input.baseSha : null;
    // 打包内容只做展示，不作为可写基线；第一次真实保存必须显式覆盖（baseSha 为 null 且文件不存在）。
    if (baseSha !== current) {
      if (baseSha?.startsWith("bundled-") && current === null) {
        /* 打包页首次落库：允许 */
      } else {
        return { ok: false, code: "conflict", message: "页面已被他人修改，请刷新后重试" };
      }
    }

    const { meta, sha: metaSha } = await this.readMetaStrictForWrite(tree.entries);
    const metaInfo = meta.pages[contentPath] ?? {};
    const acl = Array.isArray(metaInfo.acl) && metaInfo.acl.length > 0 ? metaInfo.acl : [...DEFAULT_ACL];
    void metaSha;
    if (input.actor.role !== "admin" && !acl.includes(input.actor.role)) {
      return { ok: false, code: "forbidden", message: "当前账号无权编辑本页" };
    }

    const id = pageId(contentPath);
    let markdown = input.markdown;
    const files: FileChange[] = [];

    for (const image of input.images ?? []) {
      if (!image || typeof image.name !== "string" || !(image.bytes instanceof Uint8Array)) {
        return { ok: false, code: "invalid", message: "图片数据不合法" };
      }
      const verdict = validateImage(image.name, image.mime, image.bytes.byteLength);
      if (!verdict.ok) return { ok: false, code: "invalid", message: verdict.message };
      const name = safeName(image.name);
      const repoPath = `assets/${id}/${name}`;
      files.push({ path: repoPath, content: Buffer.from(image.bytes) });
      const publicUrl = `/img/${repoPath}`;
      markdown = markdown
        .split(`/uploads/pending/${encodeURIComponent(name)}`).join(publicUrl)
        .split(`/uploads/pending/${name}`).join(publicUrl)
        .split(`/img/pending/${encodeURIComponent(name)}`).join(publicUrl)
        .split(`/img/pending/${name}`).join(publicUrl);
    }

    const now = new Date().toISOString();
    const title = input.title.trim() || guessTitle(contentPath, markdown);

    files.push({ path: contentPath, content: markdown });
    // meta.json 是共享文件：两个编辑改不同页都会写它。不能进 expected，
    // 否则"不同页并发"会被误判成冲突；改为每次尝试基于最新 head 重新合并。
    files.push({
      path: META_PATH,
      content: async (ctx) => {
        // 只有"文件本来就不存在"才允许用空表起步；
        // 存在但读不到/解析不了时直接抛错，避免把其他页的标题、排序、ACL 抹掉。
        let base: MetaFile = { version: 1, pages: {} };
        const entry = ctx.entries.get(META_PATH);
        if (entry) {
          base = parseMetaStrict(await ctx.client.readBlob(entry.sha));
        }
        const previous = base.pages[contentPath] ?? {};
        const next: MetaFile = {
          version: 1,
          pages: {
            ...base.pages,
            [contentPath]: {
              title,
              order: previous.order ?? metaInfo.order ?? 100,
              acl: previous.acl ?? acl,
              updatedAt: now,
              updatedBy: input.actor.name,
            },
          },
        };
        return `${JSON.stringify(next, null, 2)}\n`;
      },
    });

    const outcome = await commitFiles(this.client, {
      message: current ? `更新 ${title}（${input.actor.name}）` : `创建 ${title}（${input.actor.name}）`,
      files,
      expected: { [contentPath]: current },
    });

    if (!outcome.ok) {
      return { ok: false, code: "conflict", message: "页面已被他人修改，请刷新后重试" };
    }

    return { ok: true, sha: outcome.blobs[contentPath] ?? "", commit: outcome.commit };
  }

  async uploadImage(input: UploadInput): Promise<UploadResult> {
    if (input.actor.role === "viewer") {
      return { ok: false, code: "forbidden", message: "viewer 角色不能上传图片" };
    }
    let contentPath: string;
    try {
      contentPath = normalizeContentPath(input.pagePath);
    } catch (err) {
      return { ok: false, code: "invalid", message: (err as Error).message };
    }
    const verdict = validateImage(input.name, input.mime, input.bytes.byteLength);
    if (!verdict.ok) return { ok: false, code: "invalid", message: verdict.message };

    const tree = await this.client.tree();
    if (tree.truncated) {
      return { ok: false, code: "invalid", message: "仓库文件目录过大导致列表被截断，暂不能上传" };
    }
    const { meta, sha: metaSha } = await this.readMetaStrictForWrite(tree.entries);
    const metaInfo = meta.pages[contentPath] ?? {};
    const acl = Array.isArray(metaInfo.acl) && metaInfo.acl.length > 0 ? metaInfo.acl : [...DEFAULT_ACL];
    void metaSha;
    if (input.actor.role !== "admin" && !acl.includes(input.actor.role)) {
      return { ok: false, code: "forbidden", message: "当前账号无权编辑本页，不能上传图片" };
    }

    const id = pageId(contentPath);
    const name = safeName(input.name);
    const repoPath = `assets/${id}/${name}`;
    const current = tree.entries.get(repoPath)?.sha ?? null;

    const outcome = await commitFiles(this.client, {
      message: `上传图片 ${name}（${input.actor.name}）`,
      files: [{ path: repoPath, content: Buffer.from(input.bytes) }],
      expected: { [repoPath]: current },
    });
    if (!outcome.ok) {
      return { ok: false, code: "invalid", message: "图片写入冲突，请重试" };
    }
    return { ok: true, url: `/img/${repoPath}` };
  }

  async listHistory(
    input: string,
    limit: number,
  ): Promise<{ sha: string; message: string; date: string; author: string }[]> {
    let contentPath: string;
    try {
      contentPath = normalizeContentPath(input);
    } catch {
      return [];
    }
    try {
      const commits = await this.client.history(contentPath, limit);
      return commits.map(({ sha, message, date, author }) => ({ sha, message, date, author }));
    } catch {
      return [];
    }
  }

  async restore(input: string, commitSha: string, actor: SaveInput["actor"]): Promise<SaveResult> {
    let contentPath: string;
    try {
      contentPath = normalizeContentPath(input);
    } catch (err) {
      return { ok: false, code: "invalid", message: (err as Error).message };
    }
    if (!/^[0-9a-f]{7,40}$/i.test(commitSha)) {
      return { ok: false, code: "invalid", message: "版本号不合法" };
    }

    const file = await this.client.readFileAt(contentPath, commitSha);
    if (!file) return { ok: false, code: "invalid", message: "找不到该版本" };

    const current = await this.getPageByPath(contentPath);
    const title = guessTitle(contentPath, file.text);

    return this.savePage({
      path: contentPath,
      title,
      markdown: file.text,
      baseSha: current?.sha ?? null,
      images: [],
      actor,
    });
  }
}

/** 图片 /img/<repoPath> 需要把 slug 反解成仓库路径时用得到。 */
export function assetPathFor(slug: string): string | null {
  if (!slug || slug.includes("..")) return null;
  return slug.replace(/^\/+/, "");
}

export { pathToSlug };
