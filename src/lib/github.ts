import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import { promises as fs } from "node:fs";

/* ------------------------------------------------------------------ *
 * GitHub Git Data API 客户端（M2）
 *  - 只用 Node 内置模块，无第三方依赖；EdgeOne 运行时是 Node 22。
 *  - 支持通过 GITHUB_PROXY 走本机代理（仅本地调试用，线上直连）。
 *  - token 只从环境变量或文件读取，任何错误信息里都不带 token。
 * ------------------------------------------------------------------ */

export interface GithubConfig {
  repo: string;
  branch: string;
  token: string;
  proxy: string | null;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export class GithubError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "GithubError";
    this.status = status;
    this.code = code;
  }
}

/** 422：ref 已前进（乐观锁失败）。调用方按 v2 规则重试或判定冲突。 */
export class RefMovedError extends GithubError {
  constructor(message = "ref 已前进") {
    super(422, "ref_moved", message);
    this.name = "RefMovedError";
  }
}

const VAULT_TOKEN_PATH =
  "/Users/fuheng/Library/Application Support/OpenBot/agent-api-keys/.vault/GITHUB_WIKI_TOKEN";

export async function resolveToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fromEnv = (env.GITHUB_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;
  const candidates = [env.GITHUB_TOKEN_FILE, VAULT_TOKEN_PATH].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  for (const file of candidates) {
    try {
      const raw = (await fs.readFile(file, "utf8")).trim();
      if (raw) return raw;
    } catch {
      /* 继续尝试下一个来源 */
    }
  }
  throw new GithubError(0, "no_token", "未配置 GITHUB_TOKEN（或 GITHUB_TOKEN_FILE）");
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GithubConfig {
  const repo = (env.GITHUB_REPO ?? "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new GithubError(0, "not_configured", "GITHUB_REPO 未配置或格式不对，应为 owner/repo");
  }
  return {
    repo,
    branch: (env.GITHUB_BRANCH ?? "").trim() || "main",
    token: (env.GITHUB_TOKEN ?? "").trim(),
    proxy: (env.GITHUB_PROXY ?? "").trim() || null,
  };
}

/* ---------------------------- 代理隧道 ---------------------------- */

class ProxyAgent extends https.Agent {
  constructor(private readonly proxy: URL) {
    super({ keepAlive: false });
  }

  override createConnection(
    options: https.RequestOptions,
    callback: (err: Error | null, socket?: tls.TLSSocket) => void,
  ): unknown {
    const host = String(options.host ?? options.hostname ?? "");
    const port = Number(options.port ?? 443);
    const connectReq = http.request({
      host: this.proxy.hostname,
      port: Number(this.proxy.port || 80),
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` },
      agent: false,
    });

    connectReq.on("connect", (res: http.IncomingMessage, socket: import("node:net").Socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        callback(new GithubError(res.statusCode ?? 0, "proxy", `代理 CONNECT 失败：${res.statusCode ?? 0}`));
        return;
      }
      const secure = tls.connect({ socket, servername: host }, () => callback(null, secure));
      secure.on("error", (err) => callback(err as Error));
    });
    connectReq.on("error", (err) => callback(err as Error));
    connectReq.end();
    return undefined;
  }
}

function rawRequest(req: HttpRequest, proxy: string | null): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(req.url);
    const options: https.RequestOptions = {
      method: req.method,
      host: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      headers: {
        "user-agent": "wiki-site/0.2 (+github-git-data)",
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        ...req.headers,
      },
    };
    if (req.body !== undefined) {
      options.headers = { ...options.headers, "content-length": Buffer.byteLength(req.body) };
    }
    if (proxy) options.agent = new ProxyAgent(new URL(proxy));

    const request = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    request.on("error", reject);
    if (req.body !== undefined) request.write(req.body);
    request.end();
  });
}

export const nodeTransport: Transport = (req) => rawRequest(req, currentProxy);

let currentProxy: string | null = null;

/* ---------------------------- 客户端 ---------------------------- */

export interface TreeEntry {
  path: string;
  sha: string;
  type: string;
}

export interface CommitInfo {
  sha: string;
  message: string;
  date: string;
  author: string;
}

export interface GithubFile {
  path: string;
  content: Buffer;
  text: string;
}

const TREE_TTL_MS = 10_000;

export class GithubClient {
  readonly config: GithubConfig;
  private readonly transport: Transport;
  private treeCache: { at: number; ref: string; sha: string; entries: Map<string, TreeEntry> } | null = null;
  private readonly blobCache = new Map<string, string>();

  constructor(config: GithubConfig, transport: Transport = nodeTransport) {
    this.config = config;
    this.transport = transport;
    currentProxy = config.proxy;
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const res = await this.transport({
      method,
      url: `https://api.github.com${path}`,
      headers: { authorization: `Bearer ${this.config.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    let json: unknown = null;
    if (res.body) {
      try {
        json = JSON.parse(res.body) as unknown;
      } catch {
        json = { message: res.body.slice(0, 200) };
      }
    }

    if (res.status >= 200 && res.status < 300) return { status: res.status, json };

    const message =
      typeof json === "object" && json !== null && "message" in json
        ? String((json as { message: unknown }).message)
        : `HTTP ${res.status}`;

    if (res.status === 422) throw new GithubError(422, "unprocessable", message);
    if (res.status === 404) throw new GithubError(404, "not_found", message);
    if (res.status === 401 || res.status === 403) {
      throw new GithubError(res.status, "auth", `GitHub 鉴权失败：${message}`);
    }
    throw new GithubError(res.status, "http_error", `GitHub 返回 ${res.status}：${message}`);
  }

  /* ------------------------- 读 ------------------------- */

  async headSha(): Promise<string> {
    const { json } = await this.call("GET", `/repos/${this.config.repo}/git/ref/heads/${this.config.branch}`);
    const sha = (json as { object?: { sha?: string } } | null)?.object?.sha;
    if (!sha) throw new GithubError(0, "bad_response", "取不到分支 head");
    return sha;
  }

  async tree(ref?: string): Promise<{ sha: string; entries: Map<string, TreeEntry>; truncated: boolean }> {
    const target = ref ?? (await this.headSha());
    const now = Date.now();
    if (!ref && this.treeCache && this.treeCache.ref === target && now - this.treeCache.at < TREE_TTL_MS) {
      return { sha: this.treeCache.sha, entries: this.treeCache.entries, truncated: false };
    }
    const { json } = await this.call(
      "GET",
      `/repos/${this.config.repo}/git/trees/${target}?recursive=1`,
    );
    const data = json as { sha?: string; tree?: TreeEntry[]; truncated?: boolean } | null;
    const entries = new Map<string, TreeEntry>();
    for (const entry of data?.tree ?? []) {
      if (entry && typeof entry.path === "string") entries.set(entry.path, entry);
    }
    if (!ref) {
      this.treeCache = { at: now, ref: target, sha: data?.sha ?? target, entries };
    }
    return { sha: data?.sha ?? target, entries, truncated: Boolean(data?.truncated) };
  }

  invalidate(): void {
    this.treeCache = null;
  }

  async readFileAt(path: string, ref: string): Promise<GithubFile | null> {
    let status = 0;
    try {
      const { json } = await this.call(
        "GET",
        `/repos/${this.config.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      );
      const data = json as { content?: string; encoding?: string; sha?: string } | null;
      if (!data?.content) return null;
      const content = Buffer.from(data.content.replace(/\n/g, ""), "base64");
      return { path, content, text: content.toString("utf8") };
    } catch (err) {
      status = err instanceof GithubError ? err.status : 0;
      if (status === 404) return null;
      throw err;
    }
  }

  /** 按 tree 中的 blob sha 读文件；命中缓存则不再请求。 */
  async readBlob(sha: string): Promise<string> {
    const cached = this.blobCache.get(sha);
    if (cached !== undefined) return cached;
    const { json } = await this.call("GET", `/repos/${this.config.repo}/git/blobs/${sha}`);
    const data = json as { content?: string; encoding?: string } | null;
    const raw = data?.content ?? "";
    const text =
      data?.encoding === "base64" ? Buffer.from(raw.replace(/\n/g, ""), "base64").toString("utf8") : raw;
    if (this.blobCache.size > 512) this.blobCache.clear();
    this.blobCache.set(sha, text);
    return text;
  }

  async history(path: string, limit: number): Promise<CommitInfo[]> {
    const per = Math.max(1, Math.min(limit, 100));
    const { json } = await this.call(
      "GET",
      `/repos/${this.config.repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(
        this.config.branch,
      )}&per_page=${per}`,
    );
    const list = Array.isArray(json) ? (json as Array<Record<string, unknown>>) : [];
    return list.map((item) => {
      const commit = (item.commit ?? {}) as { message?: string; author?: { name?: string; date?: string } };
      return {
        sha: String(item.sha ?? ""),
        message: String(commit.message ?? "").split("\n")[0] ?? "",
        date: String(commit.author?.date ?? ""),
        author: String(commit.author?.name ?? ""),
      };
    });
  }

  /* ------------------------- 写 ------------------------- */

  async createBlob(content: Buffer): Promise<string> {
    const { json } = await this.call("POST", `/repos/${this.config.repo}/git/blobs`, {
      content: content.toString("base64"),
      encoding: "base64",
    });
    const sha = (json as { sha?: string } | null)?.sha;
    if (!sha) throw new GithubError(0, "bad_response", "创建 blob 失败");
    return sha;
  }

  async createTree(
    baseTree: string,
    entries: { path: string; sha: string; mode?: string; type?: string }[],
  ): Promise<string> {
    const { json } = await this.call("POST", `/repos/${this.config.repo}/git/trees`, {
      base_tree: baseTree,
      tree: entries.map((entry) => ({
        path: entry.path,
        mode: entry.mode ?? "100644",
        type: entry.type ?? "blob",
        sha: entry.sha,
      })),
    });
    const sha = (json as { sha?: string } | null)?.sha;
    if (!sha) throw new GithubError(0, "bad_response", "创建 tree 失败");
    return sha;
  }

  async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
    const { json } = await this.call("POST", `/repos/${this.config.repo}/git/commits`, {
      message,
      tree,
      parents,
    });
    const sha = (json as { sha?: string } | null)?.sha;
    if (!sha) throw new GithubError(0, "bad_response", "创建 commit 失败");
    return sha;
  }

  async updateRef(sha: string): Promise<void> {
    try {
      await this.call("PATCH", `/repos/${this.config.repo}/git/refs/heads/${this.config.branch}`, {
        sha,
        force: false,
      });
    } catch (err) {
      // 只有 ref 更新会被"快进"约束拒绝；其余 422 属于提交内容非法，不能当并发冲突重试。
      if (err instanceof GithubError && err.status === 422) {
        throw new RefMovedError(err.message);
      }
      throw err;
    }
  }
}

export function encodePath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
