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

export const GET: APIRoute = async ({ url, cookies }) => {
  const session = getSession(cookies);
  if (!session) return json({ ok: false, code: "unauthorized", message: "请先登录" }, 401);

  const path = url.searchParams.get("path");
  if (!path) return json({ ok: false, code: "invalid", message: "缺少 path" }, 400);

  const limitRaw = Number(url.searchParams.get("limit") ?? "10");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 50)) : 10;

  const history = await getStore().listHistory(path, limit);
  return json({ ok: true, history });
};
