import { timingSafeEqual } from "node:crypto";
import type { APIRoute } from "astro";
import { runProbe } from "../../lib/probe";

export const prerender = false;

/**
 * /api/_probe（U3 探针）。
 *
 * 安全边界：这是个能触发存储写入的诊断端点，不能公开。
 *  - 没配 PROBE_TOKEN → 一律 404，不暴露存在性
 *  - 配了 → 必须带 ?token=<PROBE_TOKEN>，否则 401
 *  - 只有再带 &write=1 才真的写读一个键（每次会留一个 key），默认只探测 import 与 getStore
 *
 * Astro 不把 `_` 开头的页面文件当路由，因此本体放在这里：
 * 静态路由 /api/save、/api/page 优先匹配，其余 /api/* 落到本文件。
 */

function timingSafeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export const GET: APIRoute = async ({ params, url }) => {
  const notFound = (): Response =>
    new Response(JSON.stringify({ ok: false, code: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });

  if (params.path !== "_probe") return notFound();

  const expected = (process.env.PROBE_TOKEN ?? "").trim();
  if (!expected) return notFound();

  const given = url.searchParams.get("token") ?? "";
  if (!given || !timingSafeEqualText(given, expected)) {
    return new Response(JSON.stringify({ ok: false, code: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const write = url.searchParams.get("write") === "1";
  return new Response(JSON.stringify(await runProbe({ write }), null, 2), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
};
