import type { APIRoute } from "astro";
import { clearCookie } from "../../lib/session";

export const prerender = false;

export const POST: APIRoute = async () => {
  const response = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": clearCookie(),
    },
  });
  response.headers.append("set-cookie", "wiki_hint=; Path=/; SameSite=Lax; Max-Age=0");
  return response;
};
