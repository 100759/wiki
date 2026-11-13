import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { GithubClient } from "./github";
import { GithubStore } from "./gitstore";
import { guessTitle, normalizeContentPath, pageId } from "./ids";
import { validateImage } from "./image-rules";

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

export interface UploadInput {
  pagePath: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
  actor: { uid: string; name: string; role: "admin" | "editor" | "viewer" };
}

export type UploadResult =
  | { ok: true; url: string }
  | { ok: false; code: "forbidden" | "invalid"; message: string };

export interface ContentStore {
  getPageByPath(path: string): Promise<PageRecord | null>;
  getPageById(id: string): Promise<PageRecord | null>;
  listPages(): Promise<PageSummary[]>;
  savePage(input: SaveInput): Promise<SaveResult>;
  /** 图片单独上传，避免 base64 撑爆保存请求体。 */
  uploadImage(input: UploadInput): Promise<UploadResult>;
  listHistory(
    path: string,
    limit: number,
  ): Promise<{ sha: string; message: string; date: string; author: string }[]>;
  /** 还原是写操作，必须带操作者，权限按操作者判。 */
  restore(path: string, sha: string, actor: SaveInput["actor"]): Promise<SaveResult>;
  /** 删除页面（同时清掉 meta 条目）。 */
  deletePage(path: string, actor: SaveInput["actor"]): Promise<SaveResult>;
  /** 重命名/移动页面。 */
  renamePage(from: string, to: string, actor: SaveInput["actor"]): Promise<SaveResult>;
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
  /** 数据目录是否可写；null = 尚未探测。只读部署下降级，不抛错。 */
  private writable: boolean | null = null;
  private bundledCache: Map<string, string> | null = null;

  constructor(root: string = defaultDataDir()) {
    this.root = root;
    this.contentDir = path.join(root, "content");
    this.metaFile = path.join(root, "meta.json");
    this.historyDir = path.join(root, "history");
    this.uploadsDir = path.join(root, "uploads");
  }

  /** 只探测一次：失败即进入只读模式，任何读写都不得因此抛 500。 */
  private async ensureDirs(): Promise<boolean> {
    if (this.writable !== null) return this.writable;
    try {
      await Promise.all([
        fs.mkdir(this.contentDir, { recursive: true }),
        fs.mkdir(this.historyDir, { recursive: true }),
        fs.mkdir(this.uploadsDir, { recursive: true }),
      ]);
      this.writable = true;
    } catch {
      this.writable = false;
    }
    return this.writable;
  }

  /** 构建期打包进产物的 content/ 快照；只读部署的首屏数据源。 */
  private async bundledPages(): Promise<Map<string, string>> {
    if (this.bundledCache) return this.bundledCache;
    try {
      const { getBundledPages } = await import("./bundled");
      const pages = await getBundledPages();
      this.bundledCache = new Map(pages.map((page) => [page.path, page.markdown]));
    } catch {
      this.bundledCache = new Map();
    }
    return this.bundledCache;
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

  private bundledMeta(contentPath: string, markdown: string): PageMeta {
    return {
      id: pageId(contentPath),
      path: contentPath,
      title: guessTitle(contentPath, markdown),
      sha: sha1(markdown),
      updatedAt: new Date(0).toISOString(),
      updatedBy: "seed",
      acl: [...DEFAULT_ACL],
      order: 100,
      parent: parentOf(contentPath),
    };
  }

  /** 索引缺失或落后于磁盘时，以磁盘为准补齐；无磁盘时用构建期打包内容兜底。 */
  private async loadIndex(): Promise<MetaFile> {
    const writable = await this.ensureDirs();
    const meta = await this.readMetaFile();
    const bundled = await this.bundledPages();
    const scanned = await this.scanMarkdown();
    const diskPaths = new Set(scanned.map((page) => page.path));
    const byPath = new Map(meta.pages.map((page) => [page.path, page]));
    let changed = false;

    // 打包内容作为基线；磁盘上已有同路径时以磁盘为准。
    for (const [contentPath, markdown] of bundled) {
      if (diskPaths.has(contentPath)) continue;
      const known = byPath.get(contentPath);
      const sha = sha1(markdown);
      if (!known) {
        const entry = this.bundledMeta(contentPath, markdown);
        meta.pages.push(entry);
        byPath.set(contentPath, entry);
        changed = true;
      } else if (known.sha !== sha) {
        known.sha = sha;
        changed = true;
      }
    }

    for (const page of scanned) {
      const known = byPath.get(page.path);
      if (!known) {
        meta.pages.push(page);
        byPath.set(page.path, page);
        changed = true;
      } else if (known.sha !== page.sha) {
        known.sha = page.sha;
        changed = true;
      }
    }

    const allowed = new Set([...bundled.keys(), ...diskPaths]);
    const pruned = meta.pages.filter((page) => allowed.has(page.path));
    if (pruned.length !== meta.pages.length) changed = true;
    meta.pages = pruned;

    if (changed && writable) {
      try {
        await this.writeMetaFile(meta);
      } catch {
        // 只读兜底：索引写不进去也不影响本次读取。
      }
    }
    return meta;
  }

  async getPageByPath(input: string): Promise<PageRecord | null> {
    let contentPath: string;
    try {
      contentPath = normalizeContentPath(input);
    } catch {
      return null;
    }

    try {
      const meta = await this.loadIndex();
      const bundled = await this.bundledPages();
      let entry = meta.pages.find((page) => page.path === contentPath);
      let markdown: string | null = null;

      try {
        markdown = await fs.readFile(this.fileFor(contentPath), "utf8");
      } catch {
        markdown = bundled.get(contentPath) ?? null;
      }
      if (markdown === null) return null;

      if (!entry) {
        entry = this.bundledMeta(contentPath, markdown);
      }
      return { ...entry, markdown };
    } catch {
      return null;
    }
  }

  async getPageById(id: string): Promise<PageRecord | null> {
    try {
      const meta = await this.loadIndex();
      const entry = meta.pages.find((page) => page.id === id);
      if (!entry) return null;
      return this.getPageByPath(entry.path);
    } catch {
      return null;
    }
  }

  async listPages(): Promise<PageSummary[]> {
    try {
      const meta = await this.loadIndex();
      return meta.pages
        .map(({ id, path: p, title, order, parent, acl }) => ({ id, path: p, title, order, parent, acl }))
        .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, "zh-Hans-CN"));
    } catch {
      return [];
    }
  }

  /**
   * M1 本地实现：baseSha 直接比对磁盘当前 sha。
   * M2 的 githubStore 在此处内部消化 Git Data API 的 422：
   * 重取 ref → 以新 head tree 为 base_tree 只覆盖本次 path → 重建 tree/commit → 再 update ref（最多 3 次）；
   * 每轮重试后比对目标文件 blob sha 与 baseSha：仍相等 → 成功，已变 → conflict；三次仍 422 → conflict（仓库繁忙）。
   * 前端只看到同一份 SaveResult.conflict 语义，不感知重试。
   */
  async savePage(input: SaveInput): Promise<SaveResult> {
    try {
      return await this.savePageImpl(input);
    } catch (err) {
      // 存储异常不得传染成 500；前端按可重试失败处理。
      return { ok: false, code: "invalid", message: `存储异常：${(err as Error).message}` };
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

    // 只读部署（EdgeOne /var/user 只读）：不抛错，返回可读失败原因。
    if (!(await this.ensureDirs())) {
      return {
        ok: false,
        code: "invalid",
        message: "当前部署为只读存储，保存需在 M2 接入 Blob/GitHub",
      };
    }

    const meta = await this.loadIndex();
    const id = pageId(contentPath);
    const existingFile = await this.readExisting(contentPath);
    const current = meta.pages.find((p) => p.path === contentPath);
    // 打包内容也参与并发基线：磁盘没有该页时以索引里的 sha 为准。
    const currentSha = existingFile !== null ? current?.sha ?? sha1(existingFile) : current?.sha ?? null;

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

  async uploadImage(input: UploadInput): Promise<UploadResult> {
    if (input.actor.role === "viewer") {
      return { ok: false, code: "forbidden", message: "viewer 角色不能上传图片" };
    }
    if (!(await this.ensureDirs())) {
      return { ok: false, code: "invalid", message: "当前部署为只读存储，图片需在 M2 接入 GitHub" };
    }
    let contentPath: string;
    try {
      contentPath = normalizeContentPath(input.pagePath);
    } catch (err) {
      return { ok: false, code: "invalid", message: (err as Error).message };
    }
    const verdict = validateImage(input.name, input.mime, input.bytes.byteLength);
    if (!verdict.ok) return { ok: false, code: "invalid", message: verdict.message };
    const id = pageId(contentPath);
    const name = safeName(input.name);
    const dir = path.join(this.uploadsDir, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), input.bytes);
    return { ok: true, url: `/uploads/${id}/${encodeURIComponent(name)}` };
  }

  async deletePage(input: string, actor: SaveInput["actor"]): Promise<SaveResult> {
    if (actor.role === "viewer") return { ok: false, code: "forbidden", message: "viewer 角色不能删除页面" };
    let contentPath: string;
    try {
      contentPath = normalizeContentPath(input);
    } catch (err) {
      return { ok: false, code: "invalid", message: (err as Error).message };
    }
    if (!(await this.ensureDirs())) {
      return { ok: false, code: "invalid", message: "当前部署为只读存储" };
    }
    const meta = await this.loadIndex();
    const current = meta.pages.find((p) => p.path === contentPath);
    if (!current) return { ok: false, code: "invalid", message: "页面不存在" };
    const acl = current.acl.length > 0 ? current.acl : [...DEFAULT_ACL];
    if (actor.role !== "admin" && !acl.includes(actor.role)) {
      return { ok: false, code: "forbidden", message: "当前账号无权删除本页" };
    }
    try {
      await fs.unlink(this.fileFor(contentPath));
    } catch {
      /* 文件不存在也继续清索引 */
    }
    meta.pages = meta.pages.filter((p) => p.path !== contentPath);
    await this.writeMetaFile(meta);
    return { ok: true, sha: "", commit: "" };
  }

  async renamePage(from: string, to: string, actor: SaveInput["actor"]): Promise<SaveResult> {
    if (actor.role === "viewer") return { ok: false, code: "forbidden", message: "viewer 角色不能重命名页面" };
    let fromPath: string;
    let toPath: string;
    try {
      fromPath = normalizeContentPath(from);
      toPath = normalizeContentPath(to);
    } catch (err) {
      return { ok: false, code: "invalid", message: (err as Error).message };
    }
    if (fromPath === toPath) return { ok: false, code: "invalid", message: "新旧路径相同" };
    if (!(await this.ensureDirs())) {
      return { ok: false, code: "invalid", message: "当前部署为只读存储" };
    }
    const page = await this.getPageByPath(fromPath);
    if (!page) return { ok: false, code: "invalid", message: "页面不存在" };
    if (actor.role !== "admin" && !page.acl.includes(actor.role)) {
      return { ok: false, code: "forbidden", message: "当前账号无权移动本页" };
    }
    if (await this.getPageByPath(toPath)) {
      return { ok: false, code: "invalid", message: "目标路径已存在" };
    }
    const created = await this.savePage({
      path: toPath,
      title: page.title,
      markdown: page.markdown,
      baseSha: null,
      images: [],
      actor,
    });
    if (!created.ok) return created;
    return this.deletePage(fromPath, actor);
  }

  async restore(input: string, sha: string, actor: SaveInput["actor"]): Promise<SaveResult> {
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
      actor,
    });
  }
}

/* ------------------------------------------------------------------ *
 * 工厂：有 GitHub 凭据走 githubStore（唯一真源），否则退回 localFileStore。
 * 调用方一行不改。
 * ------------------------------------------------------------------ */
let singleton: ContentStore | null = null;
let clientSingleton: GithubClient | null = null;

const VAULT_TOKEN_PATH =
  "/Users/fuheng/Library/Application Support/OpenBot/agent-api-keys/.vault/GITHUB_WIKI_TOKEN";

/** 同步取 token：环境变量 → GITHUB_TOKEN_FILE → 本机 Vault 文件（本地调试用）。 */
function resolveTokenSync(): string {
  const fromEnv = (process.env.GITHUB_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;
  const candidates = [process.env.GITHUB_TOKEN_FILE ?? "", VAULT_TOKEN_PATH].filter(Boolean);
  for (const file of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const raw = readFileSync(file, "utf8").trim();
      if (raw) return raw;
    } catch {
      /* 继续尝试下一个来源 */
    }
  }
  return "";
}

export function getGithubClient(): GithubClient | null {
  if (clientSingleton) return clientSingleton;
  const repo = (process.env.GITHUB_REPO ?? "").trim();
  const token = resolveTokenSync();
  if (!repo || !token) return null;
  clientSingleton = new GithubClient({
    repo,
    branch: (process.env.GITHUB_BRANCH ?? "").trim() || "main",
    token,
    proxy: (process.env.GITHUB_PROXY ?? "").trim() || null,
  });
  return clientSingleton;
}

export function getStore(): ContentStore {
  if (singleton) return singleton;
  const client = getGithubClient();
  singleton = client ? new GithubStore(client) : new LocalFileStore();
  return singleton;
}

/** 供自测切换实现用。 */
export function resetStore(): void {
  singleton = null;
  clientSingleton = null;
}

export function createLocalStore(root: string): ContentStore {
  return new LocalFileStore(root);
}
