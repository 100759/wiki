import type { APIRoute } from "astro";
import { normalizeContentPath } from "../../lib/ids";
import { getSession } from "../../lib/session";
import { getStore } from "../../lib/storage";

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

interface Body {
  action?: unknown;
  path?: unknown;
  to?: unknown;
  title?: unknown;
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const actor = getSession(cookies);
  if (!actor) return json({ ok: false, code: "unauthorized", message: "请先登录" }, 401);
  if (actor.role === "viewer") {
    return json({ ok: false, code: "forbidden", message: "viewer 角色没有页面管理权限" }, 403);
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ ok: false, code: "invalid", message: "请求体不是合法 JSON" }, 400);
  }

  const store = getStore();
  const action = String(body.action ?? "");

  if (action === "create") {
    if (typeof body.path !== "string") return json({ ok: false, code: "invalid", message: "缺少 path" }, 400);
    let path: string;
    try {
      path = normalizeContentPath(body.path);
    } catch (err) {
      return json({ ok: false, code: "invalid", message: (err as Error).message }, 400);
    }
    const existing = await store.getPageByPath(path);
    if (existing) return json({ ok: false, code: "invalid", message: "该路径已存在" }, 409);
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "新页面";
    const result = await store.savePage({
      path,
      title,
      markdown: `# ${title}\n\n`,
      baseSha: null,
      images: [],
      actor,
    });
    return json(result, result.ok ? 200 : 400);
  }

  if (action === "rename") {
    if (typeof body.path !== "string" || typeof body.to !== "string") {
      return json({ ok: false, code: "invalid", message: "缺少 path / to" }, 400);
    }
    const result = await store.renamePage(body.path, body.to, actor);
    return json(result, result.ok ? 200 : result.code === "conflict" ? 409 : 400);
  }

  if (action === "delete") {
    if (typeof body.path !== "string") return json({ ok: false, code: "invalid", message: "缺少 path" }, 400);
    const result = await store.deletePage(body.path, actor);
    return json(result, result.ok ? 200 : result.code === "conflict" ? 409 : result.code === "forbidden" ? 403 : 400);
  }

  return json({ ok: false, code: "invalid", message: `未知操作：${action}` }, 400);
};
