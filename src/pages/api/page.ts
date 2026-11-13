import type { APIRoute } from "astro";
import { getStore } from "../../lib/storage";

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export const GET: APIRoute = async ({ url }) => {
  const store = getStore();
  const id = url.searchParams.get("id");
  const path = url.searchParams.get("path");

  const page = id ? await store.getPageById(id) : path ? await store.getPageByPath(path) : null;
  if (!page) {
    return json({ ok: false, code: "notfound", message: "页面不存在" }, 404);
  }
  return json({ ok: true, page });
};
