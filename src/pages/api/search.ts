import type { APIRoute } from "astro";
import { searchPages } from "../../lib/search";
import { getStore } from "../../lib/storage";

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const hits = await searchPages(getStore(), url.searchParams.get("q") ?? "");
  return new Response(JSON.stringify({ ok: true, hits }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
};
