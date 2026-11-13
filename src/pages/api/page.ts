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
  const store = getStore();
  const id = url.searchParams.get("id");
  const path = url.searchParams.get("path");

  const page = id ? await store.getPageById(id) : path ? await store.getPageByPath(path) : null;
  if (!page) {
    return json({ ok: false, code: "notfound", message: "页面不存在" }, 404);
  }
  // 匿名请求不返回 ACL 名单：站点公开时这属于内部信息。
  const session = getSession(cookies);
  if (!session) {
    const { acl: _acl, ...rest } = page;
    return json({ ok: true, page: rest });
  }
  return json({ ok: true, page });
};
