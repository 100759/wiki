/**
 * M2 自测：鉴权、限流、原子提交、并发冲突、图片落库。
 * 用内存假 GitHub 跑 Git Data API，不碰真实仓库、不发网络请求。
 */
import { createHash } from "node:crypto";
import { commitFiles } from "../src/lib/gitcommit";
import { GithubClient, type HttpRequest, type HttpResponse } from "../src/lib/github";
import { GithubStore } from "../src/lib/gitstore";
import {
  checkRateLimit,
  hashPassword,
  PBKDF2_ITERATIONS,
  recordFailure,
  resetRateLimits,
  signSession,
  verifyPassword,
  verifySessionToken,
} from "../src/lib/session";

let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ------------------------- 内存版 GitHub ------------------------- */

function gitBlobSha(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.byteLength}\0`).update(content).digest("hex");
}

interface FakeCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  date: string;
  author: string;
}

class FakeGithub {
  files = new Map<string, { content: Buffer; sha: string }>();
  commits = new Map<string, FakeCommit>();
  trees = new Map<string, string>();
  ref = "";
  private counter = 0;
  /** 下一次 updateRef 时插一个别人的提交（只改 otherPath）。 */
  interleave: { path: string; content: string } | null = null;
  /** 下一次 updateRef 直接拒绝一次，用于测 422 重试。 */
  raceOnce = false;
  failMetaBlobOnce = false;
  raceMeta = false;
  interleaveMeta = false;
  blobs = new Map<string, Buffer>();

  constructor(seed: Record<string, string>) {
    for (const [path, content] of Object.entries(seed)) this.put(path, content);
    this.ref = this.commit("初始化", []);
  }

  private nextId(): string {
    this.counter += 1;
    return createHash("sha1").update(`id-${this.counter}`).digest("hex");
  }

  private put(path: string, content: string): void {
    const buffer = Buffer.from(content, "utf8");
    this.files.set(path, { content: buffer, sha: gitBlobSha(buffer) });
  }

  private commit(message: string, parents: string[], author = "test"): string {
    const tree = this.nextId();
    const sha = this.nextId();
    this.trees.set(tree, sha);
    this.commits.set(sha, { sha, tree, parents, message, date: new Date().toISOString(), author });
    return sha;
  }

  /** 模拟别人提交：改指定文件，ref 前进。 */
  externalCommit(path: string, content: string, message = "external"): string {
    this.put(path, content);
    this.ref = this.commit(message, [this.ref], "someone-else");
    return this.ref;
  }

  transport = async (req: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/repos\/o\/r/, "");
    const method = req.method;
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};

    const respond = (json: unknown, status = 200): HttpResponse => ({
      status,
      body: JSON.stringify(json),
    });

    if (method === "GET" && path === "/git/ref/heads/main") {
      return respond({ object: { sha: this.ref } });
    }

    if (method === "GET" && path.startsWith("/git/trees/")) {
      const ref = decodeURIComponent(path.slice("/git/trees/".length));
      const commit = this.commits.get(ref);
      if (!commit) return respond({ message: "Not Found" }, 404);
      const tree = [...this.files.entries()].map(([p, file]) => ({ path: p, sha: file.sha, type: "blob" }));
      return respond({ sha: commit.tree, tree, truncated: false });
    }

    if (method === "GET" && path.startsWith("/git/blobs/")) {
      const sha = path.slice("/git/blobs/".length);
      const metaEntry = this.files.get("_system/meta.json");
      if (this.failMetaBlobOnce && metaEntry && metaEntry.sha === sha) {
        this.failMetaBlobOnce = false;
        return respond({ message: "Server Error" }, 500);
      }
      for (const file of this.files.values()) {
        if (file.sha === sha) {
          return respond({ sha, encoding: "base64", content: file.content.toString("base64") });
        }
      }
      return respond({ message: "Not Found" }, 404);
    }

    if (method === "POST" && path === "/git/blobs") {
      const content = Buffer.from(String(body.content ?? ""), "base64");
      const sha = gitBlobSha(content);
      this.blobs.set(sha, content);
      return respond({ sha });
    }

    if (method === "POST" && path === "/git/trees") {
      const entries = (body.tree ?? []) as { path: string; sha: string | null }[];
      const staged = new Map(this.files);
      for (const entry of entries) {
        if (entry.sha === null) {
          staged.delete(entry.path);
          continue;
        }
        const blob = this.findBlob(entry.sha);
        if (!blob) return respond({ message: "blob 不存在" }, 422);
        staged.set(entry.path, { content: blob, sha: entry.sha });
      }
      const sha = this.nextId();
      this.trees.set(sha, sha);
      this.staged.set(sha, staged);
      return respond({ sha });
    }

    if (method === "POST" && path === "/git/commits") {
      const treeStaged = this.staged.get(String(body.tree));
      if (!treeStaged) return respond({ message: "tree 不存在" }, 422);
      const parents = (body.parents ?? []) as string[];
      const sha = this.nextId();
      this.commits.set(sha, {
        sha,
        tree: String(body.tree),
        parents,
        message: String(body.message ?? ""),
        date: new Date().toISOString(),
        author: "test",
      });
      this.pending.set(sha, treeStaged);
      return respond({ sha });
    }

    if (method === "PATCH" && path.startsWith("/git/refs/heads/")) {
      const target = String(body.sha ?? "");
      const commit = this.commits.get(target);
      if (!commit) return respond({ message: "commit 不存在" }, 422);

      if (this.raceOnce) {
        this.raceOnce = false;
        this.interleave = { path: "content/other.md", content: "# 别人改的另一页\n" };
        if (this.raceMeta) {
          this.raceMeta = false;
          this.interleaveMeta = true;
        }
      }
      if (this.interleave) {
        const { path: p, content } = this.interleave;
        this.interleave = null;
        this.externalCommit(p, content, "concurrent");
        if (this.interleaveMeta) {
          this.interleaveMeta = false;
          const meta = this.files.get("_system/meta.json");
          const parsed = meta ? (JSON.parse(meta.content.toString("utf8")) as { version: number; pages: Record<string, unknown> }) : { version: 1, pages: {} };
          parsed.pages["content/other.md"] = { title: "别人改的另一页", order: 100, acl: ["admin"], updatedAt: new Date().toISOString(), updatedBy: "someone-else" };
          this.externalCommit("_system/meta.json", `${JSON.stringify(parsed, null, 2)}\n`, "concurrent meta");
        }
        return respond({ message: "Update is not a fast forward" }, 422);
      }
      if ((commit.parents[0] ?? null) !== this.ref) {
        return respond({ message: "Update is not a fast forward" }, 422);
      }
      const staged = this.pending.get(target);
      if (staged) {
        this.files = new Map(staged);
        this.pending.delete(target);
      }
      this.ref = target;
      return respond({ object: { sha: target } });
    }

    if (method === "GET" && path.startsWith("/contents/")) {
      const filePath = decodeURIComponent(path.slice("/contents/".length));
      const ref = url.searchParams.get("ref") ?? this.ref;
      const commit = this.commits.get(ref);
      if (!commit) return respond({ message: "Not Found" }, 404);
      const staged = this.pending.get(ref);
      const files = staged ?? this.files;
      const file = files.get(filePath);
      if (!file) return respond({ message: "Not Found" }, 404);
      return respond({ sha: file.sha, encoding: "base64", content: file.content.toString("base64") });
    }

    if (method === "GET" && path.startsWith("/commits")) {
      const target = url.searchParams.get("path") ?? "";
      const list = [...this.commits.values()]
        .filter((c) => c.parents[0] !== undefined || c.parents.length === 0)
        .reverse()
        .slice(0, 10)
        .map((c) => ({ sha: c.sha, commit: { message: c.message, author: { name: c.author, date: c.date } } }));
      void target;
      return respond(list);
    }

    return respond({ message: `未实现：${method} ${path}` }, 404);
  };

  staged = new Map<string, Map<string, { content: Buffer; sha: string }>>();
  pending = new Map<string, Map<string, { content: Buffer; sha: string }>>();

  private findBlob(sha: string): Buffer | null {
    const known = this.blobs.get(sha);
    if (known) return known;
    for (const file of this.files.values()) if (file.sha === sha) return file.content;
    for (const staged of this.staged.values()) {
      for (const file of staged.values()) if (file.sha === sha) return file.content;
    }
    for (const staged of this.pending.values()) {
      for (const file of staged.values()) if (file.sha === sha) return file.content;
    }
    return null;
  }
}

/* ------------------------- 测试 ------------------------- */

async function testAuth(): Promise<void> {
  console.log("\n[1] 口令与会话");
  const record = await hashPassword("correct horse battery", 1000);
  ok("正确口令通过", await verifyPassword("correct horse battery", record));
  ok("错误口令拒绝", !(await verifyPassword("wrong password", record)));
  ok("未注册用户拒绝", !(await verifyPassword("x", null)));
  ok("默认轮数 600k", PBKDF2_ITERATIONS === 600_000);
  ok("哈希不含明文", !JSON.stringify(record).includes("correct horse"));

  process.env.JWT_SECRET = "test-secret-0123456789abcdef";
  const token = signSession({ uid: "u1", name: "张三", role: "editor" });
  ok("会话可验证", verifySessionToken(token)?.name === "张三");
  ok("篡改角色被拒", verifySessionToken(`${token.slice(0, -2)}xy`) === null);
  ok("伪造 payload 被拒", verifySessionToken(`eyJyb2xlIjoiYWRtaW4ifQ.${token.split(".")[1]}`) === null);
  ok("过期会话被拒", verifySessionToken(token, Date.now() + 8 * 24 * 3600 * 1000) === null);
  delete process.env.JWT_SECRET;
  ok("无密钥时拒绝签发", (() => {
    try {
      signSession({ uid: "u", name: "n", role: "admin" });
      return false;
    } catch {
      return true;
    }
  })());
}

function testRateLimit(): void {
  console.log("\n[2] 登录限流");
  resetRateLimits();
  const now = Date.now();
  for (let i = 0; i < 5; i += 1) recordFailure("1.2.3.4", "bob", now);
  ok("第 6 次被锁定", !checkRateLimit("1.2.3.4", "bob", now).allowed);
  ok("其他用户不受影响", checkRateLimit("5.6.7.8", "alice", now).allowed);
  ok("锁定期内即使换 IP 也被账号维度挡住", !checkRateLimit("9.9.9.9", "bob", now).allowed);
  ok("15 分钟后解锁", checkRateLimit("1.2.3.4", "bob", now + 16 * 60 * 1000).allowed);

  // 单账号锁定不影响同 IP 的其他账号（共享出口 IP 不该被误伤）
  resetRateLimits();
  for (let i = 0; i < 5; i += 1) recordFailure("7.7.7.7", "bob", now);
  ok("同 IP 的其他账号仍可登录", checkRateLimit("7.7.7.7", "carol", now).allowed);

  // 换用户名硬刷：同 IP 累计到阈值后整体锁定
  resetRateLimits();
  for (let i = 0; i < 20; i += 1) recordFailure("7.7.7.7", `u${i}`, now);
  ok("同 IP 换名刷到阈值后被锁", !checkRateLimit("7.7.7.7", "fresh-name", now).allowed);
  resetRateLimits();
}

async function testStore(): Promise<void> {
  console.log("\n[3] 原子提交与并发");
  const fake = new FakeGithub({
    "content/index.md": "# 首页\n\n欢迎。\n",
    "_system/meta.json": JSON.stringify({ version: 1, pages: {} }),
  });
  const client = new GithubClient({ repo: "o/r", branch: "main", token: "t", proxy: null }, fake.transport);
  const store = new GithubStore(client);

  const page = await store.getPageByPath("content/index.md");
  ok("读到页面", page?.title === "首页");
  ok("sha 是 git blob sha", /^[0-9a-f]{40}$/.test(page?.sha ?? ""));

  const created = await store.savePage({
    path: "content/about.md",
    title: "关于",
    markdown: "# 关于\n\n你好。\n",
    baseSha: null,
    images: [],
    actor: { uid: "u1", name: "张三", role: "editor" },
  });
  ok("新建页面成功", created.ok, JSON.stringify(created));
  ok("返回 commit sha", created.ok && /^[0-9a-f]{40}$/.test(created.commit));

  const stale = await store.savePage({
    path: "content/about.md",
    title: "关于",
    markdown: "# 关于\n\n旧基线。\n",
    baseSha: page?.sha ?? null,
    images: [],
    actor: { uid: "u1", name: "张三", role: "editor" },
  });
  ok("过期 baseSha 判冲突", !stale.ok && stale.code === "conflict");

  const fresh = await store.getPageByPath("content/about.md");
  // 模拟真实的并发保存：另一个编辑改的是别的页，但同样重写了 _system/meta.json。
  fake.raceMeta = true;
  fake.raceOnce = true;
  const raced = await store.savePage({
    path: "content/about.md",
    title: "关于",
    markdown: "# 关于\n\n第一次提交会遇到 422。\n",
    baseSha: fresh?.sha ?? null,
    images: [],
    actor: { uid: "u1", name: "张三", role: "editor" },
  });
  ok("422 后重试成功（别人改的是别的页，且同时重写了 meta）", raced.ok, JSON.stringify(raced));
  ok("重试后 meta 里两页都在", (fake.files.get("_system/meta.json")?.content.toString("utf8") ?? "").includes("content/other.md") && (fake.files.get("_system/meta.json")?.content.toString("utf8") ?? "").includes("content/about.md"));

  const current = await store.getPageByPath("content/about.md");
  fake.externalCommit("content/about.md", "# 关于\n\n别人抢先写了。\n");
  const conflict = await store.savePage({
    path: "content/about.md",
    title: "关于",
    markdown: "# 关于\n\n我要写。\n",
    baseSha: current?.sha ?? null,
    images: [],
    actor: { uid: "u1", name: "张三", role: "editor" },
  });
  ok("同页被抢改判冲突", !conflict.ok && conflict.code === "conflict");

  const viewerTry = await store.savePage({
    path: "content/about.md",
    title: "x",
    markdown: "x",
    baseSha: null,
    images: [],
    actor: { uid: "u3", name: "读者", role: "viewer" },
  });
  ok("viewer 被拒", !viewerTry.ok && viewerTry.code === "forbidden");

  const withImage = await store.savePage({
    path: "content/pic.md",
    title: "带图",
    markdown: "# 带图\n\n![图](/uploads/pending/a.png)\n",
    baseSha: null,
    images: [
      { name: "a.png", mime: "image/png", bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) },
    ],
    actor: { uid: "u2", name: "李四", role: "admin" },
  });
  ok("带图保存成功", withImage.ok, JSON.stringify(withImage));
  const pic = await store.getPageByPath("content/pic.md");
  ok("正文图片路径改写为 /img/assets/", (pic?.markdown ?? "").includes("/img/assets/"));
  ok("仓库里落到 assets/", [...fake.files.keys()].some((p) => p.startsWith("assets/")));

  // meta 读取失败时必须整体失败，不能拿空表覆盖别人的 title/order/ACL。
  const metaSha = fake.files.get("_system/meta.json")?.sha ?? "";
  const failTransport = async (req: HttpRequest): Promise<HttpResponse> =>
    req.method === "GET" && req.url.includes("/git/blobs/") && req.url.endsWith(metaSha)
      ? { status: 500, body: JSON.stringify({ message: "Server Error" }) }
      : fake.transport(req);
  const failClient = new GithubClient(
    { repo: "o/r", branch: "main", token: "t", proxy: null },
    failTransport,
  );
  const failStore = new GithubStore(failClient);
  const aboutFile = fake.files.get("content/about.md");
  const metaFail = await failStore.savePage({
    path: "content/about.md",
    title: "关于",
    markdown: "# 关于\n\nmeta 读失败时的写入。\n",
    baseSha: aboutFile?.sha ?? null,
    images: [],
    actor: { uid: "u2", name: "李四", role: "admin" },
  });
  ok("meta 读失败时保存整体失败", !metaFail.ok, JSON.stringify(metaFail));
  const afterMeta = JSON.parse(fake.files.get("_system/meta.json")?.content.toString("utf8") ?? "{}") as {
    pages: Record<string, { acl?: string[] }>;
  };
  ok(
    "meta 读失败后仓库里的 meta 未被改动",
    (fake.files.get("_system/meta.json")?.sha ?? "") === metaSha &&
      Object.keys(afterMeta.pages).length > 0,
  );

  const bigImage = await store.savePage({
    path: "content/big.md",
    title: "大图",
    markdown: "x",
    baseSha: null,
    images: [{ name: "b.png", mime: "image/png", bytes: new Uint8Array(900 * 1024) }],
    actor: { uid: "u2", name: "李四", role: "admin" },
  });
  ok("超过 800KB 被拒", !bigImage.ok && bigImage.code === "invalid");

  const history = await store.listHistory("content/about.md", 5);
  ok("有提交历史", history.length > 0);

  const restored = await store.restore("content/pic.md", withImage.ok ? withImage.commit : "", {
    uid: "u2",
    name: "李四",
    role: "admin",
  });
  ok("还原生成新提交", restored.ok, JSON.stringify(restored));

  // 图片走独立上传接口，不进保存请求体
  const upload = await store.uploadImage({
    pagePath: "content/pic.md",
    name: "up.png",
    mime: "image/png",
    bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    actor: { uid: "u2", name: "李四", role: "admin" },
  });
  ok("图片上传成功", upload.ok && upload.url.startsWith("/img/assets/"), JSON.stringify(upload));
  const badExt = await store.uploadImage({
    pagePath: "content/pic.md",
    name: "up.webp",
    mime: "image/png",
    bytes: new Uint8Array([1, 2, 3]),
    actor: { uid: "u2", name: "李四", role: "admin" },
  });
  ok("扩展名与类型不匹配被拒", !badExt.ok);
  // 还原按操作者判权：editor 不能还原 admin-only 页
  const adminMeta = JSON.parse(fake.files.get("_system/meta.json")?.content.toString("utf8") ?? "{}") as {
    pages: Record<string, { acl?: string[] }>;
  };
  adminMeta.pages["content/pic.md"] = { acl: ["admin"] };
  await commitFiles(client, {
    message: "把 pic 设为 admin-only",
    files: [{ path: "_system/meta.json", content: `${JSON.stringify(adminMeta, null, 2)}\n` }],
    expected: { "_system/meta.json": fake.files.get("_system/meta.json")?.sha ?? null },
  });
  const editorRestore = await store.restore("content/pic.md", withImage.ok ? withImage.commit : "", {
    uid: "u1",
    name: "张三",
    role: "editor",
  });
  ok("editor 不能还原 admin-only 页", !editorRestore.ok && editorRestore.code === "forbidden");

  // 本地实现必须用同一套规则（工部 R2：只有 GitHub 实现校验属假绿）
  const { LocalFileStore } = await import("../src/lib/storage");
  const local = new LocalFileStore("/private/var/folders/27/fmhxq5jj63l_bfmvccc7ghsh0000gn/T/opencode/m2local");
  const localSvg = await local.uploadImage({
    pagePath: "content/a.md",
    name: "x.svg",
    mime: "image/png",
    bytes: new Uint8Array([1, 2, 3]),
    actor: { uid: "u2", name: "李四", role: "admin" },
  });
  ok("本地实现也校验类型与扩展名", !localSvg.ok, JSON.stringify(localSvg));

  const viewerUpload = await store.uploadImage({
    pagePath: "content/pic.md",
    name: "up.png",
    mime: "image/png",
    bytes: new Uint8Array([1, 2, 3]),
    actor: { uid: "u3", name: "读者", role: "viewer" },
  });
  ok("viewer 不能上传", !viewerUpload.ok && viewerUpload.code === "forbidden");
}

async function testCommitFiles(): Promise<void> {
  console.log("\n[4] commitFiles 直测");
  const fake = new FakeGithub({ "content/a.md": "# A\n", "content/b.md": "# B\n" });
  const client = new GithubClient({ repo: "o/r", branch: "main", token: "t", proxy: null }, fake.transport);
  const tree = await client.tree();
  const aSha = tree.entries.get("content/a.md")?.sha ?? null;

  const outcome = await commitFiles(client, {
    message: "改两个文件",
    files: [
      { path: "content/a.md", content: "# A2\n" },
      { path: "content/b.md", content: "# B2\n" },
    ],
    expected: { "content/a.md": aSha, "content/b.md": tree.entries.get("content/b.md")?.sha ?? null },
  });
  ok("多文件单次提交", outcome.ok, JSON.stringify(outcome));
  ok("commit 里同时改了正文", fake.files.get("content/b.md")?.content.toString("utf8") === "# B2\n");

  // 新建页在"自己上一次提交其实已落地、响应丢失"时不能误判冲突（want === null）。
  await commitFiles(client, {
    message: "首次写入 dup",
    files: [{ path: "content/dup.md", content: "# 重复\n" }],
    expected: { "content/dup.md": null },
  });
  const replay = await commitFiles(client, {
    message: "重复提交同样内容",
    files: [{ path: "content/dup.md", content: "# 重复\n" }],
    expected: { "content/dup.md": null },
  });
  ok("新建页重复提交判定为已成功", replay.ok, JSON.stringify(replay));
  ok("已落地分支回传真实 blob sha", replay.ok && /^[0-9a-f]{40}$/.test(replay.blobs["content/dup.md"] ?? ""));
}

async function testManage(): Promise<void> {
  console.log("\n[5] 页面管理与搜索");
  const fake = new FakeGithub({
    "content/index.md": "# 首页\n\n欢迎来到共创 Wiki。\n",
    "content/guide/start.md": "# 快速上手\n\n先登录，再编辑。\n",
    "_system/meta.json": JSON.stringify({ version: 1, pages: { "content/guide/start.md": { title: "快速上手", acl: ["admin"] } } }),
  });
  const client = new GithubClient({ repo: "o/r", branch: "main", token: "t", proxy: null }, fake.transport);
  const store = new GithubStore(client);
  const admin = { uid: "u1", name: "管理员", role: "admin" as const };
  const editor = { uid: "u2", name: "编辑", role: "editor" as const };

  const renamed = await store.renamePage("content/guide/start.md", "content/guide/intro.md", admin);
  ok("重命名成功", renamed.ok, JSON.stringify(renamed));
  ok("旧路径已删除", !(await store.getPageByPath("content/guide/start.md")));
  ok("新路径可读", (await store.getPageByPath("content/guide/intro.md"))?.title === "快速上手");
  const metaAfter = JSON.parse(fake.files.get("_system/meta.json")?.content.toString("utf8") ?? "{}") as {
    pages: Record<string, { acl?: string[] }>;
  };
  ok("meta 条目跟着迁移", JSON.stringify(metaAfter.pages["content/guide/intro.md"]?.acl) === '["admin"]' && !metaAfter.pages["content/guide/start.md"]);

  const editorDelete = await store.deletePage("content/guide/intro.md", editor);
  ok("editor 不能删 admin-only 页", !editorDelete.ok && editorDelete.code === "forbidden");

  const deleted = await store.deletePage("content/guide/intro.md", admin);
  ok("管理员删除成功", deleted.ok, JSON.stringify(deleted));
  ok("删除后读不到", !(await store.getPageByPath("content/guide/intro.md")));

  const { searchPages } = await import("../src/lib/search");
  const byTitle = await searchPages(store, "首页");
  ok("搜索命中标题", byTitle.length === 1 && byTitle[0]?.path === "content/index.md");
  const byBody = await searchPages(store, "欢迎");
  ok("搜索命中正文", byBody.length === 1);
  const { retrievePages } = await import("../src/lib/search");
  const retrieved = await retrievePages(store, "怎么登录并编辑", 2);
  ok("问答检索能按语义片段命中", retrieved.some((item) => item.path === "content/guide/intro.md" || item.path === "content/index.md"));
  const fallback = await retrievePages(store, "完全无关的问题xyz", 2);
  ok("检索无命中时退回站内页面", fallback.length > 0);

  const none = await searchPages(store, "不存在的词");
  ok("无匹配返回空", none.length === 0);
}

async function testAi(): Promise<void> {
  console.log("\n[6] AI 问答");
  const { aiConfig, chat } = await import("../src/lib/ai");

  delete process.env.MAKERS_MODELS_KEY;
  delete process.env.AI_API_KEY;
  ok("无密钥时返回 not_configured", (await chat([{ role: "user", content: "hi" }])).ok === false);

  process.env.MAKERS_MODELS_KEY = "test-key";
  const config = aiConfig();
  ok("默认网关地址正确", config?.baseUrl === "https://ai-gateway.edgeone.link/v1");
  ok("默认模型正确", config?.model === "@makers/deepseek-v4-flash");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "  只根据资料回答  " } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const good = await chat([{ role: "user", content: "q" }]);
  ok("正常返回并去空白", good.ok && good.text === "只根据资料回答");

  globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  const bad = await chat([{ role: "user", content: "q" }]);
  ok("上游 500 归类为 upstream", !bad.ok && bad.code === "upstream");

  globalThis.fetch = originalFetch;
  delete process.env.MAKERS_MODELS_KEY;
}

async function main(): Promise<void> {
  await testAuth();
  testRateLimit();
  await testStore();
  await testCommitFiles();
  await testManage();
  await testAi();
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

void main();
