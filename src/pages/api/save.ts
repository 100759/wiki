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

interface SaveBody {
  path?: unknown;
  title?: unknown;
  markdown?: unknown;
  baseSha?: unknown;
  images?: unknown;
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const actor = getSession(cookies);

  // F 验收：没有有效签名会话一律 401，不接受任何可伪造的角色 Cookie。
  if (!actor) {
    return json({ ok: false, code: "unauthorized", message: "请先登录" }, 401);
  }

  // D 验收：viewer 一律 forbidden。
  if (actor.role === "viewer") {
    return json({ ok: false, code: "forbidden", message: "viewer 角色没有保存权限" }, 403);
  }

  let body: SaveBody;
  try {
    body = (await request.json()) as SaveBody;
  } catch {
    return json({ ok: false, code: "invalid", message: "请求体不是合法 JSON" }, 400);
  }

  if (typeof body.path !== "string" || typeof body.title !== "string" || typeof body.markdown !== "string") {
    return json({ ok: false, code: "invalid", message: "path / title / markdown 必填" }, 400);
  }
  if (body.baseSha !== null && typeof body.baseSha !== "string") {
    return json({ ok: false, code: "invalid", message: "baseSha 必须是字符串或 null" }, 400);
  }

  // 图片已改为独立上传（/api/upload，原始二进制）。这里显式拒绝，避免旧客户端
  // 继续把 base64 塞进来撞 1MB 请求体上限。
  if (body.images !== undefined) {
    return json(
      { ok: false, code: "invalid", message: "图片请走 /api/upload 单独上传，保存请求不再接收图片" },
      400,
    );
  }

  const result = await getStore().savePage({
    path: body.path,
    title: body.title,
    markdown: body.markdown,
    baseSha: body.baseSha,
    images: [],
    actor,
  });

  if (result.ok) return json(result, 200);
  const status = result.code === "conflict" ? 409 : result.code === "forbidden" ? 403 : 400;
  return json(result, status);
};
