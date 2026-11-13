import type { APIRoute } from "astro";
import { getSession } from "../../lib/session";
import { getStore } from "../../lib/storage";

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const session = getSession(cookies);
  if (!session) return json({ ok: false, code: "unauthorized", message: "请先登录" }, 401);
  if (session.role === "viewer") {
    return json({ ok: false, code: "forbidden", message: "viewer 角色不能还原版本" }, 403);
  }

  let body: { path?: unknown; sha?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, code: "invalid", message: "请求体不是合法 JSON" }, 400);
  }
  if (typeof body.path !== "string" || typeof body.sha !== "string") {
    return json({ ok: false, code: "invalid", message: "path / sha 必填" }, 400);
  }

  try {
    // 还原按操作者身份判权：editor 不能借还原写 admin-only 页面。
    const result = await getStore().restore(body.path, body.sha, session);
    if (result.ok) return json(result, 200);
    const status = result.code === "conflict" ? 409 : result.code === "forbidden" ? 403 : 400;
    return json(result, status);
  } catch (err) {
    return json(
      { ok: false, code: "invalid", message: `还原失败：${(err as Error).message}` },
      400,
    );
  }
};
