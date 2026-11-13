import { GithubError, RefMovedError, type GithubClient } from "./github";

/* ------------------------------------------------------------------ *
 * 原子提交：一次 commit 写多个文件（正文 + 元数据 + 图片）
 *
 * 乐观锁按 v2 补充规则处理 422：
 *  1. ref 前进时 GitHub 返回 422，无法区分"别人改了同一页"还是"改了别的页"。
 *  2. 重取 head → 以新 head 重建 tree，只覆盖自己那几个文件 → 再 update ref，最多 3 次。
 *  3. 每次重试后比对目标文件 blob sha：仍等于 baseSha → 说明别人动的是别的文件，继续重试；
 *     已变成我们自己刚写入的 blob sha → 实际已成功，直接返回成功；
 *     变成其他值 → 真正的同页冲突。
 * ------------------------------------------------------------------ */

export interface FileChange {
  path: string;
  content: string | Buffer;
}

export interface CommitPlan {
  message: string;
  files: FileChange[];
  /** 乐观锁基线：路径 → head 上应有的 blob sha；null 表示该文件不应存在。 */
  expected: Record<string, string | null>;
  maxRetries?: number;
}

export type CommitOutcome =
  | { ok: true; commit: string; blobs: Record<string, string> }
  | { ok: false; code: "conflict"; path: string };

export async function commitFiles(client: GithubClient, plan: CommitPlan): Promise<CommitOutcome> {
  const maxRetries = Math.max(1, Math.min(plan.maxRetries ?? 3, 5));

  // blob 只创建一次，重试时复用。
  const blobs: Record<string, string> = {};
  for (const file of plan.files) {
    const buffer = typeof file.content === "string" ? Buffer.from(file.content, "utf8") : file.content;
    blobs[file.path] = await client.createBlob(buffer);
  }

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    client.invalidate();
    const head = await client.headSha();
    const tree = await client.tree(head);

    for (const [path, want] of Object.entries(plan.expected)) {
      const actual = tree.entries.get(path)?.sha ?? null;
      if (actual === want) continue;
      // 上一次尝试其实已落地（响应丢失），或别人写了同一内容。
      if (want !== null && actual !== null && blobs[path] === actual) {
        const commits = await client.history(path, 1);
        return { ok: true, commit: commits[0]?.sha ?? "", blobs };
      }
      return { ok: false, code: "conflict", path };
    }

    const treeSha = await client.createTree(
      tree.sha,
      plan.files.map((file) => ({ path: file.path, sha: blobs[file.path] ?? "" })),
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
