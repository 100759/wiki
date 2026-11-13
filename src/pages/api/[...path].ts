import type { APIRoute } from "astro";
import { runProbe } from "../../lib/probe";

export const prerender = false;

/**
 * /api/_probe（U3 探针）。
 * Astro 不把 `_` 开头的页面文件当路由，因此本体放在这里：
 * 静态路由 /api/save、/api/page 优先匹配，其余 /api/* 落到本文件。
 */
export const GET: APIRoute = async ({ params }) => {
  if (params.path !== "_probe") {
    return new Response(JSON.stringify({ ok: false, code: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(JSON.stringify(await runProbe(), null, 2), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
};
