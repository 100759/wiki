import { createHash } from "node:crypto";
import { GithubError, RefMovedError, type GithubClient, type TreeEntry } from "./github";

/* ------------------------------------------------------------------ *
 * 原子提交：一次 commit 写多个文件（正文 + 元数据 + 图片）
 *
 * 乐观锁按 v2 补充规则处理 422：
 *  1. ref 前进时 GitHub 返回 422，无法区分"别人改了同一页"还是"改了别的页"。
 *  2. 重取 head → 以新 head 重建 tree，只覆盖自己那几个文件 → 再 update ref，最多 3 次。
 *  3. 每次重试后比对目标文件 blob sha：
 *     - 仍等于 baseSha → 别人动的是别的文件，继续重试；
 *     - 已变成我们自己刚写入的 blob sha → 实际已成功，直接返回成功；
 *     - 变成其他值 → 真正的同页冲突。
 *
 * 共享文件（_system/meta.json）不能进 expected：两个编辑改不同页面都会重写它，
 * 按 sha 强校验会把"不同页并发"误判成冲突。这类文件用 content 函数在每次尝试时
 * 基于新 head 重新合并，谁后提交谁生效，正文仍各自严格校验。
 * ------------------------------------------------------------------ */

export interface AttemptContext {
  client: GithubClient;
  head: string;
  treeSha: string;
  entries: Map<string, TreeEntry>;
}

export interface FileChange {
  path: string;
  /** 固定内容，或每次尝试都基于新 head 重新计算的共享文件（如 meta）。 */
  content: string | Buffer | ((ctx: AttemptContext) => Promise<string | Buffer>);
}

export interface CommitPlan {
  message: string;
  files: FileChange[];
  /** 严格乐观锁：路径 → head 上应有的 blob sha；null 表示该文件不应存在。 */
  expected: Record<string, string | null>;
  maxRetries?: number;
}

export type CommitOutcome =
  | { ok: true; commit: string; blobs: Record<string, string> }
  | { ok: false; code: "conflict"; path: string };

function gitBlobSha(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.byteLength}\0`).update(content).digest("hex");
}

function toBuffer(content: string | Buffer): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : content;
}

export async function commitFiles(client: GithubClient, plan: CommitPlan): Promise<CommitOutcome> {
  const maxRetries = Math.max(1, Math.min(plan.maxRetries ?? 3, 5));

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    client.invalidate();
    const head = await client.headSha();
    const tree = await client.tree(head);
    const ctx: AttemptContext = { client, head, treeSha: tree.sha, entries: tree.entries };

    // 每次尝试都重新解析内容：共享文件要基于最新 head 合并。
    const resolved: { path: string; buffer: Buffer }[] = [];
    for (const file of plan.files) {
      const value = typeof file.content === "function" ? await file.content(ctx) : file.content;
      resolved.push({ path: file.path, buffer: toBuffer(value) });
    }
    const byPath = new Map(resolved.map((file) => [file.path, file.buffer]));

    for (const [path, want] of Object.entries(plan.expected)) {
      const actual = tree.entries.get(path)?.sha ?? null;
      if (actual === want) continue;
      const ours = byPath.get(path);
      // 上一次尝试其实已落地（响应丢失），或别人写了同一内容：按成功处理。
      // 注意 want 为 null（新建页）时同样成立，不能只在 want !== null 时判断。
      if (ours && gitBlobSha(ours) === actual) {
        const commits = await client.history(path, 1);
        // 回传真实 blob sha：savePage 会把它当作新基线，返回空串会让下次保存误判冲突。
        return { ok: true, commit: commits[0]?.sha ?? "", blobs: { [path]: actual } };
      }
      return { ok: false, code: "conflict", path };
    }

    const blobs: Record<string, string> = {};
    for (const file of resolved) {
      blobs[file.path] = await client.createBlob(file.buffer);
    }

    const treeSha = await client.createTree(
      tree.sha,
      resolved.map((file) => ({ path: file.path, sha: blobs[file.path] ?? "" })),
    );
    const commitSha = await client.createCommit(plan.message, treeSha, [head]);

    try {
      await client.updateRef(commitSha);
      client.invalidate();
      return { ok: true, commit: commitSha, blobs };
    } catch (err) {
      if (err instanceof RefMovedError) continue;
      if (err instanceof GithubError) throw err;
      throw err;
    }
  }

  return { ok: false, code: "conflict", path: plan.files[0]?.path ?? "" };
}
