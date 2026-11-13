import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { guessTitle, normalizeContentPath, pageId } from "./ids";

/* ------------------------------------------------------------------ *
 * v2 §3.1 契约：M2 只新增 githubStore / blobStore，调用方不改。
 * ------------------------------------------------------------------ */

export interface PageRecord {
  id: string;
  path: string;
  title: string;
  markdown: string;
  sha: string;
  updatedAt: string;
  updatedBy: string;
  acl: string[];
  order: number;
  parent: string | null;
}

export interface PageSummary {
  id: string;
  path: string;
  title: string;
  order: number;
  parent: string | null;
  acl: string[];
}

export interface SaveInput {
  path: string;
  title: string;
  markdown: string;
  baseSha: string | null;
  images: { name: string; bytes: Uint8Array; mime: string }[];
  actor: { uid: string; name: string; role: "admin" | "editor" | "viewer" };
}

export type SaveResult =
  | { ok: true; sha: string; commit: string }
  | { ok: false; code: "conflict" | "forbidden" | "invalid"; message: string };

export interface ContentStore {
  getPageByPath(path: string): Promise<PageRecord | null>;
  getPageById(id: string): Promise<PageRecord | null>;
  listPages(): Promise<PageSummary[]>;
  savePage(input: SaveInput): Promise<SaveResult>;
  listHistory(
    path: string,
    limit: number,
  ): Promise<{ sha: string; message: string; date: string; author: string }[]>;
  restore(path: string, sha: string): Promise<SaveResult>;
}

/* ------------------------------------------------------------------ *
 * localFileStore —— M1 本地实现
 *   data/content/**      正文 markdown
 *   data/meta.json       页面索引（id → 元数据）
 *   data/history/<id>.json 每次保存的完整快照，最新在前
 *   data/uploads/<id>/   随保存请求提交的图片
 * ------------------------------------------------------------------ */

interface PageMeta {
  id: string;
  path: string;
  title: string;
  sha: string;
  updatedAt: string;
  updatedBy: string;
  acl: string[];
  order: number;
  parent: string | null;
}

interface MetaFile {
  version: 1;
  pages: PageMeta[];
}

interface Revision {
  sha: string;
  message: string;
  date: string;
  author: string;
  title: string;
  markdown: string;
}

const DEFAULT_ACL = ["admin", "editor"];

export function defaultDataDir(): string {
  const raw = process.env.WIKI_DATA_DIR ?? "data";
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
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

export class LocalFileStore implements ContentStore {
  readonly root: string;
  private readonly contentDir: string;
  private readonly metaFile: string;
  private readonly historyDir: string;
  private readonly uploadsDir: string;

  constructor(root: string = defaultDataDir()) {
    this.root = root;
    this.contentDir = path.join(root, "content");
    this.metaFile = path.join(root, "meta.json");
    this.historyDir = path.join(root, "history");
    this.uploadsDir = path.join(root, "uploads");
  }

  private async ensureDirs(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.contentDir, { recursive: true }),
      fs.mkdir(this.historyDir, { recursive: true }),
      fs.mkdir(this.uploadsDir, { recursive: true }),
    ]);
  }

  private fileFor(contentPath: string): string {
    const rel = contentPath.replace(/^content\//, "");
    const abs = path.resolve(this.contentDir, rel);
    if (!abs.startsWith(path.resolve(this.contentDir) + path.sep)) {
      throw new Error("非法路径");
    }
    return abs;
  }

  private async readMetaFile(): Promise<MetaFile> {
    try {
      const raw = await fs.readFile(this.metaFile, "utf8");
      const parsed = JSON.parse(raw) as MetaFile;
      if (!Array.isArray(parsed.pages)) return { version: 1, pages: [] };
      return parsed;
    } catch {
      return { version: 1, pages: [] };
    }
  }

  private async writeMetaFile(meta: MetaFile): Promise<void> {
    const tmp = `${this.metaFile}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
    await fs.rename(tmp, this.metaFile);
  }

  private async scanMarkdown(): Promise<PageMeta[]> {
    const found: PageMeta[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          const rel = path.relative(this.contentDir, full).split(path.sep).join("/");
          const contentPath = `content/${rel}`;
          const markdown = await fs.readFile(full, "utf8");
          found.push({
            id: pageId(contentPath),
            path: contentPath,
            title: guessTitle(contentPath, markdown),
            sha: sha1(markdown),
            updatedAt: new Date(0).toISOString(),
            updatedBy: "seed",
            acl: [...DEFAULT_ACL],
            order: 100,
            parent: parentOf(contentPath),
          });
        }
      }
    };
    await walk(this.contentDir);
    return found;
  }

  /** 索引缺失或落后于磁盘时，以磁盘为准补齐。 */
  private async loadIndex(): Promise<MetaFile> {
    await this.ensureDirs();
    const meta = await this.readMetaFile();
    const scanned = await this.scanMarkdown();
    const byPath = new Map(meta.pages.map((p) => [p.path, p]));
    let changed = meta.pages.length === 0;
    for (const page of scanned) {
      const known = byPath.get(page.path);
      if (!known) {
        meta.pages.push(page);
        changed = true;
      } else if (known.sha !== page.sha) {
        known.sha = page.sha;
        changed = true;
      }
    }
    const existing = new Set(scanned.map((p) => p.path));
    const pruned = meta.pages.filter((p) => existing.has(p.path));
    if (pruned.length !== meta.pages.length) changed = true;
    meta.pages = pruned;
    if (changed) await this.writeMetaFile(meta);
    return meta;
  }

  async getPageByPath(input: string): Promise<PageRecord | null> {
    let contentPath: string;
    try {
      contentPath = normalizeContentPath(input);
    } catch {
      return null;
    }
    const meta = await this.loadIndex();
    const entry = meta.pages.find((p) => p.path === contentPath);
    if (!entry) return null;
    try {
      const markdown = await fs.readFile(this.fileFor(contentPath), "utf8");
      return { ...entry, markdown };
    } catch {
      return null;
    }
  }

  async getPageById(id: string): Promise<PageRecord | null> {
    const meta = await this.loadIndex();
    const entry = meta.pages.find((p) => p.id === id);
    if (!entry) return null;
    return this.getPageByPath(entry.path);
  }

  async listPages(): Promise<PageSummary[]> {
    const meta = await this.loadIndex();
    return meta.pages
      .map(({ id, path: p, title, order, parent, acl }) => ({ id, path: p, title, order, parent, acl }))
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, "zh-Hans-CN"));
  }

  /**
   * M1 本地实现：baseSha 直接比对磁盘当前 sha。
   * M2 的 githubStore 在此处内部消化 Git Data API 的 422：
   * 重取 ref → 以新 head tree 为 base_tree 只覆盖本次 path → 重建 tree/commit → 再 update ref（最多 3 次）；
   * 每轮重试后比对目标文件 blob sha 与 baseSha：仍相等 → 成功，已变 → conflict；三次仍 422 → conflict（仓库繁忙）。
   * 前端只看到同一份 SaveResult.conflict 语义，不感知重试。
   */
  async savePage(input: SaveInput): Promise<SaveResult> {
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

    await this.ensureDirs();
    const meta = await this.loadIndex();
    const id = pageId(contentPath);
    const existingFile = await this.readExisting(contentPath);
    const current = meta.pages.find((p) => p.path === contentPath);
    const currentSha = existingFile === null ? null : current?.sha ?? sha1(existingFile);

    // 乐观并发：客户端必须带它读到的 sha（新页面为 null）。
    if ((input.baseSha ?? null) !== currentSha) {
      return {
        ok: false,
        code: "conflict",
        message: "页面已被他人修改，请刷新后重试",
      };
    }

    const acl = current?.acl ?? [...DEFAULT_ACL];
    if (input.actor.role !== "admin" && !acl.includes(input.actor.role)) {
      return { ok: false, code: "forbidden", message: "当前账号无权编辑本页" };
    }

    // 图片：本地落盘到 data/uploads/<id>/，并把 markdown 里的 pending 路径改写成正式路径。
    let markdown = input.markdown;
    for (const image of input.images ?? []) {
      if (!image || typeof image.name !== "string" || !(image.bytes instanceof Uint8Array)) {
        return { ok: false, code: "invalid", message: "图片数据不合法" };
      }
      if (image.bytes.byteLength > 2 * 1024 * 1024) {
        return { ok: false, code: "invalid", message: `图片 ${image.name} 超过 2MB` };
      }
      const name = safeName(image.name);
      const dir = path.join(this.uploadsDir, id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, name), image.bytes);
      const publicUrl = `/uploads/${id}/${encodeURIComponent(name)}`;
      markdown = markdown
        .split(`/uploads/pending/${encodeURIComponent(name)}`).join(publicUrl)
        .split(`/uploads/pending/${name}`).join(publicUrl);
    }

    const now = new Date().toISOString();
    const sha = sha1(markdown);
    await fs.mkdir(path.dirname(this.fileFor(contentPath)), { recursive: true });
    await fs.writeFile(this.fileFor(contentPath), markdown, "utf8");

    const next: PageMeta = {
      id,
      path: contentPath,
      title: input.title.trim() || guessTitle(contentPath, markdown),
      sha,
      updatedAt: now,
      updatedBy: input.actor.name,
      acl,
      order: current?.order ?? 100,
      parent: current?.parent ?? parentOf(contentPath),
    };
    meta.pages = meta.pages.filter((p) => p.path !== contentPath);
    meta.pages.push(next);
    await this.writeMetaFile(meta);

    const revised: Revision = {
      sha,
      message: current ? `更新 ${next.title}` : `创建 ${next.title}`,
      date: now,
      author: input.actor.name,
      title: next.title,
      markdown,
    };
    await this.appendHistory(id, revised);

    return { ok: true, sha, commit: sha };
  }

  private async readExisting(contentPath: string): Promise<string | null> {
    try {
      return await fs.readFile(this.fileFor(contentPath), "utf8");
    } catch {
      return null;
    }
  }

  private async appendHistory(id: string, rev: Revision): Promise<void> {
    const file = path.join(this.historyDir, `${id}.json`);
    let list: Revision[] = [];
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as Revision[];
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      /* 首次保存 */
    }
    list.unshift(rev);
    await fs.writeFile(file, JSON.stringify(list.slice(0, 200), null, 2), "utf8");
  }

  private async readHistory(id: string): Promise<Revision[]> {
    try {
      const raw = await fs.readFile(path.join(this.historyDir, `${id}.json`), "utf8");
      const parsed = JSON.parse(raw) as Revision[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
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
    const revisions = await this.readHistory(pageId(contentPath));
    const n = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 10, 200));
    return revisions
      .slice(0, n)
      .map(({ sha, message, date, author }) => ({ sha, message, date, author }));
  }

  async restore(input: string, sha: string): Promise<SaveResult> {
    let contentPath: string;
    try {
      contentPath = normalizeContentPath(input);
    } catch (err) {
      return { ok: false, code: "invalid", message: (err as Error).message };
    }
    const revisions = await this.readHistory(pageId(contentPath));
    const target = revisions.find((r) => r.sha === sha);
    if (!target) return { ok: false, code: "invalid", message: "找不到该版本" };
    const current = await this.getPageByPath(contentPath);

    return this.savePage({
      path: contentPath,
      title: target.title,
      markdown: target.markdown,
      // 还原是一次新提交，基线取当前磁盘版本。
      baseSha: current?.sha ?? null,
      images: [],
      actor: { uid: "system", name: "版本还原", role: "admin" },
    });
  }
}

/* ------------------------------------------------------------------ *
 * 工厂：M2 在这里加分支（githubStore / blobStore），调用方一行不改。
 * ------------------------------------------------------------------ */
let singleton: ContentStore | null = null;

export function getStore(): ContentStore {
  if (!singleton) singleton = new LocalFileStore();
  return singleton;
}

export function createLocalStore(root: string): ContentStore {
  return new LocalFileStore(root);
}
